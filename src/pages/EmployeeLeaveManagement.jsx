import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, Chip, Dialog, PageHeader, Select, Skeleton, TextField } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'
import { HOURS_PER_DAY, isAnnualLeaveType, leaveTypeName } from '../lib/leaveEntitlements'
import LeaveTypeNames from './LeaveTypeNames'
import './AdminPanel.css'

function formatTenure(hireDate, t) {
  if (!hireDate) return '—'
  const start = new Date(hireDate)
  const now = new Date()
  let years = now.getFullYear() - start.getFullYear()
  let months = now.getMonth() - start.getMonth()
  if (now.getDate() < start.getDate()) months -= 1
  if (months < 0) { years -= 1; months += 12 }
  if (years < 0) return '—'
  return t('finleave_tenure', { y: years, m: months })
}

// 特休 is talked about in days (labour law), everything else in hours --
// but both are stored as hours. These convert only at the UI edge.
function toDisplay(hours, annual) {
  if (hours == null || hours === '') return ''
  return String(annual ? Number(hours) / HOURS_PER_DAY : Number(hours))
}
function toHours(value, annual) {
  if (value === '' || value == null) return null
  const n = Number(value)
  if (Number.isNaN(n)) return null
  return annual ? n * HOURS_PER_DAY : n
}

// ===== 員工假期管理（HR 專用）=====
function EmployeeLeaveManagement({ userProfile }) {
  const [users, setUsers] = useState([])
  const [leaveTypes, setLeaveTypes] = useState([])
  const [entitlements, setEntitlements] = useState([])
  const [annualSummary, setAnnualSummary] = useState({})
  const [loading, setLoading] = useState(true)
  const [filterDept, setFilterDept] = useState('')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [defaults, setDefaults] = useState({})
  const [savingDefaults, setSavingDefaults] = useState(false)
  const [filterStatus, setFilterStatus] = useState('')

  // 表格內直接編輯：drafts 是畫面上的值（打字要立刻反應），rowStatus 是每一列
  // 的儲存狀態。實際寫入延遲 700ms，避免每按一個鍵就打一次資料庫。
  const [drafts, setDrafts] = useState({})
  const [rowStatus, setRowStatus] = useState({})
  const saveTimers = useRef({})

  // 批次套用
  const [selected, setSelected] = useState([])
  const [bulkTypeId, setBulkTypeId] = useState('')
  const [bulkMode, setBulkMode] = useState('manual')
  const [bulkValue, setBulkValue] = useState('')
  const [bulkSaving, setBulkSaving] = useState(false)

  const { showToast } = useToast()
  const { t, lang } = useLanguage()

  useEffect(() => { fetchAll() }, [])

  // 離開頁面時把還沒觸發的存檔計時器清掉，避免元件卸載後才寫入
  useEffect(() => () => {
    for (const t of Object.values(saveTimers.current)) clearTimeout(t)
  }, [])

  async function fetchAll() {
    const [u, lt, ent, summary] = await Promise.all([
      supabase.from('users').select('id, full_name, department, job_title, hire_date, is_active').eq('is_active', true).order('full_name'),
      supabase.from('leave_types').select('*').order('name'),
      supabase.from('user_leave_entitlements').select('*'),
      supabase.from('annual_leave_summary').select('*'),
    ])
    setUsers(u.data || [])
    setLeaveTypes(lt.data || [])
    setEntitlements(ent.data || [])
    setAnnualSummary(Object.fromEntries((summary.data || []).map(s => [s.user_id, s])))
    setDefaults(Object.fromEntries((lt.data || []).map(row => [row.id, row.annual_quota_hours != null ? String(row.annual_quota_hours) : ''])))
    setLoading(false)
  }

  async function handleSaveDefaults() {
    setSavingDefaults(true)
    // 迴圈變數刻意不叫 t —— 那會遮蔽翻譯用的 t()
    for (const lt of leaveTypes) {
      if (isAnnualLeaveType(lt)) continue // 特休 comes from the seniority formula, not a flat default
      const raw = defaults[lt.id]
      const value = raw === '' ? null : Number(raw)
      if (value !== null && (Number.isNaN(value) || value < 0)) {
        showToast(t('finleave_err_number', { name: leaveTypeName(lt, lang) }), { tone: 'error' })
        setSavingDefaults(false)
        return
      }
      if ((lt.annual_quota_hours ?? null) === value) continue
      const { data: updated, error } = await supabase.from('leave_types')
        .update({ annual_quota_hours: value }).eq('id', lt.id).select()
      if (error || !updated?.length) {
        showToast(t('finleave_err_save', { name: leaveTypeName(lt, lang), msg: error?.message || t('admin_no_write_permission') }), { tone: 'error' })
        setSavingDefaults(false)
        return
      }
    }
    setSavingDefaults(false)
    showToast(t('finleave_defaults_saved'))
    fetchAll()
  }

  // 放在所有處理函式之前：底下的 writeAnnualDays 等函式會用到它
  const annualType = leaveTypes.find(isAnnualLeaveType)

  // ===== 表格內直接編輯 =====

  /**
   * 把「特休天數」寫進個人額度：填了數字＝手動調整，清空＝改回依年資計算。
   * 這跟編輯視窗裡的語意完全一致，兩個入口不會做出不同的結果。
   */
  async function writeAnnualDays(userId, rawDays) {
    if (!annualType) return null
    if (rawDays === '' || rawDays == null) {
      const { error } = await supabase.from('user_leave_entitlements')
        .delete().eq('user_id', userId).eq('leave_type_id', annualType.id)
      return error
    }
    const days = Number(rawDays)
    if (Number.isNaN(days) || days < 0) return new Error(t('finleave_err_valid_number'))
    const { error } = await supabase.from('user_leave_entitlements').upsert({
      user_id: userId,
      leave_type_id: annualType.id,
      mode: 'manual',
      quota_hours: days * HOURS_PER_DAY,
      updated_at: new Date().toISOString(),
      updated_by: userProfile.id,
    }, { onConflict: 'user_id,leave_type_id' })
    return error
  }

  async function saveRow(userId, patch) {
    setRowStatus(s => ({ ...s, [userId]: 'saving' }))

    if ('hire_date' in patch) {
      // 被 RLS 擋下的 UPDATE 不會報錯，只會回 0 筆 —— 要一起檢查資料列數
      const { data, error } = await supabase.from('users')
        .update({ hire_date: patch.hire_date || null }).eq('id', userId).select()
      if (error || !data?.length) {
        setRowStatus(s => ({ ...s, [userId]: 'error' }))
        showToast(t('finleave_err_hire_date', { msg: error?.message || t('admin_no_write_permission') }), { tone: 'error' })
        return
      }
    }

    if ('annual_days' in patch) {
      const error = await writeAnnualDays(userId, patch.annual_days)
      if (error) {
        setRowStatus(s => ({ ...s, [userId]: 'error' }))
        showToast(t('finleave_err_annual_quota', { msg: error.message }), { tone: 'error' })
        return
      }
    }

    setRowStatus(s => ({ ...s, [userId]: 'saved' }))
    await fetchAll()
    // 「已儲存」顯示一下就淡出，不然整張表會一直掛著綠色勾勾
    setTimeout(() => setRowStatus(s => {
      if (s[userId] !== 'saved') return s
      const next = { ...s }; delete next[userId]; return next
    }), 2500)
  }

  /** 畫面立刻反應，實際寫入延遲 700ms（同一列再次輸入會重新計時）。 */
  function editCell(userId, field, value) {
    setDrafts(d => ({ ...d, [userId]: { ...d[userId], [field]: value } }))
    clearTimeout(saveTimers.current[userId])
    saveTimers.current[userId] = setTimeout(() => saveRow(userId, { [field]: value }), 700)
  }

  // ===== 批次套用 =====

  async function handleBulkApply() {
    if (!bulkTypeId) { showToast(t('finleave_err_select_type'), { tone: 'error' }); return }
    if (selected.length === 0) { showToast(t('finleave_err_select_users'), { tone: 'error' }); return }

    const type = leaveTypes.find(lt => lt.id === bulkTypeId)
    const annual = isAnnualLeaveType(type)
    let hours = null
    if (bulkMode === 'manual') {
      const n = Number(bulkValue)
      if (bulkValue === '' || Number.isNaN(n) || n < 0) {
        showToast(t('finleave_err_valid_number'), { tone: 'error' }); return
      }
      hours = annual ? n * HOURS_PER_DAY : n
    }

    setBulkSaving(true)
    for (const userId of selected) {
      const { error } = bulkMode === 'manual'
        ? await supabase.from('user_leave_entitlements').upsert({
            user_id: userId, leave_type_id: bulkTypeId, mode: 'manual', quota_hours: hours,
            updated_at: new Date().toISOString(), updated_by: userProfile.id,
          }, { onConflict: 'user_id,leave_type_id' })
        : await supabase.from('user_leave_entitlements')
            .delete().eq('user_id', userId).eq('leave_type_id', bulkTypeId)
      if (error) {
        showToast(t('finleave_err_bulk', { msg: error.message }), { tone: 'error' })
        setBulkSaving(false)
        return
      }
    }
    setBulkSaving(false)
    showToast(t('finleave_bulk_done', { name: leaveTypeName(type, lang), n: selected.length }))
    setSelected([])
    setBulkValue('')
    fetchAll()
  }

  function openEdit(user) {
    const rows = {}
    for (const lt of leaveTypes) {
      const existing = entitlements.find(e => e.user_id === user.id && e.leave_type_id === lt.id)
      rows[lt.id] = {
        mode: existing?.mode === 'manual' ? 'manual' : 'statutory',
        value: existing?.mode === 'manual' ? toDisplay(existing.quota_hours, isAnnualLeaveType(lt)) : '',
      }
    }
    setEditing({ user, hire_date: user.hire_date || '', rows })
  }

  async function handleSave() {
    setSaving(true)

    const { data: updatedUser, error: userError } = await supabase.from('users')
      .update({ hire_date: editing.hire_date || null })
      .eq('id', editing.user.id).select()
    if (userError || !updatedUser?.length) {
      showToast(t('finleave_err_hire_date', { msg: userError?.message || t('admin_no_write_permission') }), { tone: 'error' })
      setSaving(false)
      return
    }

    for (const lt of leaveTypes) {
      const row = editing.rows[lt.id]
      const annual = isAnnualLeaveType(lt)
      if (row.mode === 'manual') {
        const hours = toHours(row.value, annual)
        if (hours == null || hours < 0) {
          showToast(t('finleave_err_manual_number', { name: leaveTypeName(lt, lang) }), { tone: 'error' })
          setSaving(false)
          return
        }
        const { error } = await supabase.from('user_leave_entitlements').upsert({
          user_id: editing.user.id,
          leave_type_id: lt.id,
          mode: 'manual',
          quota_hours: hours,
          updated_at: new Date().toISOString(),
          updated_by: userProfile.id,
        }, { onConflict: 'user_id,leave_type_id' })
        if (error) { showToast(t('finleave_err_save', { name: leaveTypeName(lt, lang), msg: error.message }), { tone: 'error' }); setSaving(false); return }
      } else {
        // 比照勞基法 -- drop any previous manual row so it falls back to the default.
        const { error } = await supabase.from('user_leave_entitlements')
          .delete().eq('user_id', editing.user.id).eq('leave_type_id', lt.id)
        if (error) { showToast(t('finleave_err_save', { name: leaveTypeName(lt, lang), msg: error.message }), { tone: 'error' }); setSaving(false); return }
      }
    }

    setSaving(false)
    showToast(t('finleave_updated', { name: editing.user.full_name }))
    setEditing(null)
    fetchAll()
  }

  if (loading) return <div><PageHeader title={t('finleave_title')} /><Skeleton height="200px" /></div>

  const departments = [...new Set(users.map(u => u.department).filter(Boolean))].sort()

  function manualCountFor(userId) {
    return entitlements.filter(e => e.user_id === userId && e.mode === 'manual').length
  }

  /** 這個人的特休有沒有被手動指定；沒有就用依年資算出來的天數。 */
  function annualOverrideDays(userId) {
    if (!annualType) return null
    const row = entitlements.find(e => e.user_id === userId && e.leave_type_id === annualType.id && e.mode === 'manual')
    return row?.quota_hours != null ? Number(row.quota_hours) / HOURS_PER_DAY : null
  }

  function annualStatutoryDays(userId) {
    const summary = annualSummary[userId]
    return summary?.entitled_days != null ? Number(summary.entitled_days) : null
  }

  const visibleUsers = users.filter(u => {
    if (filterDept && u.department !== filterDept) return false
    if (filterStatus === 'no_hire_date') return !u.hire_date
    if (filterStatus === 'has_manual') return manualCountFor(u.id) > 0
    if (filterStatus === 'all_statutory') return manualCountFor(u.id) === 0
    return true
  })

  const visibleIds = visibleUsers.map(u => u.id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selected.includes(id))

  /** 表格格子目前該顯示的值：優先用還沒存完的草稿，否則用資料庫的值。 */
  function cellValue(user, field) {
    const draft = drafts[user.id]?.[field]
    if (draft !== undefined) return draft
    if (field === 'hire_date') return user.hire_date || ''
    const override = annualOverrideDays(user.id)
    return override != null ? String(override) : ''
  }

  return (
    <div>
      <PageHeader title={t('finleave_title')} />
      <p className="admin-hint">
        {t('finleave_hint_1')}
        <br />
        <strong>{t('finleave_hint_2_strong')}</strong>{t('finleave_hint_2_rest')}
      </p>

      <Card className="admin-form-card">
        <h4 className="admin-form-card__title">{t('finleave_defaults_title')}</h4>
        <p className="admin-form-card__hint">{t('finleave_defaults_hint')}</p>
        <div className="admin-form-grid">
          {leaveTypes.filter(lt => !isAnnualLeaveType(lt)).map(lt => (
            <TextField
              key={lt.id}
              label={t('finleave_defaults_field', { name: leaveTypeName(lt, lang) })}
              type="number"
              min="0"
              value={defaults[lt.id] ?? ''}
              onChange={e => setDefaults(p => ({ ...p, [lt.id]: e.target.value }))}
              placeholder={t('finleave_defaults_placeholder')}
            />
          ))}
        </div>
        <div className="admin-form-actions">
          <Button loading={savingDefaults} onClick={handleSaveDefaults}>{t('finleave_defaults_save')}</Button>
        </div>
      </Card>

      <LeaveTypeNames />

      <div className="admin-inline-form">
        <Select value={filterDept} onChange={e => setFilterDept(e.target.value)} style={{ maxWidth: '200px' }}>
          <option value="">{t('common_all_departments')}</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </Select>
        <Select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ maxWidth: '220px' }}>
          <option value="">{t('finleave_all_statuses')}</option>
          <option value="no_hire_date">{t('finleave_status_no_hire_date')}</option>
          <option value="has_manual">{t('finleave_status_has_manual')}</option>
          <option value="all_statutory">{t('finleave_status_all_statutory')}</option>
        </Select>
      </div>

      {selected.length > 0 && (
        <Card className="admin-form-card">
          <h4 className="admin-form-card__title">{t('finleave_bulk_title', { n: selected.length })}</h4>
          <p className="admin-form-card__hint">{t('finleave_bulk_hint')}</p>
          <div className="admin-inline-form">
            <Select value={bulkTypeId} onChange={e => setBulkTypeId(e.target.value)} style={{ maxWidth: '200px' }}>
              <option value="">{t('finleave_select_type')}</option>
              {leaveTypes.map(lt => <option key={lt.id} value={lt.id}>{leaveTypeName(lt, lang)}</option>)}
            </Select>
            <Select value={bulkMode} onChange={e => setBulkMode(e.target.value)} style={{ maxWidth: '160px' }}>
              <option value="manual">{t('finleave_mode_manual')}</option>
              <option value="statutory">{t('finleave_mode_statutory')}</option>
            </Select>
            {bulkMode === 'manual' && (
              <input
                className="ui-field__control"
                type="number"
                min="0"
                style={{ maxWidth: '160px' }}
                value={bulkValue}
                onChange={e => setBulkValue(e.target.value)}
                placeholder={bulkTypeId && isAnnualLeaveType(leaveTypes.find(lt => lt.id === bulkTypeId)) ? t('finleave_unit_days') : t('finleave_unit_hours')}
              />
            )}
            <Button loading={bulkSaving} onClick={handleBulkApply}>{t('finleave_apply')}</Button>
            <Button variant="text" onClick={() => setSelected([])}>{t('finleave_clear_selection')}</Button>
          </div>
        </Card>
      )}

      {visibleUsers.length === 0 ? (
        <Card><p className="admin-hint">{t('common_no_matching_users')}</p></Card>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label={t('finleave_select_all')}
                    checked={allVisibleSelected}
                    onChange={e => setSelected(e.target.checked ? visibleIds : [])}
                  />
                </th>
                <th>{t('adminusers_col_name')}</th><th>{t('adminusers_col_department')}</th><th>{t('adminusers_col_title')}</th>
                <th>{t('finleave_col_hire_date')}</th><th>{t('finleave_col_tenure')}</th><th>{t('finleave_col_annual_days')}</th>
                <th>{t('finleave_col_manual')}</th><th>{t('common_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map(user => {
                const manualCount = manualCountFor(user.id)
                const status = rowStatus[user.id]
                const statutory = annualStatutoryDays(user.id)
                return (
                  <tr key={user.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={t('finleave_select_user', { name: user.full_name })}
                        checked={selected.includes(user.id)}
                        onChange={e => setSelected(prev =>
                          e.target.checked ? [...prev, user.id] : prev.filter(id => id !== user.id))}
                      />
                    </td>
                    <td>{user.full_name}</td>
                    <td>{user.department || '—'}</td>
                    <td>{user.job_title || '—'}</td>
                    <td>
                      <input
                        className="ui-field__control admin-cell-input"
                        type="date"
                        aria-label={t('finleave_aria_hire_date', { name: user.full_name })}
                        value={cellValue(user, 'hire_date')}
                        onChange={e => editCell(user.id, 'hire_date', e.target.value)}
                      />
                      {!cellValue(user, 'hire_date') && <span className="review-missing-manager"> {t('finleave_not_filled')}</span>}
                    </td>
                    <td>{formatTenure(cellValue(user, 'hire_date'), t)}</td>
                    <td>
                      <input
                        className="ui-field__control admin-cell-input"
                        type="number"
                        min="0"
                        step="0.5"
                        aria-label={t('finleave_aria_annual', { name: user.full_name })}
                        // 留白時用依年資算出來的天數當提示，讓人看得出「沒填不等於 0」
                        placeholder={statutory != null ? t('finleave_by_seniority_n', { n: statutory }) : t('finleave_by_seniority')}
                        value={cellValue(user, 'annual_days')}
                        onChange={e => editCell(user.id, 'annual_days', e.target.value)}
                        disabled={!annualType}
                      />
                    </td>
                    <td>
                      {manualCount > 0
                        ? <Chip tone="info">{t('finleave_manual_count', { n: manualCount })}</Chip>
                        : <Chip tone="neutral">{t('finleave_status_all_statutory')}</Chip>}
                    </td>
                    <td className="admin-cell-actions">
                      <Button size="sm" variant="outlined" onClick={() => openEdit(user)}>{t('common_edit')}</Button>
                      {status === 'saving' && <span className="admin-save-hint">{t('finleave_saving')}</span>}
                      {status === 'saved' && <span className="admin-save-hint admin-save-hint--ok">{t('finleave_saved')}</span>}
                      {status === 'error' && <span className="admin-save-hint admin-save-hint--error">{t('finleave_save_error')}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Dialog
          size="lg"
          title={t('finleave_edit_title', { name: editing.user.full_name })}
          labelledBy="edit-entitlement-dialog-title"
          onClose={() => setEditing(null)}
          actions={(
            <>
              <Button variant="text" onClick={() => setEditing(null)}>{t('common_cancel')}</Button>
              <Button loading={saving} onClick={handleSave}>{t('common_save')}</Button>
            </>
          )}
        >
          <div className="admin-form-grid">
            <TextField
              label={t('finleave_col_hire_date')}
              type="date"
              value={editing.hire_date}
              onChange={e => setEditing(p => ({ ...p, hire_date: e.target.value }))}
            />
            <div>
              <div className="admin-row__meta">{t('finleave_col_tenure')}</div>
              <div className="admin-row__title">{formatTenure(editing.hire_date, t)}</div>
            </div>
          </div>

          <table className="ui-table" style={{ marginTop: 'var(--space-200)' }}>
            <thead>
              <tr><th>{t('field_leave_type')}</th><th>{t('finleave_col_quota_mode')}</th><th>{t('finleave_col_value')}</th></tr>
            </thead>
            <tbody>
              {leaveTypes.map(lt => {
                const annual = isAnnualLeaveType(lt)
                const row = editing.rows[lt.id]
                return (
                  <tr key={lt.id}>
                    <td>{leaveTypeName(lt, lang)}{annual && <> <Chip tone="neutral">{t('finleave_by_seniority_chip')}</Chip></>}</td>
                    <td>
                      <select
                        className="ui-field__control"
                        value={row.mode}
                        onChange={e => setEditing(p => ({
                          ...p,
                          rows: { ...p.rows, [lt.id]: { ...p.rows[lt.id], mode: e.target.value } },
                        }))}
                      >
                        <option value="statutory">{t('finleave_mode_statutory')}</option>
                        <option value="manual">{t('finleave_mode_manual')}</option>
                      </select>
                    </td>
                    <td>
                      {row.mode === 'manual' ? (
                        <TextField
                          type="number"
                          min="0"
                          step={annual ? '0.5' : '1'}
                          value={row.value}
                          onChange={e => setEditing(p => ({
                            ...p,
                            rows: { ...p.rows, [lt.id]: { ...p.rows[lt.id], value: e.target.value } },
                          }))}
                          placeholder={annual ? t('finleave_unit_days') : t('finleave_unit_hours')}
                          helper={annual
                            ? (row.value !== '' ? t('finleave_equals_hours', { n: Number(row.value) * HOURS_PER_DAY }) : t('finleave_unit_days_helper'))
                            : t('finleave_unit_hours_helper')}
                        />
                      ) : (
                        <span className="admin-row__meta">
                          {annual ? t('finleave_auto_by_hire_date') : (
                            lt.annual_quota_hours != null
                              ? t('finleave_company_default', { n: lt.annual_quota_hours })
                              : t('finleave_no_fixed')
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Dialog>
      )}
    </div>
  )
}

export default EmployeeLeaveManagement
