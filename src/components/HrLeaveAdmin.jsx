import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Chip, ConfirmDialog, Dialog, EmptyState, Select, Skeleton, Textarea } from './ui'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'
import { calcHours, countWorkdays, leaveTypeName } from '../lib/leaveEntitlements'

/**
 * HR 的假單管理：修改與刪除。
 *
 *
 * 為什麼會有這個畫面
 *
 * 同仁可以對 HR 代登記的假單「提出修改異議」，系統也會通知登記的那位 HR。
 * 但在這之前，HR 收到通知後系統裡沒有任何地方可以把那張假單改掉或刪掉 ——
 * 話傳到了，接到話的人卻沒有工具。這個畫面補上那一半。
 *
 *
 * 權限（2026-09 與使用者確認，刻意分成兩種）
 *
 *   代登記的假單    只有「當初登記的那位 HR」能動
 *   同仁自己送的    全體 HR 都能動
 *
 * 代登記是有主的 —— 誰登的誰負責，異議通知也只發給他，責任線一致。同仁自己
 * 送的假單沒有「登記者」這個概念，套同一條規則的話會變成誰都不能動。
 *
 * ⚠️ 這裡的判斷只是「把按不到的按鈕藏起來」，真正的把關在資料庫的 RLS
 * （migration 20260929_finance_can_edit_delete_leave）。前端的判斷永遠只是
 * 體驗，不是安全。
 */

const TIME_OPTIONS = []
for (let h = 8; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 18 && m > 30) break
    TIME_OPTIONS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  }
}

const PAGE_SIZE = 10

const SELECT = `
  id, start_date, end_date, start_time, end_time, hours, reason, status,
  registered_by, acknowledged_at, auto_acknowledged, disputed_at, dispute_reason, ack_deadline,
  requester:users!leave_requests_requester_id_fkey(id, full_name),
  registrar:users!leave_requests_registered_by_fkey(full_name),
  leave_type:leave_types(id, name, name_en, color)
`

function HrLeaveAdmin({ hrUser }) {
  const { t, lang } = useLanguage()
  const { showToast } = useToast()

  const [rows, setRows] = useState([])
  const [leaveTypes, setLeaveTypes] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  // 預設只看有異議的 —— HR 會來這個畫面，九成是因為收到異議通知。
  const [onlyDisputed, setOnlyDisputed] = useState(true)

  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [deletingBusy, setDeletingBusy] = useState(false)

  // 重新抓資料：改動 onlyDisputed，或存檔／刪除後 bump 這個數字。
  const [reloadTick, setReloadTick] = useState(0)
  const reload = () => setReloadTick(n => n + 1)

  useEffect(() => {
    // cancelled 是給「切換篩選時舊查詢比新查詢晚回來」用的 —— 沒有它的話，
    // 舊結果會把新結果蓋掉，畫面顯示的東西跟勾選狀態對不起來。
    let cancelled = false
    ;(async () => {
      let q = supabase.from('leave_requests').select(SELECT)
        .order('start_date', { ascending: false }).limit(300)
      if (onlyDisputed) q = q.not('disputed_at', 'is', null).is('acknowledged_at', null)
      const { data, error } = await q
      if (cancelled) return
      if (error) showToast(t('hradmin_err_fetch', { msg: error.message }), { tone: 'error' })
      setRows(data || [])
      setLoading(false)
      setPage(1)
    })()
    return () => { cancelled = true }
    // showToast 與 t 每次 render 都是新的，放進相依會無限重抓
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyDisputed, reloadTick])

  useEffect(() => {
    supabase.from('leave_types').select('*').eq('is_active', true).order('name')
      .then(({ data }) => setLeaveTypes(data || []))
  }, [])

  /** 跟資料庫的 RLS 同一條規則。改這裡的話那支 migration 也要改。 */
  const canManage = leave => !leave.registered_by || leave.registered_by === hrUser.id

  function openEdit(leave) {
    setEditing(leave)
    setForm({
      leave_type_id: leave.leave_type?.id || '',
      start_date: leave.start_date || '',
      end_date: leave.end_date || '',
      start_time: (leave.start_time || '09:00').slice(0, 5),
      end_time: (leave.end_time || '18:00').slice(0, 5),
      reason: leave.reason || '',
    })
  }

  async function handleSave() {
    if (!form.leave_type_id || !form.start_date || !form.end_date || !form.reason.trim()) {
      showToast(t('leaveform_err_required'), { tone: 'error' }); return
    }
    if (form.end_date < form.start_date) {
      showToast(t('leaveform_err_date_order'), { tone: 'error' }); return
    }
    const multiDay = form.end_date > form.start_date
    if (!multiDay && form.end_time <= form.start_time) {
      showToast(t('leaveform_time_order_error'), { tone: 'error' }); return
    }
    const hours = multiDay ? null : calcHours(form.start_time, form.end_time)
    if (!multiDay && hours === 0) {
      showToast(t('leaveform_err_zero_hours'), { tone: 'error' }); return
    }

    setSaving(true)

    const patch = {
      leave_type_id: form.leave_type_id,
      start_date: form.start_date,
      end_date: form.end_date,
      start_time: multiDay ? '09:00' : form.start_time,
      end_time: multiDay ? '18:00' : form.end_time,
      hours,
      reason: form.reason.trim(),
    }

    // 改的是「代登記、而且同仁提過異議」的假單時，要重新請他確認一次 ——
    // 他當初的異議是針對舊內容，內容改了之後那個表態就不適用了。把確認狀態
    // 整個歸零並重新給 3 天，同仁會再收到一次確認通知。
    const needsReconfirm = !!editing.registered_by && !!editing.disputed_at
    if (needsReconfirm) {
      const deadline = new Date()
      deadline.setDate(deadline.getDate() + 3)
      patch.disputed_at = null
      patch.dispute_reason = null
      patch.acknowledged_at = null
      patch.auto_acknowledged = false
      patch.ack_deadline = deadline.toISOString()
    }

    const { data, error } = await supabase
      .from('leave_requests').update(patch).eq('id', editing.id).select()

    // RLS 擋下 UPDATE 時 Postgres 不會報錯，只會回 0 列 —— 0 列也算失敗，
    // 否則會出現「顯示已儲存、實際上什麼都沒寫進去」。
    if (error || !data?.length) {
      showToast(t('hradmin_err_save', { msg: error?.message || t('admin_no_write_permission') }), { tone: 'error' })
      setSaving(false)
      return
    }

    // 通知失敗不該讓修改失敗 —— 資料已經改好了，那才是重點。
    if (needsReconfirm) {
      await supabase.functions.invoke('send-slack-notification', {
        body: { type: 'hr_registered', request_id: editing.id },
      })
    }

    setSaving(false)
    setEditing(null)
    setForm(null)
    showToast(needsReconfirm ? t('hradmin_saved_reconfirm') : t('hradmin_saved'))
    reload()
  }

  async function handleDelete() {
    setDeletingBusy(true)
    const { data, error } = await supabase
      .from('leave_requests').delete().eq('id', deleting.id).select()

    if (error || !data?.length) {
      showToast(t('hradmin_err_delete', { msg: error?.message || t('admin_no_write_permission') }), { tone: 'error' })
      setDeletingBusy(false)
      return
    }
    setDeletingBusy(false)
    setDeleting(null)
    showToast(t('hradmin_deleted'))
    reload()
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const multiDayEdit = form && form.end_date > form.start_date

  return (
    <>
      <p className="admin-form-card__hint">{t('hradmin_hint')}</p>

      <div className="leave-mgmt-filters">
        <label className="ui-checkbox">
          <input type="checkbox" checked={onlyDisputed}
            onChange={e => { setLoading(true); setOnlyDisputed(e.target.checked) }} />
          <span>{t('hradmin_only_disputed')}</span>
        </label>
      </div>

      {loading ? <Skeleton height="120px" /> : rows.length === 0 ? (
        <EmptyState title={onlyDisputed ? t('hradmin_empty_disputed') : t('hradmin_empty')} />
      ) : (
        <>
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>{t('field_requester')}</th>
                  <th>{t('field_leave_type')}</th>
                  <th>{t('field_leave_dates')}</th>
                  <th>{t('field_hours')}</th>
                  <th>{t('field_approval_status')}</th>
                  <th>{t('hradmin_col_source')}</th>
                  <th>{t('common_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(l => {
                  const multi = l.end_date > l.start_date
                  const mine = canManage(l)
                  return (
                    <tr key={l.id}>
                      <td>{l.requester?.full_name || '—'}</td>
                      <td>{leaveTypeName(l.leave_type, lang)}</td>
                      <td>
                        {multi ? `${l.start_date} ~ ${l.end_date}` : l.start_date}
                        {!multi && l.start_time && l.end_time && (
                          <div className="admin-row__meta">{l.start_time.slice(0, 5)} ~ {l.end_time.slice(0, 5)}</div>
                        )}
                      </td>
                      <td>{l.hours != null ? t('common_hours', { n: l.hours }) : t('common_days', { n: countWorkdays(l.start_date, l.end_date) })}</td>
                      <td>
                        <Chip tone="neutral">{t(`status_${l.status}`)}</Chip>
                        {l.disputed_at && !l.acknowledged_at && (
                          <> <Chip tone="error">{t('hrreg_disputed')}</Chip></>
                        )}
                      </td>
                      <td>
                        {l.registered_by
                          ? <span className="admin-row__meta">{t('hradmin_by_hr', { name: l.registrar?.full_name || '—' })}</span>
                          : <span className="admin-row__meta">{t('hradmin_self_filed')}</span>}
                      </td>
                      <td className="admin-cell-actions">
                        {mine ? (
                          <>
                            <Button size="sm" variant="outlined" onClick={() => openEdit(l)}>{t('common_edit')}</Button>
                            <Button size="sm" variant="danger-outlined" onClick={() => setDeleting(l)}>{t('common_delete')}</Button>
                          </>
                        ) : (
                          <span className="admin-row__meta">{t('hradmin_not_yours')}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* 異議內容太長，塞在表格裡會把版面撐爛，所以獨立列在下面 */}
          {pageRows.some(l => l.disputed_at && !l.acknowledged_at) && (
            <div className="admin-form-card__group">
              <div className="admin-row__meta">{t('hradmin_disputes_title')}</div>
              {pageRows.filter(l => l.disputed_at && !l.acknowledged_at).map(l => (
                <p key={l.id} className="admin-form-card__hint">
                  <strong>{l.requester?.full_name}</strong>（{l.start_date}）：{l.dispute_reason}
                </p>
              ))}
            </div>
          )}

          <div className="leave-mgmt-pagination">
            <Button size="sm" variant="outlined" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('common_prev_page')}</Button>
            <span className="leave-mgmt-pagination__label">{t('common_page_indicator', { page, total: totalPages })}</span>
            <Button size="sm" variant="outlined" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>{t('common_next_page')}</Button>
          </div>
        </>
      )}

      {editing && form && (
        <Dialog
          title={t('hradmin_edit_title', { name: editing.requester?.full_name || '' })}
          labelledBy="hr-leave-edit-title"
          onClose={() => { setEditing(null); setForm(null) }}
          actions={(
            <>
              <Button variant="text" onClick={() => { setEditing(null); setForm(null) }}>{t('common_cancel')}</Button>
              <Button loading={saving} onClick={handleSave}>{t('common_save')}</Button>
            </>
          )}
        >
          {editing.registered_by && editing.disputed_at && (
            <p className="admin-form-card__hint">{t('hradmin_edit_reconfirm_hint')}</p>
          )}

          <div className="admin-form-grid">
            <Select
              label={t('field_leave_type')} required
              value={form.leave_type_id}
              onChange={e => setForm(p => ({ ...p, leave_type_id: e.target.value }))}
            >
              <option value="">{t('leaveform_select_type')}</option>
              {leaveTypes.map(lt => <option key={lt.id} value={lt.id}>{leaveTypeName(lt, lang)}</option>)}
            </Select>

            <label className="ui-field">
              <span className="ui-field__label">{t('hrreg_start_date')} *</span>
              <input className="ui-field__control" type="date" value={form.start_date}
                onChange={e => setForm(p => ({ ...p, start_date: e.target.value, end_date: p.end_date || e.target.value }))} />
            </label>

            <label className="ui-field">
              <span className="ui-field__label">{t('hrreg_end_date')} *</span>
              <input className="ui-field__control" type="date" value={form.end_date}
                onChange={e => setForm(p => ({ ...p, end_date: e.target.value }))} />
            </label>

            {!multiDayEdit && (
              <>
                <Select label={t('leaveform_start')} value={form.start_time}
                  onChange={e => setForm(p => ({ ...p, start_time: e.target.value }))}>
                  {TIME_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
                </Select>
                <Select label={t('leaveform_end')} value={form.end_time}
                  onChange={e => setForm(p => ({ ...p, end_time: e.target.value }))}>
                  {TIME_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
                </Select>
              </>
            )}
          </div>

          <p className="admin-form-card__hint">
            {multiDayEdit
              ? t('hrreg_multiday_hint', { n: countWorkdays(form.start_date, form.end_date) })
              : t('leaveform_hours_note', { n: calcHours(form.start_time, form.end_time) })}
          </p>

          <Textarea
            label={t('field_reason')} required rows={3} value={form.reason}
            onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
          />
        </Dialog>
      )}

      {deleting && (
        <ConfirmDialog
          title={t('hradmin_delete_title')}
          description={t('hradmin_delete_desc', {
            name: deleting.requester?.full_name || '',
            date: deleting.start_date,
            type: leaveTypeName(deleting.leave_type, lang),
          })}
          confirmLabel={t('common_delete')}
          danger
          loading={deletingBusy}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
}

export default HrLeaveAdmin
