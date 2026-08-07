import { useState, useEffect } from 'react'
import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { invokeFunction } from '../lib/api'
import ExportReport from './ExportReport'
import { Button, Card, Chip, ConfirmDialog, Dialog, PageHeader, Select, Skeleton, Tabs, TextField } from '../components/ui'
import { useToast } from '../context/ToastContext'
import './AdminPanel.css'

const roleMap = { employee: '員工', deputy_supervisor: '副主管', supervisor: '主管', boss: '老闆' }
const roleTone = { employee: 'neutral', deputy_supervisor: 'warning', supervisor: 'warning', boss: 'info' }

// ===== 員工管理 =====
const emptyNewUser = { email: '', full_name: '', english_name: '', role: 'employee', default_flow_id: '', hire_date: '', is_admin: false, department: '', job_title: '' }

function UserManagement({ isAdmin, userProfile }) {
  const [users, setUsers] = useState([])
  const [flows, setFlows] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [newUser, setNewUser] = useState(emptyNewUser)
  const [showAdd, setShowAdd] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmToggle, setConfirmToggle] = useState(null)
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
    if (!newUser.email || !newUser.full_name) { showToast('請填寫姓名和 Email', { tone: 'error' }); return }
    setSaving(true)
    const { data, error } = await invokeFunction('manage-users', {
      action: 'create',
      email: newUser.email,
      full_name: newUser.full_name,
      role: newUser.role,
      password: 'Welcome@123',
      hire_date: newUser.hire_date || null
    })
    if (error || data?.error) { showToast('新增失敗：' + (data?.error || error.message), { tone: 'error' }); setSaving(false); return }
    if (data?.user?.id) {
      await supabase.from('users').update({
        default_flow_id: newUser.default_flow_id || null,
        is_admin: newUser.is_admin,
        department: newUser.department || null,
        job_title: newUser.job_title || null,
        english_name: newUser.english_name || null
      }).eq('id', data.user.id)
    }
    showToast('員工新增成功！預設密碼為 Welcome@123')
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
      hire_date: editing.hire_date || null
    })
    if (error || data?.error) { showToast('更新失敗：' + (data?.error || error.message), { tone: 'error' }); setSaving(false); return }
    await supabase.from('users').update({
      default_flow_id: editing.default_flow_id || null,
      is_admin: editing.is_admin,
      department: editing.department || null,
      job_title: editing.job_title || null,
      english_name: editing.english_name || null
    }).eq('id', editing.id)
    setEditing(null)
    setSaving(false)
    showToast('已更新使用者')
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
    if (error || data?.error) { showToast('操作失敗：' + (data?.error || error.message), { tone: 'error' }); setSaving(false); return }
    setSaving(false)
    showToast(confirmToggle.is_active ? '已刪除帳號' : '已恢復帳號')
    setConfirmToggle(null)
    setEditing(null)
    fetchUsers()
  }

  if (loading) return <div><PageHeader title="員工帳號管理" /><Skeleton height="200px" /></div>

  return (
    <div>
      <PageHeader
        title="員工帳號管理"
        actions={isAdmin && <Button size="sm" onClick={() => { setNewUser(emptyNewUser); setShowAdd(true) }}>+ 新增員工</Button>}
      />

      {users.length === 0 ? (
        <Card><p className="admin-hint">尚無員工資料</p></Card>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr><th>姓名</th><th>部門</th><th>職稱</th><th>角色</th><th>Slack ID</th><th>入職日期</th><th>審核流程</th>{isAdmin && <th>操作</th>}</tr>
            </thead>
            <tbody>
              {users.map(user => (
                <tr key={user.id} style={{ opacity: user.is_active ? 1 : 0.6 }}>
                  <td>
                    {user.full_name}{user.english_name && ` (${user.english_name})`}
                    {user.is_admin && <> <Chip tone="info">管理員</Chip></>}
                    {!user.is_active && <> <Chip tone="error">已刪除</Chip></>}
                  </td>
                  <td>{user.department || '—'}</td>
                  <td>{user.job_title || '—'}</td>
                  <td><Chip tone={roleTone[user.role] || 'neutral'}>{roleMap[user.role]}</Chip></td>
                  <td>{user.slack_user_id || '—'}</td>
                  <td>{user.hire_date || '—'}</td>
                  <td>{user.default_flow?.name || '—'}</td>
                  {isAdmin && (
                    <td><Button size="sm" variant="outlined" onClick={() => setEditing({ ...user })}>編輯</Button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isAdmin && showAdd && (
        <Dialog
          title="新增員工"
          labelledBy="add-user-dialog-title"
          onClose={() => setShowAdd(false)}
          actions={(
            <>
              <Button variant="text" onClick={() => setShowAdd(false)}>取消</Button>
              <Button loading={saving} onClick={handleAddUser}>新增</Button>
            </>
          )}
        >
          <p className="admin-form-card__hint">新員工預設密碼為 <strong>Welcome@123</strong>，登入後可自行修改。</p>
          <div className="admin-form-grid">
            <TextField label="中文姓名" required value={newUser.full_name} onChange={e => setNewUser(p => ({ ...p, full_name: e.target.value }))} placeholder="請輸入中文姓名" />
            <TextField label="英文姓名" value={newUser.english_name} onChange={e => setNewUser(p => ({ ...p, english_name: e.target.value }))} placeholder="選填" />
            <TextField label="Email" required value={newUser.email} onChange={e => setNewUser(p => ({ ...p, email: e.target.value }))} placeholder="請輸入 Email" />
            <Select label="角色" required value={newUser.role} onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}>
              {Object.entries(roleMap).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
            <Select label="審核流程" value={newUser.default_flow_id} onChange={e => setNewUser(p => ({ ...p, default_flow_id: e.target.value }))}>
              <option value="">請選擇審核流程</option>
              {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
            <TextField label="入職日期" type="date" value={newUser.hire_date} onChange={e => setNewUser(p => ({ ...p, hire_date: e.target.value }))} />
            <TextField label="部門" value={newUser.department} onChange={e => setNewUser(p => ({ ...p, department: e.target.value }))} placeholder="選填" />
            <TextField label="職稱" value={newUser.job_title} onChange={e => setNewUser(p => ({ ...p, job_title: e.target.value }))} placeholder="選填" />
          </div>
          <label className="admin-checkbox-label">
            <input type="checkbox" checked={newUser.is_admin} onChange={e => setNewUser(p => ({ ...p, is_admin: e.target.checked }))} />
            同時為管理員（管理員可與其他角色重疊）
          </label>
        </Dialog>
      )}

      {isAdmin && editing && (
        <Dialog
          title={`編輯員工 — ${editing.full_name}`}
          labelledBy="edit-user-dialog-title"
          onClose={() => setEditing(null)}
          actions={(
            <>
              <Button
                variant={editing.is_active ? 'danger-outlined' : 'outlined'}
                onClick={() => setConfirmToggle(editing)}
              >
                {editing.is_active ? '刪除帳號' : '恢復帳號'}
              </Button>
              <Button variant="text" onClick={() => setEditing(null)}>取消</Button>
              <Button loading={saving} onClick={handleUpdateUser}>儲存</Button>
            </>
          )}
        >
          <div className="admin-form-grid">
            <TextField label="中文姓名" value={editing.full_name} onChange={e => setEditing(p => ({ ...p, full_name: e.target.value }))} />
            <TextField label="英文姓名" value={editing.english_name || ''} onChange={e => setEditing(p => ({ ...p, english_name: e.target.value }))} placeholder="選填" />
            <TextField label="Email" value={editing.email || ''} disabled />
            <Select label="角色" value={editing.role} onChange={e => setEditing(p => ({ ...p, role: e.target.value }))}>
              {Object.entries(roleMap).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
            <Select label="審核流程" value={editing.default_flow_id || ''} onChange={e => setEditing(p => ({ ...p, default_flow_id: e.target.value }))}>
              <option value="">請選擇審核流程</option>
              {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
            <TextField label="Slack User ID" value={editing.slack_user_id || ''} onChange={e => setEditing(p => ({ ...p, slack_user_id: e.target.value }))} placeholder="U0123ABCD" />
            <TextField label="入職日期" type="date" value={editing.hire_date || ''} onChange={e => setEditing(p => ({ ...p, hire_date: e.target.value }))} />
            <TextField label="部門" value={editing.department || ''} onChange={e => setEditing(p => ({ ...p, department: e.target.value }))} placeholder="選填" />
            <TextField label="職稱" value={editing.job_title || ''} onChange={e => setEditing(p => ({ ...p, job_title: e.target.value }))} placeholder="選填" />
          </div>
          <label className="admin-checkbox-label">
            <input type="checkbox" checked={!!editing.is_admin} onChange={e => setEditing(p => ({ ...p, is_admin: e.target.checked }))} />
            同時為管理員
          </label>
        </Dialog>
      )}

      {confirmToggle && (
        <ConfirmDialog
          title={confirmToggle.is_active ? '刪除帳號' : '恢復帳號'}
          description={confirmToggle.is_active
            ? `確定要刪除 ${confirmToggle.full_name} 的帳號嗎？這個人所有的歷史請假／考核紀錄都會保留，只是帳號會停用、不再出現在可選名單中。之後仍可以在這裡重新恢復。`
            : `確定要恢復 ${confirmToggle.full_name} 的帳號嗎？`}
          confirmLabel={confirmToggle.is_active ? '刪除' : '恢復'}
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
    const { data } = await supabase.from('users').select('id, full_name, role').eq('is_active', true).in('role', ['supervisor', 'admin'])
    setUsers(data || [])
  }

  async function handleAddFlow() {
    if (!newFlow.name) { showToast('請填寫流程名稱', { tone: 'error' }); return }
    if (newFlow.is_default) {
      const { error: clearError } = await supabase.from('approval_flows').update({ is_default: false }).neq('id', '00000000-0000-0000-0000-000000000000')
      if (clearError) { showToast('新增失敗：' + clearError.message, { tone: 'error' }); return }
    }
    const { error } = await supabase.from('approval_flows').insert({ ...newFlow, is_active: true })
    if (error) { showToast('新增失敗：' + error.message, { tone: 'error' }); return }
    setNewFlow({ name: '', description: '', is_default: false })
    setShowAdd(false)
    fetchFlows()
  }

  async function handleRenameFlow(flowId) {
    if (!newName.trim()) { showToast('請填寫流程名稱', { tone: 'error' }); return }
    const { error } = await supabase.from('approval_flows').update({ name: newName.trim() }).eq('id', flowId)
    if (error) { showToast('重新命名失敗：' + error.message, { tone: 'error' }); return }
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
      if (retireError) { showToast('刪除失敗：' + retireError.message, { tone: 'error' }); return }
      showToast('此流程仍有歷史假單紀錄在使用，已從清單移除（歷史資料保留）')
      fetchFlows()
      return
    }
    showToast('已刪除流程')
    fetchFlows()
  }

  async function handleSaveSteps(flowId) {
    const { error: delError } = await supabase.from('approval_flow_steps').delete().eq('flow_id', flowId)
    if (delError) { showToast('儲存失敗：' + delError.message, { tone: 'error' }); return }
    const validSteps = steps.filter(s => s.approver_id)
    if (validSteps.length > 0) {
      const { error: insError } = await supabase.from('approval_flow_steps').insert(
        validSteps.map(step => ({ flow_id: flowId, step_order: step.step_order, approver_id: step.approver_id }))
      )
      if (insError) { showToast('儲存失敗：' + insError.message, { tone: 'error' }); return }
    }
    setEditSteps(null)
    fetchFlows()
  }

  return (
    <div>
      <PageHeader
        title="審核流程管理"
        actions={isAdmin && <Button size="sm" onClick={() => setShowAdd(!showAdd)}>+ 新增流程</Button>}
      />

      {isAdmin && showAdd && (
        <Card className="admin-form-card">
          <h4 className="admin-form-card__title">新增審核流程</h4>
          <div className="admin-form-grid admin-form-grid--single">
            <TextField label="流程名稱" required value={newFlow.name} onChange={e => setNewFlow(p => ({ ...p, name: e.target.value }))} placeholder="例：一般請假流程" />
            <TextField label="說明" value={newFlow.description} onChange={e => setNewFlow(p => ({ ...p, description: e.target.value }))} placeholder="選填" />
            <label className="admin-checkbox-label">
              <input type="checkbox" checked={newFlow.is_default} onChange={e => setNewFlow(p => ({ ...p, is_default: e.target.checked }))} />
              設為預設流程
            </label>
          </div>
          <div className="admin-form-actions">
            <Button onClick={handleAddFlow}>新增</Button>
            <Button variant="text" onClick={() => setShowAdd(false)}>取消</Button>
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
                      <Button size="sm" onClick={() => handleRenameFlow(flow.id)}>儲存</Button>
                      <Button size="sm" variant="text" onClick={() => { setEditName(null); setNewName('') }}>取消</Button>
                    </div>
                  ) : (
                    <div className="admin-row__title">
                      {flow.name}
                      {flow.is_default && <Chip tone="info">預設</Chip>}
                    </div>
                  )}
                  {flow.description && <div className="admin-row__meta">{flow.description}</div>}
                </div>
                {isAdmin && editName !== flow.id && (
                  <div className="admin-flow__actions">
                    <Button size="sm" variant="outlined" onClick={() => {
                      setEditSteps(flow.id)
                      setSteps(flow.steps?.sort((a, b) => a.step_order - b.step_order).map(s => ({ step_order: s.step_order, approver_id: s.approver_id })) || [{ step_order: 1, approver_id: '' }])
                    }}>設定審核人</Button>
                    <Button size="sm" variant="outlined" onClick={() => { setEditName(flow.id); setNewName(flow.name) }}>重新命名</Button>
                    <Button size="sm" variant="danger-outlined" onClick={() => setConfirmTarget(flow)}>刪除</Button>
                  </div>
                )}
              </div>

              {flow.steps?.length > 0 && editSteps !== flow.id && (
                <div className="admin-flow__steps">
                  {flow.steps.sort((a, b) => a.step_order - b.step_order).map((step, i) => (
                    <span key={step.id} className="admin-flow__step">
                      {i > 0 && <span className="admin-flow__arrow">→</span>}
                      <Chip tone="info">第{step.step_order}關：{step.approver?.full_name}</Chip>
                    </span>
                  ))}
                </div>
              )}

              {isAdmin && editSteps === flow.id && (
                <div className="admin-flow__edit-steps">
                  {steps.map((step, i) => (
                    <div key={i} className="admin-flow__edit-step-row">
                      <span className="admin-flow__step-label">第{step.step_order}關</span>
                      <Select value={step.approver_id} onChange={e => {
                        const updated = [...steps]
                        updated[i].approver_id = e.target.value
                        setSteps(updated)
                      }} style={{ flex: 1 }}>
                        <option value="">請選擇審核人</option>
                        {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                      </Select>
                      <Button size="sm" variant="danger-outlined" onClick={() => setSteps(steps.filter((_, idx) => idx !== i))}>刪除</Button>
                    </div>
                  ))}
                  <div className="admin-form-actions">
                    <Button size="sm" variant="outlined" onClick={() => setSteps([...steps, { step_order: steps.length + 1, approver_id: '' }])}>+ 新增關卡</Button>
                    <Button size="sm" onClick={() => handleSaveSteps(flow.id)}>儲存</Button>
                    <Button size="sm" variant="text" onClick={() => setEditSteps(null)}>取消</Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {confirmTarget && (
        <ConfirmDialog
          title="刪除審核流程"
          description="確定要刪除這個流程嗎？如果這個流程完全沒有歷史假單紀錄，會直接永久刪除；如果曾經被使用過，系統會保留歷史資料、但這個流程會從清單移除、無法再選用。此操作無法復原。"
          confirmLabel="刪除"
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
    if (!selectedUserId) { showToast('請選擇人員', { tone: 'error' }); return }
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
      <PageHeader title="核准通知對象" />
      <p className="admin-hint">假單核准後，除了申請人之外，以下人員也會收到 Slack 通知。</p>

      {isAdmin && (
        <div className="admin-inline-form">
          <Select value={selectedUserId} onChange={e => setSelectedUserId(e.target.value)} style={{ flex: 1 }}>
            <option value="">選擇要加入的人員</option>
            {availableUsers.map(u => <option key={u.id} value={u.id}>{u.full_name}（{u.email}）</option>)}
          </Select>
          <Button onClick={handleAdd}>新增</Button>
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
                    <Button size="sm" variant="outlined" onClick={() => toggleTarget(target)}>{target.is_active ? '停用' : '啟用'}</Button>
                    <Button size="sm" variant="danger-outlined" onClick={() => handleRemove(target.id)}>移除</Button>
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

// ===== 假別管理（各假別年度可使用時數）=====
function LeaveTypeManagement() {
  const [types, setTypes] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [saving, setSaving] = useState(false)
  const { showToast } = useToast()

  useEffect(() => { fetchTypes() }, [])

  async function fetchTypes() {
    const { data } = await supabase.from('leave_types').select('*').order('name')
    setTypes(data || [])
    setLoading(false)
  }

  function startEdit(t) {
    setEditingId(t.id)
    setEditValue(t.annual_quota_hours != null ? String(t.annual_quota_hours) : '')
  }

  async function handleSave(t) {
    setSaving(true)
    const value = editValue.trim() === '' ? null : Number(editValue)
    if (value !== null && (Number.isNaN(value) || value < 0)) {
      showToast('請輸入有效的時數', { tone: 'error' })
      setSaving(false)
      return
    }
    const { error } = await supabase.from('leave_types').update({ annual_quota_hours: value }).eq('id', t.id)
    if (error) {
      showToast('儲存失敗：' + error.message, { tone: 'error' })
    } else {
      showToast('已更新')
      setEditingId(null)
      fetchTypes()
    }
    setSaving(false)
  }

  if (loading) return <div><PageHeader title="假別管理" /><Skeleton height="120px" /></div>

  return (
    <div>
      <PageHeader title="假別管理" />
      <p className="admin-hint">設定各假別每年度可使用的時數，「假單管理」的假期明細會依此顯示。留白表示依勞基法（不顯示固定時數）。</p>
      <div className="admin-list">
        {types.map(t => (
          <Card key={t.id}>
            <div className="admin-row">
              <div>
                <div className="admin-row__title">
                  {t.name}
                  {!t.is_active && <Chip tone="error">停用</Chip>}
                </div>
                <div className="admin-row__meta">
                  年度可使用時數：{editingId === t.id ? (
                    <TextField
                      type="number"
                      min="0"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      placeholder="留白＝依勞基法"
                      style={{ display: 'inline-block', width: '140px', marginLeft: 'var(--space-100)' }}
                    />
                  ) : (
                    t.annual_quota_hours != null ? `${t.annual_quota_hours} 小時` : '依勞基法（未設定）'
                  )}
                </div>
              </div>
              {editingId === t.id ? (
                <div className="admin-form-actions">
                  <Button size="sm" loading={saving} onClick={() => handleSave(t)}>儲存</Button>
                  <Button size="sm" variant="text" onClick={() => setEditingId(null)}>取消</Button>
                </div>
              ) : (
                <Button size="sm" variant="outlined" onClick={() => startEdit(t)}>編輯</Button>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ===== AdminPanel 主元件 =====
function AdminPanel({ userProfile }) {
  const location = useLocation()

  const isAdmin = !!userProfile?.is_admin

  // 代理審核設定 was the only thing a non-admin supervisor could reach in
  // here; now that it's removed, 管理後台 is admin-only.
  if (!isAdmin) return <Navigate to="/" replace />

  const tabs = [
    { key: 'users', path: '/admin', label: '員工帳號管理' },
    { key: 'flows', path: '/admin/flows', label: '審核流程' },
    { key: 'notifications', path: '/admin/notifications', label: '通知對象' },
    { key: 'leave-types', path: '/admin/leave-types', label: '假別管理' },
    { key: 'export', path: '/admin/export', label: '匯出報表' },
  ]

  return (
    <div>
      <PageHeader title="管理後台" />
      <Tabs tabs={tabs.map(t => ({ ...t, to: t.path, active: location.pathname === t.path }))} />

      <Routes>
        <Route index element={<UserManagement isAdmin={isAdmin} userProfile={userProfile} />} />
        <Route path="flows" element={<FlowManagement isAdmin={isAdmin} />} />
        <Route path="notifications" element={<NotificationTargets isAdmin={isAdmin} />} />
        <Route path="leave-types" element={<LeaveTypeManagement />} />
        <Route path="change-password" element={<Navigate to="/settings" replace />} />
        <Route path="export" element={<ExportReport />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </div>
  )
}

export default AdminPanel
