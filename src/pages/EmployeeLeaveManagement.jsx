import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, Chip, Dialog, PageHeader, Select, Skeleton, TextField } from '../components/ui'
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
  // 假別英文名：介面切成 English 時要顯示的名稱（存在 leave_types.name_en）
  const [namesEn, setNamesEn] = useState({})
  const [savingNames, setSavingNames] = useState(false)
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
    setDefaults(Object.fromEntries((lt.data || []).map(t => [t.id, t.annual_quota_hours != null ? String(t.annual_quota_hours) : ''])))
    setNamesEn(Object.fromEntries((lt.data || []).map(t => [t.id, t.name_en || ''])))
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

  // 假別名稱是資料、不是介面文字，沒辦法寫死在前端字典裡，所以英文名要在這裡
  // 維護。留白＝切成英文時仍顯示中文名（不會變空白）。
  async function handleSaveNames() {
    setSavingNames(true)
    for (const t of leaveTypes) {
      const value = (namesEn[t.id] || '').trim() || null
      if ((t.name_en ?? null) === value) continue
      const { data: updated, error } = await supabase.from('leave_types')
        .update({ name_en: value }).eq('id', t.id).select()
      // RLS 擋下 UPDATE 時 Postgres 不會報錯，只會回 0 列 —— 所以 0 列也算失敗。
      if (error || !updated?.length) {
        showToast(`「${t.name}」的英文名儲存失敗：` + (error?.message || '沒有權限寫入'), { tone: 'error' })
        setSavingNames(false)
        return
      }
    }
    setSavingNames(false)
    showToast('已更新假別英文名稱')
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
    if (Number.isNaN(days) || days < 0) return new Error('請填有效數字')
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
        showToast('入職日期儲存失敗：' + (error?.message || '沒有權限寫入'), { tone: 'error' })
        return
      }
    }

    if ('annual_days' in patch) {
      const error = await writeAnnualDays(userId, patch.annual_days)
      if (error) {
        setRowStatus(s => ({ ...s, [userId]: 'error' }))
        showToast('特休額度儲存失敗：' + error.message, { tone: 'error' })
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
    if (!bulkTypeId) { showToast('請選擇假別', { tone: 'error' }); return }
    if (selected.length === 0) { showToast('請先勾選要套用的員工', { tone: 'error' }); return }

    const type = leaveTypes.find(t => t.id === bulkTypeId)
    const annual = isAnnualLeaveType(type)
    let hours = null
    if (bulkMode === 'manual') {
      const n = Number(bulkValue)
      if (bulkValue === '' || Number.isNaN(n) || n < 0) {
        showToast('請填有效數字', { tone: 'error' }); return
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
        showToast('批次套用失敗：' + error.message, { tone: 'error' })
        setBulkSaving(false)
        return
      }
    }
    setBulkSaving(false)
    showToast(`已將「${type.name}」套用到 ${selected.length} 位員工`)
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

  function annualQuotaLabel(user) {
    const override = annualOverrideDays(user.id)
    if (override != null) return `${override} 天`
    const statutory = annualStatutoryDays(user.id)
    return statutory != null ? `${statutory} 天` : '—'
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
      <PageHeader title="員工假期管理" />
      <p className="admin-hint">
        設定每位員工各假別的可用額度。預設一律「比照勞基法」（特休依入職日期與年資自動計算，其他假別用下方的全公司預設值）；
        若有個別談定的條件，改成「手動調整」並填入數字即可覆蓋。
        <br />
        <strong>入職日期與特休天數可以直接在表格裡修改，改完會自動儲存</strong>；特休留白＝依年資自動計算。
        其他假別請按「編輯」，或勾選多位員工後使用批次套用。
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

      <Card className="admin-form-card">
        <h4 className="admin-form-card__title">假別英文名稱</h4>
        <p className="admin-form-card__hint">
          同仁把介面語言切成 English 時顯示的假別名稱。留白的話會直接顯示中文名，不會變空白。
        </p>
        <div className="admin-form-grid">
          {leaveTypes.map(t => (
            <TextField
              key={t.id}
              label={t.name}
              value={namesEn[t.id] ?? ''}
              onChange={e => setNamesEn(p => ({ ...p, [t.id]: e.target.value }))}
              placeholder="留白＝顯示中文名"
            />
          ))}
        </div>
        <div className="admin-form-actions">
          <Button loading={savingNames} onClick={handleSaveNames}>儲存英文名稱</Button>
        </div>
      </Card>

      <div className="admin-inline-form">
        <Select value={filterDept} onChange={e => setFilterDept(e.target.value)} style={{ maxWidth: '200px' }}>
          <option value="">所有部門</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </Select>
        <Select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ maxWidth: '220px' }}>
          <option value="">所有狀態</option>
          <option value="no_hire_date">入職日期未填</option>
          <option value="has_manual">有個別調整</option>
          <option value="all_statutory">全部比照勞基法</option>
        </Select>
      </div>

      {selected.length > 0 && (
        <Card className="admin-form-card">
          <h4 className="admin-form-card__title">批次套用（已選 {selected.length} 人）</h4>
          <p className="admin-form-card__hint">
            把同一個假別的額度一次套用到選取的員工。選「比照勞基法」會清除他們在這個假別的個別調整。
          </p>
          <div className="admin-inline-form">
            <Select value={bulkTypeId} onChange={e => setBulkTypeId(e.target.value)} style={{ maxWidth: '200px' }}>
              <option value="">選擇假別</option>
              {leaveTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
            <Select value={bulkMode} onChange={e => setBulkMode(e.target.value)} style={{ maxWidth: '160px' }}>
              <option value="manual">手動調整</option>
              <option value="statutory">比照勞基法</option>
            </Select>
            {bulkMode === 'manual' && (
              <input
                className="ui-field__control"
                type="number"
                min="0"
                style={{ maxWidth: '160px' }}
                value={bulkValue}
                onChange={e => setBulkValue(e.target.value)}
                placeholder={bulkTypeId && isAnnualLeaveType(leaveTypes.find(t => t.id === bulkTypeId)) ? '天' : '小時'}
              />
            )}
            <Button loading={bulkSaving} onClick={handleBulkApply}>套用</Button>
            <Button variant="text" onClick={() => setSelected([])}>取消選取</Button>
          </div>
        </Card>
      )}

      {visibleUsers.length === 0 ? (
        <Card><p className="admin-hint">沒有符合條件的員工資料</p></Card>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="全選"
                    checked={allVisibleSelected}
                    onChange={e => setSelected(e.target.checked ? visibleIds : [])}
                  />
                </th>
                <th>姓名</th><th>部門</th><th>職稱</th>
                <th>入職日期</th><th>年資</th><th>特休天數</th>
                <th>個別調整</th><th>操作</th>
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
                        aria-label={`選取 ${user.full_name}`}
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
                        aria-label={`${user.full_name} 的入職日期`}
                        value={cellValue(user, 'hire_date')}
                        onChange={e => editCell(user.id, 'hire_date', e.target.value)}
                      />
                      {!cellValue(user, 'hire_date') && <span className="review-missing-manager"> ⚠ 未填</span>}
                    </td>
                    <td>{formatTenure(cellValue(user, 'hire_date'))}</td>
                    <td>
                      <input
                        className="ui-field__control admin-cell-input"
                        type="number"
                        min="0"
                        step="0.5"
                        aria-label={`${user.full_name} 的特休天數`}
                        // 留白時用依年資算出來的天數當提示，讓人看得出「沒填不等於 0」
                        placeholder={statutory != null ? `依年資 ${statutory}` : '依年資'}
                        value={cellValue(user, 'annual_days')}
                        onChange={e => editCell(user.id, 'annual_days', e.target.value)}
                        disabled={!annualType}
                      />
                    </td>
                    <td>
                      {manualCount > 0
                        ? <Chip tone="info">{manualCount} 項手動調整</Chip>
                        : <Chip tone="neutral">全部比照勞基法</Chip>}
                    </td>
                    <td className="admin-cell-actions">
                      <Button size="sm" variant="outlined" onClick={() => openEdit(user)}>編輯</Button>
                      {status === 'saving' && <span className="admin-save-hint">儲存中…</span>}
                      {status === 'saved' && <span className="admin-save-hint admin-save-hint--ok">✓ 已儲存</span>}
                      {status === 'error' && <span className="admin-save-hint admin-save-hint--error">✕ 未儲存</span>}
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
