import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, Chip, Dialog, PageHeader, Skeleton, TextField } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { HOURS_PER_DAY, isAnnualLeaveType } from '../lib/leaveEntitlements'
import './AdminPanel.css'

function formatTenure(hireDate) {
  if (!hireDate) return '—'
  const start = new Date(hireDate)
  const now = new Date()
  let years = now.getFullYear() - start.getFullYear()
  let months = now.getMonth() - start.getMonth()
  if (now.getDate() < start.getDate()) months -= 1
  if (months < 0) { years -= 1; months += 12 }
  if (years < 0) return '—'
  return `${years}年${months}個月`
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

// ===== 員工假期管理（財務專用）=====
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
  const { showToast } = useToast()

  useEffect(() => { fetchAll() }, [])

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
    setDefaults(Object.fromEntries((lt.data || []).map(t => [t.id, t.annual_quota_hours != null ? String(t.annual_quota_hours) : ''])))
    setLoading(false)
  }

  async function handleSaveDefaults() {
    setSavingDefaults(true)
    for (const t of leaveTypes) {
      if (isAnnualLeaveType(t)) continue // 特休 comes from the seniority formula, not a flat default
      const raw = defaults[t.id]
      const value = raw === '' ? null : Number(raw)
      if (value !== null && (Number.isNaN(value) || value < 0)) {
        showToast(`「${t.name}」的時數請填有效數字`, { tone: 'error' })
        setSavingDefaults(false)
        return
      }
      if ((t.annual_quota_hours ?? null) === value) continue
      const { data: updated, error } = await supabase.from('leave_types')
        .update({ annual_quota_hours: value }).eq('id', t.id).select()
      if (error || !updated?.length) {
        showToast(`「${t.name}」儲存失敗：` + (error?.message || '沒有權限寫入'), { tone: 'error' })
        setSavingDefaults(false)
        return
      }
    }
    setSavingDefaults(false)
    showToast('已更新全公司預設額度')
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
      showToast('入職日期儲存失敗：' + (userError?.message || '沒有權限寫入'), { tone: 'error' })
      setSaving(false)
      return
    }

    for (const lt of leaveTypes) {
      const row = editing.rows[lt.id]
      const annual = isAnnualLeaveType(lt)
      if (row.mode === 'manual') {
        const hours = toHours(row.value, annual)
        if (hours == null || hours < 0) {
          showToast(`「${lt.name}」選了手動調整，請填有效數字`, { tone: 'error' })
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
        if (error) { showToast(`「${lt.name}」儲存失敗：` + error.message, { tone: 'error' }); setSaving(false); return }
      } else {
        // 比照勞基法 -- drop any previous manual row so it falls back to the default.
        const { error } = await supabase.from('user_leave_entitlements')
          .delete().eq('user_id', editing.user.id).eq('leave_type_id', lt.id)
        if (error) { showToast(`「${lt.name}」儲存失敗：` + error.message, { tone: 'error' }); setSaving(false); return }
      }
    }

    setSaving(false)
    showToast(`已更新 ${editing.user.full_name} 的假期設定`)
    setEditing(null)
    fetchAll()
  }

  if (loading) return <div><PageHeader title="員工假期管理" /><Skeleton height="200px" /></div>

  const departments = [...new Set(users.map(u => u.department).filter(Boolean))].sort()
  const visibleUsers = filterDept ? users.filter(u => u.department === filterDept) : users
  const annualType = leaveTypes.find(isAnnualLeaveType)

  function manualCountFor(userId) {
    return entitlements.filter(e => e.user_id === userId && e.mode === 'manual').length
  }

  function annualQuotaLabel(user) {
    if (annualType) {
      const override = entitlements.find(e => e.user_id === user.id && e.leave_type_id === annualType.id && e.mode === 'manual')
      if (override && override.quota_hours != null) return `${Number(override.quota_hours) / HOURS_PER_DAY} 天`
    }
    const summary = annualSummary[user.id]
    return summary?.entitled_days != null ? `${summary.entitled_days} 天` : '—'
  }

  return (
    <div>
      <PageHeader title="員工假期管理" />
      <p className="admin-hint">
        設定每位員工各假別的可用額度。預設一律「比照勞基法」（特休依入職日期與年資自動計算，其他假別用下方的全公司預設值）；
        若有個別談定的條件，改成「手動調整」並填入數字即可覆蓋。
      </p>

      <Card className="admin-form-card">
        <h4 className="admin-form-card__title">全公司預設額度</h4>
        <p className="admin-form-card__hint">
          沒有特別談過的員工都會套用這裡的數字。單位為小時，留白＝依勞基法（不顯示固定時數）。
          特休不在此設定，因為它是依每個人的入職日期與年資自動計算。
        </p>
        <div className="admin-form-grid">
          {leaveTypes.filter(t => !isAnnualLeaveType(t)).map(t => (
            <TextField
              key={t.id}
              label={`${t.name}（小時）`}
              type="number"
              min="0"
              value={defaults[t.id] ?? ''}
              onChange={e => setDefaults(p => ({ ...p, [t.id]: e.target.value }))}
              placeholder="留白＝依勞基法"
            />
          ))}
        </div>
        <div className="admin-form-actions">
          <Button loading={savingDefaults} onClick={handleSaveDefaults}>儲存預設額度</Button>
        </div>
      </Card>

      <div className="admin-inline-form">
        <select className="ui-field__control" value={filterDept} onChange={e => setFilterDept(e.target.value)} style={{ maxWidth: '200px' }}>
          <option value="">所有部門</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {visibleUsers.length === 0 ? (
        <Card><p className="admin-hint">沒有符合條件的員工資料</p></Card>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr><th>姓名</th><th>部門</th><th>職稱</th><th>入職日期</th><th>年資</th><th>特休額度</th><th>個別調整</th><th>操作</th></tr>
            </thead>
            <tbody>
              {visibleUsers.map(user => {
                const manualCount = manualCountFor(user.id)
                return (
                  <tr key={user.id}>
                    <td>{user.full_name}</td>
                    <td>{user.department || '—'}</td>
                    <td>{user.job_title || '—'}</td>
                    <td>{user.hire_date || <span className="review-missing-manager">⚠ 未填</span>}</td>
                    <td>{formatTenure(user.hire_date)}</td>
                    <td>{annualQuotaLabel(user)}</td>
                    <td>
                      {manualCount > 0
                        ? <Chip tone="info">{manualCount} 項手動調整</Chip>
                        : <Chip tone="neutral">全部比照勞基法</Chip>}
                    </td>
                    <td><Button size="sm" variant="outlined" onClick={() => openEdit(user)}>編輯</Button></td>
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
          title={`假期設定 — ${editing.user.full_name}`}
          labelledBy="edit-entitlement-dialog-title"
          onClose={() => setEditing(null)}
          actions={(
            <>
              <Button variant="text" onClick={() => setEditing(null)}>取消</Button>
              <Button loading={saving} onClick={handleSave}>儲存</Button>
            </>
          )}
        >
          <div className="admin-form-grid">
            <TextField
              label="入職日期"
              type="date"
              value={editing.hire_date}
              onChange={e => setEditing(p => ({ ...p, hire_date: e.target.value }))}
            />
            <div>
              <div className="admin-row__meta">年資</div>
              <div className="admin-row__title">{formatTenure(editing.hire_date)}</div>
            </div>
          </div>

          <table className="ui-table" style={{ marginTop: 'var(--space-200)' }}>
            <thead>
              <tr><th>假別</th><th>額度設定</th><th>數值</th></tr>
            </thead>
            <tbody>
              {leaveTypes.map(lt => {
                const annual = isAnnualLeaveType(lt)
                const row = editing.rows[lt.id]
                return (
                  <tr key={lt.id}>
                    <td>{lt.name}{annual && <> <Chip tone="neutral">依年資計算</Chip></>}</td>
                    <td>
                      <select
                        className="ui-field__control"
                        value={row.mode}
                        onChange={e => setEditing(p => ({
                          ...p,
                          rows: { ...p.rows, [lt.id]: { ...p.rows[lt.id], mode: e.target.value } },
                        }))}
                      >
                        <option value="statutory">比照勞基法</option>
                        <option value="manual">手動調整</option>
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
                          placeholder={annual ? '天' : '小時'}
                          helper={annual
                            ? (row.value !== '' ? `= ${Number(row.value) * HOURS_PER_DAY} 小時` : '單位：天')
                            : '單位：小時'}
                        />
                      ) : (
                        <span className="admin-row__meta">
                          {annual ? '依入職日期與年資自動計算' : (
                            leaveTypes.find(t => t.id === lt.id)?.annual_quota_hours != null
                              ? `${leaveTypes.find(t => t.id === lt.id).annual_quota_hours} 小時（公司預設）`
                              : '依勞基法（未設定固定時數）'
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
