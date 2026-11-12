import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { invokeFunction } from '../lib/api'
import { loadHolidays } from '../lib/holidays'
import { Button, Card, Chip, Dialog, EmptyState, PageHeader, Select, Skeleton, TextField } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'
import './AdminPanel.css'
import './HolidayManagement.css'

/**
 * 國定假日（管理後台）。使用者 2026-11 決定：
 *   · 依人事行政總處的辦公日曆；公司不補班，所以只記週一～週五的放假日（含調整放假）
 *   · 管理員與 HR 都能「匯入」；新增、改名稱、刪除只有 HR
 *   · 匯入不會動到已經有的日期：HR 改過的名稱、刪掉的日子都保留 HR 的版本
 *     （刪除＝留一列 is_holiday = false 當記號，自動匯入才不會加回來）
 *
 * 匯入走 Edge Function import-holidays（政府網站瀏覽器直接連不到，而且管理員沒有寫入權限）。
 * 政府網站抓不到時，可以自己到 data.gov.tw 下載 CSV 上傳，同一支 function 解析。
 */

function taipeiYear() {
  return Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4))
}

function toBase64(buffer) {
  let s = ''
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function HolidayManagement({ userProfile }) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const canEdit = !!userProfile?.is_finance
  const thisYear = taipeiYear()

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [year, setYear] = useState(thisYear)
  const [adding, setAdding] = useState(null)        // { date, name }
  const [editing, setEditing] = useState(null)      // { date, name }
  const [saving, setSaving] = useState(false)
  const [importYear, setImportYear] = useState(thisYear + 1)
  const [preview, setPreview] = useState(null)      // { year, source, days, csv_base64? }
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  const queryRows = () => supabase.from('holidays').select('*').order('date')
  function applyRows({ data, error }) {
    if (error) showToast(t('holiday_err_fetch', { msg: error.message }), { tone: 'error' })
    setRows(data || [])
    setLoading(false)
  }
  async function fetchRows() { applyRows(await queryRows()) }
  useEffect(() => {
    let cancelled = false
    queryRows().then(res => { if (!cancelled) applyRows(res) })
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 改完之後讓全站重新讀一次假日（算請假天數用的那份）
  async function refresh() {
    await Promise.all([fetchRows(), loadHolidays({ force: true })])
  }

  const years = useMemo(() => {
    const ys = new Set([thisYear, thisYear + 1, ...rows.map(r => Number(r.date.slice(0, 4)))])
    return [...ys].sort((a, b) => b - a)
  }, [rows, thisYear])
  const shown = rows.filter(r => r.date.startsWith(`${year}-`))
  const activeCount = shown.filter(r => r.is_holiday).length

  const weekday = date => t(`weekday_short_${new Date(`${date}T00:00:00Z`).getUTCDay()}`)

  // ── HR：新增／改名／刪除／恢復 ──
  async function write(op, okKey) {
    setSaving(true)
    const { data, error } = await op
    setSaving(false)
    // 權限規則擋下時 Postgres 不報錯、只回 0 列，所以 0 列也算失敗
    if (error || !data?.length) {
      showToast(t('holiday_err_save', { msg: error?.message || t('admin_no_write_permission') }), { tone: 'error' })
      return false
    }
    showToast(t(okKey))
    await refresh()
    return true
  }

  async function handleAdd() {
    if (!adding?.date || !adding.name.trim()) { showToast(t('holiday_err_required'), { tone: 'error' }); return }
    const dow = new Date(`${adding.date}T00:00:00Z`).getUTCDay()
    if (dow === 0 || dow === 6) { showToast(t('holiday_err_weekend'), { tone: 'error' }); return }
    const ok = await write(supabase.from('holidays').upsert({
      date: adding.date, name: adding.name.trim(), is_holiday: true, source: 'manual',
      updated_by: userProfile.id, updated_at: new Date().toISOString(),
    }, { onConflict: 'date' }).select(), 'holiday_added')
    if (ok) { setYear(Number(adding.date.slice(0, 4))); setAdding(null) }
  }

  async function handleRename() {
    if (!editing.name.trim()) { showToast(t('holiday_err_required'), { tone: 'error' }); return }
    const ok = await write(supabase.from('holidays')
      .update({ name: editing.name.trim(), updated_by: userProfile.id, updated_at: new Date().toISOString() })
      .eq('date', editing.date).select(), 'holiday_saved')
    if (ok) setEditing(null)
  }

  function setActive(r, isHoliday) {
    return write(supabase.from('holidays')
      .update({ is_holiday: isHoliday, updated_by: userProfile.id, updated_at: new Date().toISOString() })
      .eq('date', r.date).select(), isHoliday ? 'holiday_restored' : 'holiday_removed')
  }

  // ── 管理員與 HR：匯入 ──
  async function runPreview(csvBase64) {
    setBusy(true)
    const { data, error } = await invokeFunction('import-holidays', {
      action: 'preview', year: importYear, ...(csvBase64 ? { csv_base64: csvBase64 } : {}),
    })
    setBusy(false)
    if (error || !data?.ok) { showToast(importError(data, error), { tone: 'error' }); return }
    setPreview({ ...data, csv_base64: csvBase64 })
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    runPreview(toBase64(await file.arrayBuffer()))
  }

  async function runImport() {
    setBusy(true)
    const { data, error } = await invokeFunction('import-holidays', {
      action: 'import', year: preview.year, ...(preview.csv_base64 ? { csv_base64: preview.csv_base64 } : {}),
    })
    setBusy(false)
    if (error || !data?.ok) { showToast(importError(data, error), { tone: 'error' }); return }
    showToast(t('holiday_imported', { year: data.year, n: data.inserted }))
    setPreview(null)
    setYear(data.year)
    await refresh()
  }

  function importError(data, error) {
    const code = data?.code
    if (code === 'not_published') return t('holiday_err_not_published', { year: importYear })
    if (code === 'fetch_failed') return t('holiday_err_fetch_failed')
    if (code === 'bad_file') return t('holiday_err_bad_file', { msg: data?.message || '' })
    if (code === 'not_allowed') return t('admin_no_write_permission')
    return t('holiday_err_import', { msg: data?.message || code || error?.message || '' })
  }

  const statusChip = s => s === 'new'
    ? <Chip tone="success">{t('holiday_status_new')}</Chip>
    : s === 'exists' ? <Chip>{t('holiday_status_exists')}</Chip> : <Chip tone="warning">{t('holiday_status_removed')}</Chip>

  return (
    <div>
      <PageHeader
        title={t('holiday_title')}
        actions={canEdit && <Button size="sm" onClick={() => setAdding({ date: '', name: '' })}>{t('holiday_add')}</Button>}
      />
      <p className="admin-hint">{t('holiday_hint')}</p>

      {/* 匯入：管理員與 HR */}
      <Card className="admin-form-card">
        <h4 className="admin-form-card__title">{t('holiday_import_title')}</h4>
        <p className="admin-form-card__hint">{t('holiday_import_hint')}</p>
        <div className="admin-inline-form hol-row">
          <Select value={importYear} onChange={e => setImportYear(Number(e.target.value))} style={{ maxWidth: '140px' }} aria-label={t('holiday_import_year')}>
            {[thisYear, thisYear + 1].map(y => <option key={y} value={y}>{y}</option>)}
          </Select>
          <Button loading={busy && !preview} onClick={() => runPreview(null)}>{t('holiday_import_fetch')}</Button>
          <Button variant="outlined" disabled={busy} onClick={() => fileRef.current?.click()}>{t('holiday_import_upload')}</Button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={handleFile} />
        </div>
      </Card>

      {/* 列表 */}
      <div className="admin-inline-form hol-row">
        <Select value={year} onChange={e => setYear(Number(e.target.value))} style={{ maxWidth: '140px' }} aria-label={t('holiday_year')}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </Select>
        <span className="admin-hint">{t('holiday_count', { year, n: activeCount })}</span>
      </div>

      {loading ? <Skeleton height="200px" /> : shown.length === 0 ? (
        <Card><EmptyState title={t('holiday_empty', { year })} /></Card>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr>
                <th>{t('holiday_col_date')}</th><th>{t('holiday_col_name')}</th><th className="hol-col-source">{t('holiday_col_source')}</th>
                {canEdit && <th>{t('common_actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.date} style={{ opacity: r.is_holiday ? 1 : 0.55 }}>
                  <td className="tabular hol-date">{r.date.slice(5).replace('-', '/')}（{weekday(r.date)}）</td>
                  <td>
                    {r.name || '—'}
                    {!r.is_holiday && <> <Chip tone="error">{t('holiday_removed_chip')}</Chip></>}
                  </td>
                  <td className="hol-col-source">{r.source === 'dgpa' ? t('holiday_source_dgpa') : t('holiday_source_manual')}</td>
                  {canEdit && (
                    <td className="admin-cell-actions hol-actions">
                      {r.is_holiday ? (
                        <>
                          <Button size="sm" variant="outlined" onClick={() => setEditing({ date: r.date, name: r.name })}>{t('common_edit')}</Button>{' '}
                          <Button size="sm" variant="danger-outlined" disabled={saving} onClick={() => setActive(r, false)}>{t('holiday_remove')}</Button>
                        </>
                      ) : (
                        <Button size="sm" variant="outlined" disabled={saving} onClick={() => setActive(r, true)}>{t('holiday_restore')}</Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <Dialog title={t('holiday_add')} labelledBy="holiday-add-title" onClose={() => setAdding(null)}
          actions={<>
            <Button variant="text" onClick={() => setAdding(null)}>{t('common_cancel')}</Button>
            <Button loading={saving} onClick={handleAdd}>{t('common_save')}</Button>
          </>}>
          <div className="admin-form-grid">
            <TextField label={t('holiday_col_date')} type="date" required value={adding.date} onChange={e => setAdding(p => ({ ...p, date: e.target.value }))} />
            <TextField label={t('holiday_col_name')} required value={adding.name} onChange={e => setAdding(p => ({ ...p, name: e.target.value }))} />
          </div>
          <p className="admin-form-card__hint">{t('holiday_add_hint')}</p>
        </Dialog>
      )}

      {editing && (
        <Dialog title={t('holiday_edit_title', { date: editing.date })} labelledBy="holiday-edit-title" onClose={() => setEditing(null)}
          actions={<>
            <Button variant="text" onClick={() => setEditing(null)}>{t('common_cancel')}</Button>
            <Button loading={saving} onClick={handleRename}>{t('common_save')}</Button>
          </>}>
          <TextField label={t('holiday_col_name')} required value={editing.name} onChange={e => setEditing(p => ({ ...p, name: e.target.value }))} />
        </Dialog>
      )}

      {preview && (
        <Dialog title={t('holiday_preview_title', { year: preview.year })} labelledBy="holiday-preview-title" onClose={() => setPreview(null)}
          actions={<>
            <Button variant="text" onClick={() => setPreview(null)}>{t('common_cancel')}</Button>
            <Button loading={busy} disabled={!preview.days.some(d => d.status === 'new')} onClick={runImport}>
              {t('holiday_preview_confirm', { n: preview.days.filter(d => d.status === 'new').length })}
            </Button>
          </>}>
          <p className="admin-form-card__hint">
            {preview.source === 'upload' ? t('holiday_preview_from_upload') : t('holiday_preview_from_dgpa')}
            {' '}{t('holiday_preview_rule')}
          </p>
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead><tr><th>{t('holiday_col_date')}</th><th>{t('holiday_col_name')}</th><th>{t('holiday_col_status')}</th></tr></thead>
              <tbody>
                {preview.days.map(d => (
                  <tr key={d.date}>
                    <td className="tabular hol-date">{d.date.slice(5).replace('-', '/')}（{weekday(d.date)}）</td>
                    <td>{d.name || '—'}</td>
                    <td>{statusChip(d.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Dialog>
      )}
    </div>
  )
}

export default HolidayManagement
