import { useState, useEffect } from 'react'
import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { invokeFunction } from '../lib/api'
import ExportReport from './ExportReport'
import { Button, Card, Chip, ConfirmDialog, PageHeader, Select, Skeleton, Tabs, TextField } from '../components/ui'
import { useToast } from '../context/ToastContext'
import './AdminPanel.css'

const roleMap = { employee: '員工', deputy_supervisor: '副主管', supervisor: '主管', admin: '管理員', boss: '老闆' }
const roleTone = { employee: 'neutral', deputy_supervisor: 'warning', supervisor: 'warning', admin: 'info', boss: 'info' }

// ===== 員工管理 =====
function UserManagement({ isAdmin, userProfile }) {
  const [users, setUsers] = useState([])
  const [flows, setFlows] = useState([])
  const [annualLeaveMap, setAnnualLeaveMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [newUser, setNewUser] = useState({ email: '', full_name: '', role: 'employee', default_flow_id: '', hire_date: '' })
  const [showAdd, setShowAdd] = useState(false)
  const [saving, setSaving] = useState(false)
  const { showToast } = useToast()

  useEffect(() => { fetchUsers(); fetchFlows(); fetchAnnualLeave() }, [])

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

  async function fetchAnnualLeave() {
    const { data } = await supabase
      .from('annual_leave_summary')
      .select('*')
    setAnnualLeaveMap(data?.reduce((acc, item) => {
      acc[item.user_id] = item
      return acc
    }, {}) || {})
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
    if (newUser.default_flow_id && data?.user?.id) {
      await supabase.from('users').update({ default_flow_id: newUser.default_flow_id }).eq('id', data.user.id)
    }
    showToast('員工新增成功！預設密碼為 Welcome@123')
    setNewUser({ email: '', full_name: '', role: 'employee', default_flow_id: '', hire_date: '' })
    setShowAdd(false)
    setSaving(false)
    setTimeout(() => { fetchUsers(); fetchAnnualLeave() }, 1000)
  }

  async function handleUpdateUser(user) {
    setSaving(true)
    const { data, error } = await invokeFunction('manage-users', {
      action: 'update',
      userId: user.id,
      full_name: editing.full_name,
      role: editing.role,
      slack_user_id: editing.slack_user_id,
      is_active: editing.is_active,
      hire_date: editing.hire_date || null
    })
    if (error || data?.error) { showToast('更新失敗：' + (data?.error || error.message), { tone: 'error' }); setSaving(false); return }
    await supabase.from('users').update({ default_flow_id: editing.default_flow_id || null }).eq('id', user.id)
    setEditing(null)
    setSaving(false)
    showToast('已更新使用者')
    fetchUsers()
    fetchAnnualLeave()
  }

  return (
    <div>
      <PageHeader
        title="員工帳號管理"
        actions={isAdmin && <Button size="sm" onClick={() => setShowAdd(!showAdd)}>+ 新增員工</Button>}
      />

      {isAdmin && showAdd && (
        <Card className="admin-form-card">
          <h4 className="admin-form-card__title">新增員工</h4>
          <p className="admin-form-card__hint">新員工預設密碼為 <strong>Welcome@123</strong>，登入後可自行修改。</p>
          <div className="admin-form-grid">
            <TextField label="姓名" required value={newUser.full_name} onChange={e => setNewUser(p => ({ ...p, full_name: e.target.value }))} placeholder="請輸入姓名" />
            <TextField label="Email" required value={newUser.email} onChange={e => setNewUser(p => ({ ...p, email: e.target.value }))} placeholder="請輸入 Email" />
            <Select label="角色" required value={newUser.role} onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}>
              {Object.entries(roleMap).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
            <Select label="審核流程" value={newUser.default_flow_id} onChange={e => setNewUser(p => ({ ...p, default_flow_id: e.target.value }))}>
              <option value="">請選擇審核流程</option>
              {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
            <TextField label="入職日期" type="date" value={newUser.hire_date} onChange={e => setNewUser(p => ({ ...p, hire_date: e.target.value }))} />
          </div>
          <div className="admin-form-actions">
            <Button loading={saving} onClick={handleAddUser}>新增</Button>
            <Button variant="text" onClick={() => setShowAdd(false)}>取消</Button>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="admin-list"><Skeleton height="80px" /><Skeleton height="80px" /></div>
      ) : (
        <div className="admin-list">
          {users.map(user => (
            <Card key={user.id}>
              {isAdmin && editing?.id === user.id ? (
                <div>
                  <div className="admin-form-grid">
                    <TextField label="姓名" value={editing.full_name} onChange={e => setEditing(p => ({ ...p, full_name: e.target.value }))} />
                    <Select label="角色" value={editing.role} onChange={e => setEditing(p => ({ ...p, role: e.target.value }))}>
                      {Object.entries(roleMap).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </Select>
                    <Select label="審核流程" value={editing.default_flow_id || ''} onChange={e => setEditing(p => ({ ...p, default_flow_id: e.target.value }))}>
                      <option value="">請選擇審核流程</option>
                      {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </Select>
                    <TextField label="Slack User ID" value={editing.slack_user_id || ''} onChange={e => setEditing(p => ({ ...p, slack_user_id: e.target.value }))} placeholder="U0123ABCD" />
                    <TextField label="入職日期" type="date" value={editing.hire_date || ''} onChange={e => setEditing(p => ({ ...p, hire_date: e.target.value }))} />
                  </div>
                  <div className="admin-form-actions">
                    <Button loading={saving} onClick={() => handleUpdateUser(user)}>儲存</Button>
                    <Button variant="text" onClick={() => setEditing(null)}>取消</Button>
                    <label className="admin-checkbox-label">
                      <input type="checkbox" checked={editing.is_active} onChange={e => setEditing(p => ({ ...p, is_active: e.target.checked }))} />
                      帳號啟用
                    </label>
                  </div>
                </div>
              ) : (
                <div className="admin-row">
                  <div>
                    <div className="admin-row__title">
                      {user.full_name}
                      <Chip tone={roleTone[user.role] || 'neutral'}>{roleMap[user.role]}</Chip>
                      {!user.is_active && <Chip tone="error">停用</Chip>}
                    </div>
                    <div className="admin-row__meta">
                      {user.email}{user.slack_user_id && ` ｜ Slack: ${user.slack_user_id}`}
                    </div>
                    {user.default_flow?.name && (
                      <div className="admin-row__flow">審核流程：{user.default_flow.name}</div>
                    )}
                    {(isAdmin || userProfile?.role === 'boss') && user.hire_date && (
                      <div className="admin-row__service">
                        <span>入職：{user.hire_date}</span>
                        {annualLeaveMap[user.id] && (
                          <>
                            <span>
                              年資：
                              {annualLeaveMap[user.id].service_years > 0 ? `${annualLeaveMap[user.id].service_years}年` : ''}
                              {annualLeaveMap[user.id].service_months > 0 ? `${annualLeaveMap[user.id].service_months}個月` : ''}
                              {annualLeaveMap[user.id].service_days > 0 ? `${annualLeaveMap[user.id].service_days}天` : ''}
                            </span>
                            <span>今年特休：{annualLeaveMap[user.id].entitled_days} 天</span>
                            <span className={(annualLeaveMap[user.id].entitled_days - annualLeaveMap[user.id].used_days) <= 0 ? 'admin-row__remaining--low' : 'admin-row__remaining'}>
                              剩餘：{annualLeaveMap[user.id].entitled_days - annualLeaveMap[user.id].used_days} 天
                            </span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {isAdmin && <Button variant="outlined" size="sm" onClick={() => setEditing({ ...user })}>編輯</Button>}
                </div>
              )}
            </Card>
          ))}
        </div>
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
    let query = supabase
      .from('approval_flows')
      .select(`*, steps:approval_flow_steps(*, approver:users!approval_flow_steps_approver_id_fkey(full_name))`)
      .order('created_at')

    if (!isAdmin) {
      query = query.eq('is_active', true)
    }

    const { data } = await query
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
      await supabase.from('approval_flows').update({ is_default: false }).neq('id', '00000000-0000-0000-0000-000000000000')
    }
    await supabase.from('approval_flows').insert(newFlow)
    setNewFlow({ name: '', description: '', is_default: false })
    setShowAdd(false)
    fetchFlows()
  }

  async function handleRenameFlow(flowId) {
    if (!newName.trim()) { showToast('請填寫流程名稱', { tone: 'error' }); return }
    await supabase.from('approval_flows').update({ name: newName.trim() }).eq('id', flowId)
    setEditName(null)
    setNewName('')
    fetchFlows()
  }

  async function handleArchiveFlow(flowId, isActive) {
    await supabase.from('approval_flows').update({ is_active: !isActive }).eq('id', flowId)
    fetchFlows()
  }

  async function handleDeleteFlow(flowId) {
    const { error } = await supabase.from('approval_flows').delete().eq('id', flowId)
    if (error) {
      showToast('此流程有假單記錄，無法直接刪除。建議使用「封存」功能將其停用。', { tone: 'error' })
      return
    }
    fetchFlows()
  }

  async function handleSaveSteps(flowId) {
    await supabase.from('approval_flow_steps').delete().eq('flow_id', flowId)
    for (const step of steps) {
      if (step.approver_id) {
        await supabase.from('approval_flow_steps').insert({
          flow_id: flowId, step_order: step.step_order, approver_id: step.approver_id
        })
      }
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
            <Card key={flow.id} style={{ opacity: flow.is_active ? 1 : 0.6 }}>
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
                      {!flow.is_active && <Chip tone="neutral">已封存</Chip>}
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
                    <Button size="sm" variant="outlined" onClick={() => handleArchiveFlow(flow.id, flow.is_active)}>
                      {flow.is_active ? '封存' : '啟用'}
                    </Button>
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
          description="確定要刪除這個流程嗎？此操作無法復原。"
          confirmLabel="刪除"
          danger
          onConfirm={() => { handleDeleteFlow(confirmTarget.id); setConfirmTarget(null) }}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
    </div>
  )
}

// ===== 代理審核設定 =====
function DelegateManagement({ userProfile, isAdmin, isSupervisor }) {
  const [delegates, setDelegates] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newDelegate, setNewDelegate] = useState({ original_approver_id: '', delegate_user_id: '', start_date: '', end_date: '' })
  const { showToast } = useToast()

  useEffect(() => { fetchDelegates(); fetchUsers() }, [])

  async function fetchDelegates() {
    let query = supabase
      .from('approval_delegates')
      .select(`*, original:users!approval_delegates_original_approver_id_fkey(full_name), delegate:users!approval_delegates_delegate_user_id_fkey(full_name)`)
      .order('created_at', { ascending: false })

    if (isSupervisor && !isAdmin) {
      query = query.eq('original_approver_id', userProfile.id)
    }

    const { data } = await query
    setDelegates(data || [])
    setLoading(false)
  }

  async function fetchUsers() {
    const { data } = await supabase.from('users').select('id, full_name').eq('is_active', true)
    setUsers(data || [])
  }

  async function handleAdd() {
    if (!newDelegate.delegate_user_id || !newDelegate.start_date || !newDelegate.end_date) {
      showToast('請填寫所有欄位', { tone: 'error' }); return
    }
    const originalId = isAdmin && !isSupervisor ? newDelegate.original_approver_id : userProfile.id
    if (!originalId) { showToast('請選擇被代理的主管', { tone: 'error' }); return }
    await supabase.from('approval_delegates').insert({
      original_approver_id: originalId,
      delegate_user_id: newDelegate.delegate_user_id,
      start_date: newDelegate.start_date,
      end_date: newDelegate.end_date,
      created_by: userProfile.id
    })
    setNewDelegate({ original_approver_id: '', delegate_user_id: '', start_date: '', end_date: '' })
    setShowAdd(false)
    fetchDelegates()
  }

  async function toggleActive(delegate) {
    await supabase.from('approval_delegates').update({ is_active: !delegate.is_active }).eq('id', delegate.id)
    fetchDelegates()
  }

  return (
    <div>
      <PageHeader title="代理審核設定" actions={<Button size="sm" onClick={() => setShowAdd(!showAdd)}>+ 新增代理</Button>} />

      {showAdd && (
        <Card className="admin-form-card">
          <h4 className="admin-form-card__title">新增代理設定</h4>
          <div className="admin-form-grid">
            {isAdmin && (
              <Select label="被代理的主管" required value={newDelegate.original_approver_id} onChange={e => setNewDelegate(p => ({ ...p, original_approver_id: e.target.value }))}>
                <option value="">請選擇</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </Select>
            )}
            <Select label="代理人" required value={newDelegate.delegate_user_id} onChange={e => setNewDelegate(p => ({ ...p, delegate_user_id: e.target.value }))}>
              <option value="">請選擇</option>
              {users.filter(u => u.id !== (isAdmin ? newDelegate.original_approver_id : userProfile.id)).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </Select>
            <TextField label="開始日期" required type="date" value={newDelegate.start_date} onChange={e => setNewDelegate(p => ({ ...p, start_date: e.target.value }))} />
            <TextField label="結束日期" required type="date" value={newDelegate.end_date} min={newDelegate.start_date} onChange={e => setNewDelegate(p => ({ ...p, end_date: e.target.value }))} />
          </div>
          <div className="admin-form-actions">
            <Button onClick={handleAdd}>新增</Button>
            <Button variant="text" onClick={() => setShowAdd(false)}>取消</Button>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="admin-list"><Skeleton height="72px" /></div>
      ) : (
        <div className="admin-list">
          {delegates.map(d => (
            <Card key={d.id} style={{ opacity: d.is_active ? 1 : 0.6 }}>
              <div className="admin-row">
                <div>
                  <div className="admin-row__title">{d.original?.full_name} → 由 {d.delegate?.full_name} 代理</div>
                  <div className="admin-row__meta">{d.start_date} ～ {d.end_date}</div>
                </div>
                <div className="admin-flow__actions">
                  <Chip tone={d.is_active ? 'success' : 'neutral'}>{d.is_active ? '啟用中' : '已停用'}</Chip>
                  <Button size="sm" variant="outlined" onClick={() => toggleActive(d)}>{d.is_active ? '停用' : '啟用'}</Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
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

// ===== AdminPanel 主元件 =====
function AdminPanel({ userProfile }) {
  const location = useLocation()

  const isAdmin = userProfile?.role === 'admin' || userProfile?.role === 'boss'
  const isSupervisor = userProfile?.role === 'supervisor'

  const tabs = []

  if (isAdmin) {
    tabs.push({ key: 'users', path: '/admin', label: '員工管理' })
    tabs.push({ key: 'flows', path: '/admin/flows', label: '審核流程' })
    tabs.push({ key: 'notifications', path: '/admin/notifications', label: '通知對象' })
  } else {
    tabs.push({ key: 'flows', path: '/admin/flows', label: '審核流程' })
    tabs.push({ key: 'notifications', path: '/admin/notifications', label: '通知對象' })
  }

  if (isAdmin || isSupervisor) {
    tabs.push({ key: 'delegates', path: '/admin/delegates', label: '代理審核設定' })
  }
  if (isAdmin) {
    tabs.push({ key: 'export', path: '/admin/export', label: '匯出報表' })
  }

  return (
    <div>
      <PageHeader title="管理後台" />
      <Tabs tabs={tabs.map(t => ({ ...t, to: t.path, active: location.pathname === t.path }))} />

      <Routes>
        <Route index element={
          isAdmin
            ? <UserManagement isAdmin={isAdmin} userProfile={userProfile} />
            : <Navigate to="flows" replace />
        } />
        <Route path="flows" element={<FlowManagement isAdmin={isAdmin} />} />
        <Route path="notifications" element={<NotificationTargets isAdmin={isAdmin} />} />
        <Route path="change-password" element={<Navigate to="/settings" replace />} />
        {(isAdmin || isSupervisor) && (
          <Route path="delegates" element={<DelegateManagement userProfile={userProfile} isAdmin={isAdmin} isSupervisor={isSupervisor} />} />
        )}
        {isAdmin && (
          <Route path="export" element={<ExportReport />} />
        )}
      </Routes>
    </div>
  )
}

export default AdminPanel
