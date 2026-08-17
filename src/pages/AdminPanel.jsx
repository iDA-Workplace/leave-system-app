import { useState, useEffect } from 'react'
import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { invokeFunction } from '../lib/api'
import ExportReport from './ExportReport'
import EmployeeLeaveManagement from './EmployeeLeaveManagement'
import LeaveTypeNames from './LeaveTypeNames'
import { Button, Card, Chip, ConfirmDialog, Dialog, PageHeader, Select, Skeleton, Tabs, TextField } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'
import './AdminPanel.css'

// deputy_supervisor stays here (and in roleTone) purely so any existing
// user who already has that role still displays a proper label/Chip --
// it's just no longer offered as a choice when adding/editing someone
// (see ASSIGNABLE_ROLES below). 標籤文字統一走 t('role_<key>')。
const roleTone = { employee: 'neutral', deputy_supervisor: 'warning', supervisor: 'warning', boss: 'info' }
const ASSIGNABLE_ROLES = ['employee', 'supervisor', 'boss']
const DEFAULT_PASSWORD = 'Welcome@123'

// ===== 員工管理 =====
// 入職日期 is deliberately absent: it's 財務-owned now (員工假期管理), since
// 年資 -- and therefore 特休 -- is derived from it. Admins neither see nor
// set it; finance fills it in after the account is created.
const emptyNewUser = { email: '', full_name: '', role: 'employee', default_flow_id: '', is_admin: false, is_finance: false, department: '', job_title: '', manager_id: '' }

function UserManagement({ isAdmin, userProfile }) {
  const { t } = useLanguage()
  const [users, setUsers] = useState([])
  const [flows, setFlows] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [newUser, setNewUser] = useState(emptyNewUser)
  const [showAdd, setShowAdd] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmToggle, setConfirmToggle] = useState(null)
  const [filterDept, setFilterDept] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const { showToast } = useToast()

  useEffect(() => { fetchUsers(); fetchFlows() }, [])

  async function fetchUsers() {
    const { data } = await supabase
      .from('users')
      .select('*, default_flow:approval_flows(name)')
      .order('full_name')
    setUsers(data || [])
    setLoading(false)
  }

  async function fetchFlows() {
    const { data } = await supabase
      .from('approval_flows')
      .select('id, name')
      .eq('is_active', true)
    setFlows(data || [])
  }

  async function handleAddUser() {
    if (!newUser.email || !newUser.full_name) { showToast(t('adminusers_err_required'), { tone: 'error' }); return }
    setSaving(true)
    const { data, error } = await invokeFunction('manage-users', {
      action: 'create',
      email: newUser.email,
      full_name: newUser.full_name,
      role: newUser.role,
      password: DEFAULT_PASSWORD,
      hire_date: null
    })
    if (error || data?.error) { showToast(t('adminusers_err_create', { msg: data?.error || error.message }), { tone: 'error' }); setSaving(false); return }
    if (data?.user?.id) {
      // .select() after .update() so a zero-row result is visible in
      // `updated` -- Postgres RLS silently reports success with 0 rows
      // affected when its policy excludes every targeted row, it does not
      // raise an error, so checking `updateError` alone isn't enough.
      const { data: updated, error: updateError } = await supabase.from('users').update({
        default_flow_id: newUser.default_flow_id || null,
        is_admin: newUser.is_admin,
        is_finance: newUser.is_finance,
        department: newUser.department || null,
        job_title: newUser.job_title || null,
        manager_id: newUser.manager_id || null
      }).eq('id', data.user.id).select()
      if (updateError || !updated?.length) {
        showToast(t('adminusers_err_partial', { msg: updateError?.message || t('admin_no_write_permission') }), { tone: 'error' })
        setSaving(false)
        setNewUser(emptyNewUser)
        setShowAdd(false)
        setTimeout(fetchUsers, 1000)
        return
      }
    }
    showToast(t('adminusers_created', { pw: DEFAULT_PASSWORD }))
    setNewUser(emptyNewUser)
    setShowAdd(false)
    setSaving(false)
    setTimeout(fetchUsers, 1000)
  }

  async function handleUpdateUser() {
    setSaving(true)
    const { data, error } = await invokeFunction('manage-users', {
      action: 'update',
      userId: editing.id,
      full_name: editing.full_name,
      role: editing.role,
      slack_user_id: editing.slack_user_id,
      is_active: editing.is_active,
      // Passed back unchanged, never edited here -- 入職日期 belongs to
      // 財務 now. Sending the existing value (rather than omitting the
      // field) keeps the edge function from treating it as "clear this".
      hire_date: editing.hire_date || null
    })
    if (error || data?.error) { showToast(t('adminusers_err_update', { msg: data?.error || error.message }), { tone: 'error' }); setSaving(false); return }
    // .select() after .update() so a zero-row result is visible in
    // `updated` -- Postgres RLS silently reports success with 0 rows
    // affected when its policy excludes every targeted row, it does not
    // raise an error, so checking `updateError` alone isn't enough.
    const { data: updated, error: updateError } = await supabase.from('users').update({
      default_flow_id: editing.default_flow_id || null,
      is_admin: editing.is_admin,
      is_finance: editing.is_finance,
      department: editing.department || null,
      job_title: editing.job_title || null,
      manager_id: editing.manager_id || null
    }).eq('id', editing.id).select()
    setSaving(false)
    if (updateError || !updated?.length) {
      showToast(t('adminusers_err_update_fields', { msg: updateError?.message || t('admin_no_write_permission') }), { tone: 'error' })
      fetchUsers()
      return
    }
    setEditing(null)
    showToast(t('adminusers_updated'))
    fetchUsers()
  }

  // "刪除離職同仁" reuses the existing 帳號啟用 mechanism (deactivate, not a
  // hard DB delete) -- per instruction, all historical leave/考核 records
  // stay intact, the account just stops appearing as selectable elsewhere.
  // Re-activating is still possible from the same place if needed.
  async function handleToggleActive() {
    setSaving(true)
    const { data, error } = await invokeFunction('manage-users', {
      action: 'update',
      userId: confirmToggle.id,
      full_name: confirmToggle.full_name,
      role: confirmToggle.role,
      slack_user_id: confirmToggle.slack_user_id,
      is_active: !confirmToggle.is_active,
      hire_date: confirmToggle.hire_date || null
    })
    if (error || data?.error) { showToast(t('adminusers_err_toggle', { msg: data?.error || error.message }), { tone: 'error' }); setSaving(false); return }
    setSaving(false)
    showToast(confirmToggle.is_active ? t('adminusers_deleted_toast') : t('adminusers_restored_toast'))
    setConfirmToggle(null)
    setEditing(null)
    fetchUsers()
  }

  if (loading) return <div><PageHeader title={t('adminusers_title')} /><Skeleton height="200px" /></div>

  const departments = [...new Set(users.map(u => u.department).filter(Boolean))].sort()
  const managerNameById = Object.fromEntries(users.map(u => [u.id, u.full_name]))
  const visibleUsers = users.filter(u => {
    if (filterStatus === 'deleted' ? u.is_active : !u.is_active) return false
    if (filterDept && u.department !== filterDept) return false
    return true
  })

  return (
    <div>
      <PageHeader
        title={t('adminusers_title')}
        actions={isAdmin && <Button size="sm" onClick={() => { setNewUser(emptyNewUser); setShowAdd(true) }}>{t('adminusers_add')}</Button>}
      />

      <div className="admin-inline-form">
        <Select value={filterDept} onChange={e => setFilterDept(e.target.value)} style={{ maxWidth: '200px' }}>
          <option value="">{t('common_all_departments')}</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </Select>
        <Select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ maxWidth: '160px' }}>
          <option value="">{t('adminusers_active')}</option>
          <option value="deleted">{t('adminusers_deleted')}</option>
        </Select>
      </div>

      {visibleUsers.length === 0 ? (
        <Card><p className="admin-hint">{filterStatus === 'deleted' ? t('adminusers_no_deleted') : t('common_no_matching_users')}</p></Card>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr><th>{t('adminusers_col_name')}</th><th>{t('adminusers_col_department')}</th><th>{t('adminusers_col_title')}</th><th>{t('adminusers_col_role')}</th><th>Slack ID</th><th>{t('adminusers_col_flow')}</th><th>{t('adminusers_col_manager')}</th>{isAdmin && <th>{t('common_actions')}</th>}</tr>
            </thead>
            <tbody>
              {visibleUsers.map(user => (
                <tr key={user.id} style={{ opacity: user.is_active ? 1 : 0.6 }}>
                  <td>
                    {user.full_name}{user.english_name && ` (${user.english_name})`}
                    {user.is_admin && <> <Chip tone="info">{t('adminusers_badge_admin')}</Chip></>}
                    {user.is_finance && <> <Chip tone="warning">HR</Chip></>}
                    {!user.is_active && <> <Chip tone="error">{t('adminusers_deleted')}</Chip></>}
                  </td>
                  <td>{user.department || '—'}</td>
                  <td>{user.job_title || '—'}</td>
                  <td><Chip tone={roleTone[user.role] || 'neutral'}>{user.role ? t(`role_${user.role}`) : '—'}</Chip></td>
                  <td>{user.slack_user_id || '—'}</td>
                  <td>{user.default_flow?.name || '—'}</td>
                  <td>{user.manager_id ? (managerNameById[user.manager_id] || '—') : '—'}</td>
                  {isAdmin && (
                    <td><Button size="sm" variant="outlined" onClick={() => setEditing({ ...user })}>{t('common_edit')}</Button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isAdmin && showAdd && (
        <Dialog
          title={t('adminusers_add_title')}
          labelledBy="add-user-dialog-title"
          onClose={() => setShowAdd(false)}
          actions={(
            <>
              <Button variant="text" onClick={() => setShowAdd(false)}>{t('common_cancel')}</Button>
              <Button loading={saving} onClick={handleAddUser}>{t('common_add')}</Button>
            </>
          )}
        >
          <p className="admin-form-card__hint">
            {t('adminusers_default_password_hint_before')}<strong>{DEFAULT_PASSWORD}</strong>{t('adminusers_default_password_hint_after')}
          </p>
          <div className="admin-form-grid">
            <TextField label={t('adminusers_col_name')} required value={newUser.full_name} onChange={e => setNewUser(p => ({ ...p, full_name: e.target.value }))} placeholder={t('adminusers_name_placeholder')} />
            <TextField label={t('settings_email')} required value={newUser.email} onChange={e => setNewUser(p => ({ ...p, email: e.target.value }))} placeholder={t('adminusers_email_placeholder')} />
            <Select label={t('adminusers_col_role')} required value={newUser.role} onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}>
              {ASSIGNABLE_ROLES.map(value => <option key={value} value={value}>{t(`role_${value}`)}</option>)}
            </Select>
            <Select label={t('adminusers_col_flow')} value={newUser.default_flow_id} onChange={e => setNewUser(p => ({ ...p, default_flow_id: e.target.value }))}>
              <option value="">{t('adminusers_select_flow')}</option>
              {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
            <TextField label={t('adminusers_col_department')} value={newUser.department} onChange={e => setNewUser(p => ({ ...p, department: e.target.value }))} placeholder={t('common_optional')} />
            <TextField label={t('adminusers_col_title')} value={newUser.job_title} onChange={e => setNewUser(p => ({ ...p, job_title: e.target.value }))} placeholder={t('common_optional')} />
            <Select label={t('adminusers_col_manager')} value={newUser.manager_id} onChange={e => setNewUser(p => ({ ...p, manager_id: e.target.value }))}>
              <option value="">{t('adminusers_unassigned')}</option>
              {users.filter(u => u.is_active).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </Select>
          </div>
          <p className="admin-form-card__hint">{t('adminusers_hire_date_hint')}</p>
          <label className="admin-checkbox-label">
            <input type="checkbox" checked={newUser.is_admin} onChange={e => setNewUser(p => ({ ...p, is_admin: e.target.checked }))} />
            {t('adminusers_also_admin')}
          </label>
          <label className="admin-checkbox-label">
            <input type="checkbox" checked={newUser.is_finance} onChange={e => setNewUser(p => ({ ...p, is_finance: e.target.checked }))} />
            {t('adminusers_also_finance')}
          </label>
        </Dialog>
      )}

      {isAdmin && editing && (
        <Dialog
          title={t('adminusers_edit_title', { name: editing.full_name })}
          labelledBy="edit-user-dialog-title"
          onClose={() => setEditing(null)}
          actions={(
            <>
              <Button
                variant={editing.is_active ? 'danger-outlined' : 'outlined'}
                onClick={() => setConfirmToggle(editing)}
              >
                {editing.is_active ? t('adminusers_delete_account') : t('adminusers_restore_account')}
              </Button>
              <Button variant="text" onClick={() => setEditing(null)}>{t('common_cancel')}</Button>
              <Button loading={saving} onClick={handleUpdateUser}>{t('common_save')}</Button>
            </>
          )}
        >
          <div className="admin-form-grid">
            <TextField label={t('adminusers_col_name')} value={editing.full_name} onChange={e => setEditing(p => ({ ...p, full_name: e.target.value }))} />
            <TextField label={t('settings_email')} value={editing.email || ''} disabled />
            <Select label={t('adminusers_col_role')} value={editing.role} onChange={e => setEditing(p => ({ ...p, role: e.target.value }))}>
              {ASSIGNABLE_ROLES.map(value => <option key={value} value={value}>{t(`role_${value}`)}</option>)}
            </Select>
            <Select label={t('adminusers_col_flow')} value={editing.default_flow_id || ''} onChange={e => setEditing(p => ({ ...p, default_flow_id: e.target.value }))}>
              <option value="">{t('adminusers_select_flow')}</option>
              {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
            <TextField label="Slack User ID" value={editing.slack_user_id || ''} onChange={e => setEditing(p => ({ ...p, slack_user_id: e.target.value }))} placeholder="U0123ABCD" />
            <TextField label={t('adminusers_col_department')} value={editing.department || ''} onChange={e => setEditing(p => ({ ...p, department: e.target.value }))} placeholder={t('common_optional')} />
            <TextField label={t('adminusers_col_title')} value={editing.job_title || ''} onChange={e => setEditing(p => ({ ...p, job_title: e.target.value }))} placeholder={t('common_optional')} />
            <Select label={t('adminusers_col_manager')} value={editing.manager_id || ''} onChange={e => setEditing(p => ({ ...p, manager_id: e.target.value }))}>
              <option value="">{t('adminusers_unassigned')}</option>
              {users.filter(u => u.is_active && u.id !== editing.id).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </Select>
          </div>
          <p className="admin-form-card__hint">{t('adminusers_hire_date_hint')}</p>
          <label className="admin-checkbox-label">
            <input type="checkbox" checked={!!editing.is_admin} onChange={e => setEditing(p => ({ ...p, is_admin: e.target.checked }))} />
            {t('adminusers_also_admin_short')}
          </label>
          <label className="admin-checkbox-label">
            <input type="checkbox" checked={!!editing.is_finance} onChange={e => setEditing(p => ({ ...p, is_finance: e.target.checked }))} />
            {t('adminusers_also_finance')}
          </label>
        </Dialog>
      )}

      {confirmToggle && (
        <ConfirmDialog
          title={confirmToggle.is_active ? t('adminusers_delete_account') : t('adminusers_restore_account')}
          description={confirmToggle.is_active
            ? t('adminusers_delete_confirm', { name: confirmToggle.full_name })
            : t('adminusers_restore_confirm', { name: confirmToggle.full_name })}
          confirmLabel={confirmToggle.is_active ? t('common_delete') : t('adminusers_restore')}
          danger={confirmToggle.is_active}
          loading={saving}
          onConfirm={handleToggleActive}
          onCancel={() => setConfirmToggle(null)}
        />
      )}
    </div>
  )
}

// ===== 審核流程管理 =====
function FlowManagement({ isAdmin }) {
  const { t } = useLanguage()
  const [flows, setFlows] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newFlow, setNewFlow] = useState({ name: '', description: '', is_default: false })
  const [editSteps, setEditSteps] = useState(null)
  const [editName, setEditName] = useState(null)
  const [newName, setNewName] = useState('')
  const [steps, setSteps] = useState([])
  const [confirmTarget, setConfirmTarget] = useState(null)
  const { showToast } = useToast()

  useEffect(() => { fetchFlows(); fetchUsers() }, [])

  async function fetchFlows() {
    // Retired (is_active = false) flows are never shown here any more --
    // 封存 used to just grey a flow out; now the retire action tries to
    // hard-delete it outright and only falls back to is_active=false when
    // that's blocked by historical data, in which case it should disappear
    // from this list entirely rather than sit around greyed out.
    const { data } = await supabase
      .from('approval_flows')
      .select(`*, steps:approval_flow_steps(*, approver:users!approval_flow_steps_approver_id_fkey(full_name))`)
      .eq('is_active', true)
      .order('created_at')
    setFlows(data || [])
    setLoading(false)
  }

  async function fetchUsers() {
    // Was .in('role', ['supervisor', 'admin']) -- 'admin' hasn't been a
    // valid role value since the is_admin-flag refactor (admin-ness is a
    // separate boolean now, not a role), so that half of the filter never
    // matched anyone, and 'boss' was missing entirely. Approver candidates
    // should be anyone with supervisor/boss authority, or anyone flagged
    // as admin regardless of their primary role.
    const { data } = await supabase.from('users').select('id, full_name, role').eq('is_active', true).or('role.in.(supervisor,boss),is_admin.eq.true')
    setUsers(data || [])
  }

  async function handleAddFlow() {
    if (!newFlow.name) { showToast(t('adminflows_err_name'), { tone: 'error' }); return }
    if (newFlow.is_default) {
      const { error: clearError } = await supabase.from('approval_flows').update({ is_default: false }).neq('id', '00000000-0000-0000-0000-000000000000')
      if (clearError) { showToast(t('adminflows_err_add', { msg: clearError.message }), { tone: 'error' }); return }
    }
    const { error } = await supabase.from('approval_flows').insert({ ...newFlow, is_active: true })
    if (error) { showToast(t('adminflows_err_add', { msg: error.message }), { tone: 'error' }); return }
    setNewFlow({ name: '', description: '', is_default: false })
    setShowAdd(false)
    fetchFlows()
  }

  async function handleRenameFlow(flowId) {
    if (!newName.trim()) { showToast(t('adminflows_err_name'), { tone: 'error' }); return }
    const { error } = await supabase.from('approval_flows').update({ name: newName.trim() }).eq('id', flowId)
    if (error) { showToast(t('adminflows_err_rename', { msg: error.message }), { tone: 'error' }); return }
    setEditName(null)
    setNewName('')
    fetchFlows()
  }

  // "刪除" tries a real delete first. If the flow has historical leave
  // requests (or is still someone's default flow) pointing at it, the
  // database blocks the delete -- fall back to marking it retired so it at
  // least disappears from this list without losing that historical data.
  async function handleDeleteFlow(flowId) {
    const { error } = await supabase.from('approval_flows').delete().eq('id', flowId)
    if (error) {
      const { error: retireError } = await supabase.from('approval_flows').update({ is_active: false }).eq('id', flowId)
      if (retireError) { showToast(t('adminflows_err_delete', { msg: retireError.message }), { tone: 'error' }); return }
      showToast(t('adminflows_retired'))
      fetchFlows()
      return
    }
    showToast(t('adminflows_deleted'))
    fetchFlows()
  }

  async function handleSaveSteps(flowId) {
    const { error: delError } = await supabase.from('approval_flow_steps').delete().eq('flow_id', flowId)
    if (delError) { showToast(t('adminflows_err_save', { msg: delError.message }), { tone: 'error' }); return }
    const validSteps = steps.filter(s => s.approver_id)
    if (validSteps.length > 0) {
      const { error: insError } = await supabase.from('approval_flow_steps').insert(
        validSteps.map(step => ({ flow_id: flowId, step_order: step.step_order, approver_id: step.approver_id }))
      )
      if (insError) { showToast(t('adminflows_err_save', { msg: insError.message }), { tone: 'error' }); return }
    }
    setEditSteps(null)
    fetchFlows()
  }

  return (
    <div>
      <PageHeader
        title={t('adminflows_title')}
        actions={isAdmin && <Button size="sm" onClick={() => setShowAdd(!showAdd)}>{t('adminflows_add')}</Button>}
      />

      {isAdmin && showAdd && (
        <Card className="admin-form-card">
          <h4 className="admin-form-card__title">{t('adminflows_add_title')}</h4>
          <div className="admin-form-grid admin-form-grid--single">
            <TextField label={t('adminflows_name')} required value={newFlow.name} onChange={e => setNewFlow(p => ({ ...p, name: e.target.value }))} placeholder={t('adminflows_name_placeholder')} />
            <TextField label={t('adminflows_description')} value={newFlow.description} onChange={e => setNewFlow(p => ({ ...p, description: e.target.value }))} placeholder={t('common_optional')} />
            <label className="admin-checkbox-label">
              <input type="checkbox" checked={newFlow.is_default} onChange={e => setNewFlow(p => ({ ...p, is_default: e.target.checked }))} />
              {t('adminflows_set_default')}
            </label>
          </div>
          <div className="admin-form-actions">
            <Button onClick={handleAddFlow}>{t('common_add')}</Button>
            <Button variant="text" onClick={() => setShowAdd(false)}>{t('common_cancel')}</Button>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="admin-list"><Skeleton height="100px" /><Skeleton height="100px" /></div>
      ) : (
        <div className="admin-list">
          {flows.map(flow => (
            <Card key={flow.id}>
              <div className="admin-flow__header">
                <div style={{ flex: 1 }}>
                  {editName === flow.id ? (
                    <div className="admin-flow__rename">
                      <TextField value={newName} onChange={e => setNewName(e.target.value)} autoFocus />
                      <Button size="sm" onClick={() => handleRenameFlow(flow.id)}>{t('common_save')}</Button>
                      <Button size="sm" variant="text" onClick={() => { setEditName(null); setNewName('') }}>{t('common_cancel')}</Button>
                    </div>
                  ) : (
                    <div className="admin-row__title">
                      {flow.name}
                      {flow.is_default && <Chip tone="info">{t('adminflows_default_chip')}</Chip>}
                    </div>
                  )}
                  {flow.description && <div className="admin-row__meta">{flow.description}</div>}
                </div>
                {isAdmin && editName !== flow.id && (
                  <div className="admin-flow__actions">
                    <Button size="sm" variant="outlined" onClick={() => {
                      setEditSteps(flow.id)
                      setSteps(flow.steps?.sort((a, b) => a.step_order - b.step_order).map(s => ({ step_order: s.step_order, approver_id: s.approver_id })) || [{ step_order: 1, approver_id: '' }])
                    }}>{t('adminflows_set_approvers')}</Button>
                    <Button size="sm" variant="outlined" onClick={() => { setEditName(flow.id); setNewName(flow.name) }}>{t('adminflows_rename')}</Button>
                    <Button size="sm" variant="danger-outlined" onClick={() => setConfirmTarget(flow)}>{t('common_delete')}</Button>
                  </div>
                )}
              </div>

              {flow.steps?.length > 0 && editSteps !== flow.id && (
                <div className="admin-flow__steps">
                  {flow.steps.sort((a, b) => a.step_order - b.step_order).map((step, i) => (
                    <span key={step.id} className="admin-flow__step">
                      {i > 0 && <span className="admin-flow__arrow">→</span>}
                      <Chip tone="info">{t('adminflows_step_with_name', { n: step.step_order, name: step.approver?.full_name || '—' })}</Chip>
                    </span>
                  ))}
                </div>
              )}

              {isAdmin && editSteps === flow.id && (
                <div className="admin-flow__edit-steps">
                  {steps.map((step, i) => (
                    <div key={i} className="admin-flow__edit-step-row">
                      <span className="admin-flow__step-label">{t('adminflows_step', { n: step.step_order })}</span>
                      <Select value={step.approver_id} onChange={e => {
                        const updated = [...steps]
                        updated[i].approver_id = e.target.value
                        setSteps(updated)
                      }} style={{ flex: 1 }}>
                        <option value="">{t('adminflows_select_approver')}</option>
                        {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                      </Select>
                      <Button size="sm" variant="danger-outlined" onClick={() => setSteps(steps.filter((_, idx) => idx !== i))}>{t('common_delete')}</Button>
                    </div>
                  ))}
                  <div className="admin-form-actions">
                    <Button size="sm" variant="outlined" onClick={() => setSteps([...steps, { step_order: steps.length + 1, approver_id: '' }])}>{t('adminflows_add_step')}</Button>
                    <Button size="sm" onClick={() => handleSaveSteps(flow.id)}>{t('common_save')}</Button>
                    <Button size="sm" variant="text" onClick={() => setEditSteps(null)}>{t('common_cancel')}</Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {confirmTarget && (
        <ConfirmDialog
          title={t('adminflows_delete_title')}
          description={t('adminflows_delete_desc')}
          confirmLabel={t('common_delete')}
          danger
          onConfirm={() => { handleDeleteFlow(confirmTarget.id); setConfirmTarget(null) }}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
    </div>
  )
}

// ===== 通知對象設定 =====
function NotificationTargets({ isAdmin }) {
  const { t } = useLanguage()
  const [targets, setTargets] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedUserId, setSelectedUserId] = useState('')
  const { showToast } = useToast()

  useEffect(() => { fetchTargets(); fetchUsers() }, [])

  async function fetchTargets() {
    const { data } = await supabase.from('notification_targets').select('*, user:users(full_name, email)')
    setTargets(data || [])
    setLoading(false)
  }

  async function fetchUsers() {
    const { data } = await supabase.from('users').select('id, full_name, email').eq('is_active', true)
    setUsers(data || [])
  }

  async function handleAdd() {
    if (!selectedUserId) { showToast(t('adminnotify_err_select'), { tone: 'error' }); return }
    await supabase.from('notification_targets').upsert({ user_id: selectedUserId, is_active: true })
    setSelectedUserId('')
    fetchTargets()
  }

  async function toggleTarget(target) {
    await supabase.from('notification_targets').update({ is_active: !target.is_active }).eq('id', target.id)
    fetchTargets()
  }

  async function handleRemove(id) {
    await supabase.from('notification_targets').delete().eq('id', id)
    fetchTargets()
  }

  const targetUserIds = targets.map(t => t.user_id)
  const availableUsers = users.filter(u => !targetUserIds.includes(u.id))

  return (
    <div>
      <PageHeader title={t('adminnotify_title')} />
      <p className="admin-hint">{t('adminnotify_hint')}</p>

      {isAdmin && (
        <div className="admin-inline-form">
          <Select value={selectedUserId} onChange={e => setSelectedUserId(e.target.value)} style={{ flex: 1 }}>
            <option value="">{t('adminnotify_select')}</option>
            {availableUsers.map(u => <option key={u.id} value={u.id}>{t('adminnotify_user_option', { name: u.full_name, email: u.email })}</option>)}
          </Select>
          <Button onClick={handleAdd}>{t('common_add')}</Button>
        </div>
      )}

      {loading ? (
        <div className="admin-list"><Skeleton height="64px" /></div>
      ) : (
        <div className="admin-list">
          {targets.map(target => (
            <Card key={target.id}>
              <div className="admin-row">
                <div>
                  <div className="admin-row__title">{target.user?.full_name}</div>
                  <div className="admin-row__meta">{target.user?.email}</div>
                </div>
                {isAdmin && (
                  <div className="admin-flow__actions">
                    <Button size="sm" variant="outlined" onClick={() => toggleTarget(target)}>{target.is_active ? t('adminnotify_disable') : t('adminnotify_enable')}</Button>
                    <Button size="sm" variant="danger-outlined" onClick={() => handleRemove(target.id)}>{t('adminnotify_remove')}</Button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== AdminPanel 主元件 =====
function AdminPanel({ userProfile }) {
  const location = useLocation()
  const { t } = useLanguage()

  const isAdmin = !!userProfile?.is_admin
  const isFinance = !!userProfile?.is_finance

  if (!isAdmin && !isFinance) return <Navigate to="/" replace />

  // 管理員 owns the system settings; 財務 owns 假期/入職日期. The two sets
  // are disjoint apart from 匯出報表, which both need. Someone flagged as
  // both simply sees the union.
  const tabs = []
  if (isAdmin) {
    tabs.push({ key: 'users', path: '/admin', label: t('adminusers_title') })
    tabs.push({ key: 'flows', path: '/admin/flows', label: t('adminflows_tab') })
    tabs.push({ key: 'notifications', path: '/admin/notifications', label: t('adminnotify_tab') })
    // 假別的英文名是「用字對不對」的問題，不是假期制度的問題，所以歸管理員。
    // 財務的「員工假期管理」也還看得到同一張卡片，兩邊共用同一個元件。
    tabs.push({ key: 'leave-type-names', path: '/admin/leave-type-names', label: t('ltnames_title') })
  }
  if (isFinance) {
    tabs.push({ key: 'leave-entitlements', path: '/admin/leave-entitlements', label: t('finleave_title') })
  }
  tabs.push({ key: 'export', path: '/admin/export', label: t('export_tab') })

  // Finance-only users have no 員工帳號管理, so the index route can't land there.
  const indexElement = isAdmin
    ? <UserManagement isAdmin={isAdmin} userProfile={userProfile} />
    : <Navigate to="/admin/leave-entitlements" replace />

  return (
    <div>
      <PageHeader title={t('nav_admin')} />
      <Tabs tabs={tabs.map(t => ({ ...t, to: t.path, active: location.pathname === t.path }))} />

      <Routes>
        <Route index element={indexElement} />
        {isAdmin && <Route path="flows" element={<FlowManagement isAdmin={isAdmin} />} />}
        {isAdmin && <Route path="notifications" element={<NotificationTargets isAdmin={isAdmin} />} />}
        {isAdmin && <Route path="leave-type-names" element={<LeaveTypeNames />} />}
        {isFinance && <Route path="leave-entitlements" element={<EmployeeLeaveManagement userProfile={userProfile} />} />}
        <Route path="change-password" element={<Navigate to="/settings" replace />} />
        <Route path="export" element={<ExportReport />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </div>
  )
}

export default AdminPanel
