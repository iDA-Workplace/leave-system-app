import { useState, useEffect } from 'react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { invokeFunction } from '../lib/api'

// ===== 員工管理 =====
function UserManagement() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [newUser, setNewUser] = useState({ email: '', full_name: '', role: 'employee' })
  const [showAdd, setShowAdd] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => { fetchUsers() }, [])

  async function fetchUsers() {
    const { data } = await supabase
      .from('users')
      .select('*')
      .order('full_name')
    setUsers(data || [])
    setLoading(false)
  }

  async function handleAddUser() {
    if (!newUser.email || !newUser.full_name) {
      alert('請填寫姓名和 Email')
      return
    }
    setSaving(true)
    const { data, error } = await invokeFunction('manage-users', {
      action: 'create',
      email: newUser.email,
      full_name: newUser.full_name,
      role: newUser.role,
      password: 'Welcome@123'
    })
    if (error || data?.error) {
      alert('新增失敗：' + (data?.error || error.message))
      setSaving(false)
      return
    }
    alert('員工新增成功！預設密碼為 Welcome@123')
    setNewUser({ email: '', full_name: '', role: 'employee' })
    setShowAdd(false)
    setSaving(false)
    setTimeout(() => fetchUsers(), 1000)
  }

  async function handleUpdateUser(user) {
    setSaving(true)
    const { data, error } = await invokeFunction('manage-users', {
      action: 'update',
      userId: user.id,
      full_name: editing.full_name,
      role: editing.role,
      slack_user_id: editing.slack_user_id,
      is_active: editing.is_active
    })
    if (error || data?.error) {
      alert('更新失敗：' + (data?.error || error.message))
      setSaving(false)
      return
    }
    setEditing(null)
    setSaving(false)
    fetchUsers()
  }

  const roleMap = { employee: '員工', supervisor: '主管', admin: '管理員' }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3 style={{ margin: 0, color: '#1f2937' }}>員工帳號管理</h3>
        <button onClick={() => setShowAdd(!showAdd)} style={btnPrimary}>+ 新增員工</button>
      </div>

      {showAdd && (
        <div style={cardStyle}>
          <h4 style={{ marginTop: 0, color: '#1f2937' }}>新增員工</h4>
          <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '16px' }}>
            新員工預設密碼為 <strong>Welcome@123</strong>，登入後可自行修改。
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>姓名 *</label>
              <input value={newUser.full_name} onChange={e => setNewUser(p => ({ ...p, full_name: e.target.value }))} style={inputStyle} placeholder="請輸入姓名" />
            </div>
            <div>
              <label style={labelStyle}>Email *</label>
              <input value={newUser.email} onChange={e => setNewUser(p => ({ ...p, email: e.target.value }))} style={inputStyle} placeholder="請輸入 Email" />
            </div>
            <div>
              <label style={labelStyle}>角色 *</label>
              <select value={newUser.role} onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))} style={inputStyle}>
                <option value="employee">員工</option>
                <option value="supervisor">主管</option>
                <option value="admin">管理員</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={handleAddUser} disabled={saving} style={btnPrimary}>{saving ? '新增中...' : '新增'}</button>
            <button onClick={() => setShowAdd(false)} style={btnSecondary}>取消</button>
          </div>
        </div>
      )}

      {loading ? <p>載入中...</p> : (
        <div style={{ display: 'grid', gap: '8px' }}>
          {users.map(user => (
            <div key={user.id} style={{ ...cardStyle, padding: '16px 20px' }}>
              {editing?.id === user.id ? (
                <div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                    <div>
                      <label style={labelStyle}>姓名</label>
                      <input value={editing.full_name} onChange={e => setEditing(p => ({ ...p, full_name: e.target.value }))} style={inputStyle} />
                    </div>
                    <div>
                      <label style={labelStyle}>角色</label>
                      <select value={editing.role} onChange={e => setEditing(p => ({ ...p, role: e.target.value }))} style={inputStyle}>
                        <option value="employee">員工</option>
                        <option value="supervisor">主管</option>
                        <option value="admin">管理員</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>Slack User ID</label>
                      <input value={editing.slack_user_id || ''} onChange={e => setEditing(p => ({ ...p, slack_user_id: e.target.value }))} style={inputStyle} placeholder="U0123ABCD" />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button onClick={() => handleUpdateUser(user)} disabled={saving} style={btnPrimary}>{saving ? '儲存中...' : '儲存'}</button>
                    <button onClick={() => setEditing(null)} style={btnSecondary}>取消</button>
                    <label style={{ fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={editing.is_active} onChange={e => setEditing(p => ({ ...p, is_active: e.target.checked }))} />
                      帳號啟用
                    </label>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: '600', color: '#1f2937', marginBottom: '4px' }}>
                      {user.full_name}
                      <span style={{
                        marginLeft: '8px',
                        backgroundColor: user.role === 'admin' ? '#EEF2FF' : user.role === 'supervisor' ? '#FEF3C7' : '#F3F4F6',
                        color: user.role === 'admin' ? '#4F46E5' : user.role === 'supervisor' ? '#D97706' : '#6B7280',
                        padding: '2px 8px', borderRadius: '4px', fontSize: '12px'
                      }}>
                        {roleMap[user.role]}
                      </span>
                      {!user.is_active && (
                        <span style={{ marginLeft: '8px', backgroundColor: '#FEE2E2', color: '#EF4444', padding: '2px 8px', borderRadius: '4px', fontSize: '12px' }}>停用</span>
                      )}
                    </div>
                    <div style={{ fontSize: '13px', color: '#6b7280' }}>
                      {user.email}{user.slack_user_id && ` ｜ Slack: ${user.slack_user_id}`}
                    </div>
                  </div>
                  <button onClick={() => setEditing({ ...user })} style={btnSecondary}>編輯</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 審核流程管理 =====
function FlowManagement() {
  const [flows, setFlows] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newFlow, setNewFlow] = useState({ name: '', description: '', is_default: false })
  const [editSteps, setEditSteps] = useState(null)
  const [steps, setSteps] = useState([])

  useEffect(() => { fetchFlows(); fetchUsers() }, [])

  async function fetchFlows() {
    const { data } = await supabase
      .from('approval_flows')
      .select(`*, steps:approval_flow_steps(*, approver:users!approval_flow_steps_approver_id_fkey(full_name))`)
      .order('created_at')
    setFlows(data || [])
    setLoading(false)
  }

  async function fetchUsers() {
    const { data } = await supabase
      .from('users')
      .select('id, full_name, role')
      .eq('is_active', true)
      .in('role', ['supervisor', 'admin'])
    setUsers(data || [])
  }

  async function handleAddFlow() {
    if (!newFlow.name) { alert('請填寫流程名稱'); return }
    if (newFlow.is_default) {
      await supabase.from('approval_flows').update({ is_default: false }).neq('id', '00000000-0000-0000-0000-000000000000')
    }
    await supabase.from('approval_flows').insert(newFlow)
    setNewFlow({ name: '', description: '', is_default: false })
    setShowAdd(false)
    fetchFlows()
  }

  async function handleSaveSteps(flowId) {
    await supabase.from('approval_flow_steps').delete().eq('flow_id', flowId)
    for (const step of steps) {
      if (step.approver_id) {
        await supabase.from('approval_flow_steps').insert({
          flow_id: flowId,
          step_order: step.step_order,
          approver_id: step.approver_id
        })
      }
    }
    setEditSteps(null)
    fetchFlows()
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3 style={{ margin: 0, color: '#1f2937' }}>審核流程管理</h3>
        <button onClick={() => setShowAdd(!showAdd)} style={btnPrimary}>+ 新增流程</button>
      </div>

      {showAdd && (
        <div style={cardStyle}>
          <h4 style={{ marginTop: 0 }}>新增審核流程</h4>
          <div style={{ display: 'grid', gap: '12px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>流程名稱 *</label>
              <input value={newFlow.name} onChange={e => setNewFlow(p => ({ ...p, name: e.target.value }))} style={inputStyle} placeholder="例：一般請假流程" />
            </div>
            <div>
              <label style={labelStyle}>說明</label>
              <input value={newFlow.description} onChange={e => setNewFlow(p => ({ ...p, description: e.target.value }))} style={inputStyle} placeholder="選填" />
            </div>
            <label style={{ fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input type="checkbox" checked={newFlow.is_default} onChange={e => setNewFlow(p => ({ ...p, is_default: e.target.checked }))} />
              設為預設流程
            </label>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={handleAddFlow} style={btnPrimary}>新增</button>
            <button onClick={() => setShowAdd(false)} style={btnSecondary}>取消</button>
          </div>
        </div>
      )}

      {loading ? <p>載入中...</p> : (
        <div style={{ display: 'grid', gap: '12px' }}>
          {flows.map(flow => (
            <div key={flow.id} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                <div>
                  <div style={{ fontWeight: '600', color: '#1f2937', marginBottom: '4px' }}>
                    {flow.name}
                    {flow.is_default && <span style={{ marginLeft: '8px', backgroundColor: '#EEF2FF', color: '#4F46E5', padding: '2px 8px', borderRadius: '4px', fontSize: '12px' }}>預設</span>}
                  </div>
                  {flow.description && <div style={{ fontSize: '13px', color: '#6b7280' }}>{flow.description}</div>}
                </div>
                <button onClick={() => {
                  setEditSteps(flow.id)
                  setSteps(flow.steps?.sort((a, b) => a.step_order - b.step_order).map(s => ({ step_order: s.step_order, approver_id: s.approver_id })) || [{ step_order: 1, approver_id: '' }])
                }} style={btnSecondary}>設定審核人</button>
              </div>

              {flow.steps?.length > 0 && editSteps !== flow.id && (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {flow.steps.sort((a, b) => a.step_order - b.step_order).map((step, i) => (
                    <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {i > 0 && <span style={{ color: '#9ca3af' }}>→</span>}
                      <span style={{ backgroundColor: '#EEF2FF', color: '#4F46E5', padding: '4px 10px', borderRadius: '6px', fontSize: '13px' }}>
                        第{step.step_order}關：{step.approver?.full_name}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {editSteps === flow.id && (
                <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #f3f4f6' }}>
                  {steps.map((step, i) => (
                    <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
                      <span style={{ fontSize: '14px', color: '#6b7280', minWidth: '50px' }}>第{step.step_order}關</span>
                      <select value={step.approver_id} onChange={e => {
                        const updated = [...steps]
                        updated[i].approver_id = e.target.value
                        setSteps(updated)
                      }} style={{ ...inputStyle, width: 'auto', flex: 1 }}>
                        <option value="">請選擇審核人</option>
                        {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                      </select>
                      <button onClick={() => setSteps(steps.filter((_, idx) => idx !== i))} style={{ ...btnSecondary, color: '#EF4444', padding: '6px 10px' }}>刪除</button>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                    <button onClick={() => setSteps([...steps, { step_order: steps.length + 1, approver_id: '' }])} style={btnSecondary}>+ 新增關卡</button>
                    <button onClick={() => handleSaveSteps(flow.id)} style={btnPrimary}>儲存</button>
                    <button onClick={() => setEditSteps(null)} style={btnSecondary}>取消</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 代理設定 =====
function DelegateManagement() {
  const [delegates, setDelegates] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newDelegate, setNewDelegate] = useState({ original_approver_id: '', delegate_user_id: '', start_date: '', end_date: '' })

  useEffect(() => { fetchDelegates(); fetchUsers() }, [])

  async function fetchDelegates() {
    const { data } = await supabase
      .from('approval_delegates')
      .select(`*, original:users!approval_delegates_original_approver_id_fkey(full_name), delegate:users!approval_delegates_delegate_user_id_fkey(full_name)`)
      .order('created_at', { ascending: false })
    setDelegates(data || [])
    setLoading(false)
  }

  async function fetchUsers() {
    const { data } = await supabase.from('users').select('id, full_name').eq('is_active', true)
    setUsers(data || [])
  }

  async function handleAdd() {
    if (!newDelegate.original_approver_id || !newDelegate.delegate_user_id || !newDelegate.start_date || !newDelegate.end_date) {
      alert('請填寫所有欄位'); return
    }
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('approval_delegates').insert({ ...newDelegate, created_by: user.id })
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3 style={{ margin: 0, color: '#1f2937' }}>代理審核設定</h3>
        <button onClick={() => setShowAdd(!showAdd)} style={btnPrimary}>+ 新增代理</button>
      </div>

      {showAdd && (
        <div style={cardStyle}>
          <h4 style={{ marginTop: 0 }}>新增代理設定</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>被代理的主管 *</label>
              <select value={newDelegate.original_approver_id} onChange={e => setNewDelegate(p => ({ ...p, original_approver_id: e.target.value }))} style={inputStyle}>
                <option value="">請選擇</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>代理人 *</label>
              <select value={newDelegate.delegate_user_id} onChange={e => setNewDelegate(p => ({ ...p, delegate_user_id: e.target.value }))} style={inputStyle}>
                <option value="">請選擇</option>
                {users.filter(u => u.id !== newDelegate.original_approver_id).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>開始日期 *</label>
              <input type="date" value={newDelegate.start_date} onChange={e => setNewDelegate(p => ({ ...p, start_date: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>結束日期 *</label>
              <input type="date" value={newDelegate.end_date} onChange={e => setNewDelegate(p => ({ ...p, end_date: e.target.value }))} style={inputStyle} min={newDelegate.start_date} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={handleAdd} style={btnPrimary}>新增</button>
            <button onClick={() => setShowAdd(false)} style={btnSecondary}>取消</button>
          </div>
        </div>
      )}

      {loading ? <p>載入中...</p> : (
        <div style={{ display: 'grid', gap: '8px' }}>
          {delegates.map(d => (
            <div key={d.id} style={{ ...cardStyle, padding: '16px 20px', opacity: d.is_active ? 1 : 0.6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: '600', color: '#1f2937', marginBottom: '4px' }}>{d.original?.full_name} → 由 {d.delegate?.full_name} 代理</div>
                  <div style={{ fontSize: '13px', color: '#6b7280' }}>{d.start_date} ～ {d.end_date}</div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span style={{ backgroundColor: d.is_active ? '#D1FAE5' : '#F3F4F6', color: d.is_active ? '#10B981' : '#6B7280', padding: '4px 10px', borderRadius: '20px', fontSize: '12px' }}>
                    {d.is_active ? '啟用中' : '已停用'}
                  </span>
                  <button onClick={() => toggleActive(d)} style={btnSecondary}>{d.is_active ? '停用' : '啟用'}</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 通知對象設定 =====
function NotificationTargets() {
  const [targets, setTargets] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedUserId, setSelectedUserId] = useState('')

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
    if (!selectedUserId) { alert('請選擇人員'); return }
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
      <h3 style={{ marginBottom: '8px', color: '#1f2937' }}>核准通知對象</h3>
      <p style={{ color: '#6b7280', fontSize: '14px', marginBottom: '20px' }}>假單核准後，除了申請人之外，以下人員也會收到 Slack 通知。</p>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
        <select value={selectedUserId} onChange={e => setSelectedUserId(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
          <option value="">選擇要加入的人員</option>
          {availableUsers.map(u => <option key={u.id} value={u.id}>{u.full_name}（{u.email}）</option>)}
        </select>
        <button onClick={handleAdd} style={btnPrimary}>新增</button>
      </div>
      {loading ? <p>載入中...</p> : (
        <div style={{ display: 'grid', gap: '8px' }}>
          {targets.map(target => (
            <div key={target.id} style={{ ...cardStyle, padding: '14px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: '600', color: '#1f2937' }}>{target.user?.full_name}</div>
                  <div style={{ fontSize: '13px', color: '#6b7280' }}>{target.user?.email}</div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => toggleTarget(target)} style={btnSecondary}>{target.is_active ? '停用' : '啟用'}</button>
                  <button onClick={() => handleRemove(target.id)} style={{ ...btnSecondary, color: '#EF4444' }}>移除</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 我的代理設定 =====
function MyDelegates({ userProfile }) {
  const [delegates, setDelegates] = useState([])
  const [users, setUsers] = useState([])
  const [showAdd, setShowAdd] = useState(false)
  const [newDelegate, setNewDelegate] = useState({ delegate_user_id: '', start_date: '', end_date: '' })

  useEffect(() => { fetchMyDelegates(); fetchUsers() }, [])

  async function fetchMyDelegates() {
    const { data } = await supabase
      .from('approval_delegates')
      .select('*, delegate:users!approval_delegates_delegate_user_id_fkey(full_name)')
      .eq('original_approver_id', userProfile.id)
      .order('created_at', { ascending: false })
    setDelegates(data || [])
  }

  async function fetchUsers() {
    const { data } = await supabase.from('users').select('id, full_name').eq('is_active', true).neq('id', userProfile.id)
    setUsers(data || [])
  }

  async function handleAdd() {
    if (!newDelegate.delegate_user_id || !newDelegate.start_date || !newDelegate.end_date) {
      alert('請填寫所有欄位'); return
    }
    await supabase.from('approval_delegates').insert({
      original_approver_id: userProfile.id,
      delegate_user_id: newDelegate.delegate_user_id,
      start_date: newDelegate.start_date,
      end_date: newDelegate.end_date,
      created_by: userProfile.id
    })
    setNewDelegate({ delegate_user_id: '', start_date: '', end_date: '' })
    setShowAdd(false)
    fetchMyDelegates()
  }

  async function toggleActive(delegate) {
    await supabase.from('approval_delegates').update({ is_active: !delegate.is_active }).eq('id', delegate.id)
    fetchMyDelegates()
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3 style={{ margin: 0, color: '#1f2937' }}>我的代理設定</h3>
        <button onClick={() => setShowAdd(!showAdd)} style={btnPrimary}>+ 設定代理人</button>
      </div>

      {showAdd && (
        <div style={cardStyle}>
          <h4 style={{ marginTop: 0 }}>設定代理人</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>代理人 *</label>
              <select value={newDelegate.delegate_user_id} onChange={e => setNewDelegate(p => ({ ...p, delegate_user_id: e.target.value }))} style={inputStyle}>
                <option value="">請選擇</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>開始日期 *</label>
              <input type="date" value={newDelegate.start_date} onChange={e => setNewDelegate(p => ({ ...p, start_date: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>結束日期 *</label>
              <input type="date" value={newDelegate.end_date} onChange={e => setNewDelegate(p => ({ ...p, end_date: e.target.value }))} style={inputStyle} min={newDelegate.start_date} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={handleAdd} style={btnPrimary}>新增</button>
            <button onClick={() => setShowAdd(false)} style={btnSecondary}>取消</button>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gap: '8px' }}>
        {delegates.map(d => (
          <div key={d.id} style={{ ...cardStyle, padding: '16px 20px', opacity: d.is_active ? 1 : 0.6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: '600', color: '#1f2937', marginBottom: '4px' }}>代理人：{d.delegate?.full_name}</div>
                <div style={{ fontSize: '13px', color: '#6b7280' }}>{d.start_date} ～ {d.end_date}</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ backgroundColor: d.is_active ? '#D1FAE5' : '#F3F4F6', color: d.is_active ? '#10B981' : '#6B7280', padding: '4px 10px', borderRadius: '20px', fontSize: '12px' }}>
                  {d.is_active ? '啟用中' : '已停用'}
                </span>
                <button onClick={() => toggleActive(d)} style={btnSecondary}>{d.is_active ? '停用' : '啟用'}</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ===== 修改密碼 =====
function ChangePassword() {
  const [form, setForm] = useState({ newPass: '', confirm: '' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (form.newPass !== form.confirm) {
      setMessage('error:新密碼與確認密碼不符'); return
    }
    if (form.newPass.length < 6) {
      setMessage('error:密碼長度至少 6 位'); return
    }
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password: form.newPass })
    if (error) {
      setMessage('error:' + error.message)
    } else {
      setMessage('success:密碼修改成功！')
      setForm({ newPass: '', confirm: '' })
    }
    setSaving(false)
  }

  return (
    <div style={{ maxWidth: '400px' }}>
      <h3 style={{ marginBottom: '20px', color: '#1f2937' }}>修改密碼</h3>
      {message && (
        <div style={{
          backgroundColor: message.startsWith('error:') ? '#FEE2E2' : '#D1FAE5',
          color: message.startsWith('error:') ? '#DC2626' : '#059669',
          padding: '12px', borderRadius: '8px', marginBottom: '16px', fontSize: '14px'
        }}>
          {message.replace(/^(error|success):/, '')}
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '16px' }}>
          <label style={labelStyle}>新密碼 *</label>
          <input type="password" value={form.newPass} onChange={e => setForm(p => ({ ...p, newPass: e.target.value }))} style={inputStyle} placeholder="請輸入新密碼（至少 6 位）" required />
        </div>
        <div style={{ marginBottom: '24px' }}>
          <label style={labelStyle}>確認新密碼 *</label>
          <input type="password" value={form.confirm} onChange={e => setForm(p => ({ ...p, confirm: e.target.value }))} style={inputStyle} placeholder="請再次輸入新密碼" required />
        </div>
        <button type="submit" disabled={saving} style={btnPrimary}>{saving ? '修改中...' : '確認修改'}</button>
      </form>
    </div>
  )
}

// ===== AdminPanel 主元件 =====
function AdminPanel({ userProfile }) {
  const location = useLocation()
  const isAdmin = userProfile?.role === 'admin'
  const isSupervisor = userProfile?.role === 'supervisor'

  const tabs = []
  if (isAdmin) {
    tabs.push({ path: '/admin', label: '員工管理' })
    tabs.push({ path: '/admin/flows', label: '審核流程' })
    tabs.push({ path: '/admin/delegates', label: '代理設定' })
    tabs.push({ path: '/admin/notifications', label: '通知對象' })
  }
  if (isSupervisor || isAdmin) {
    tabs.push({ path: '/admin/my-delegates', label: '我的代理' })
  }
  tabs.push({ path: '/admin/change-password', label: '修改密碼' })

  return (
    <div>
      <h2 style={{ marginBottom: '20px', color: '#1f2937', fontSize: '22px' }}>管理後台</h2>
      <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: '2px solid #e5e7eb', flexWrap: 'wrap' }}>
        {tabs.map(tab => (
          <Link key={tab.path} to={tab.path} style={{
            padding: '10px 20px', textDecoration: 'none', fontSize: '14px', fontWeight: '500',
            color: location.pathname === tab.path ? '#4F46E5' : '#6b7280',
            borderBottom: location.pathname === tab.path ? '2px solid #4F46E5' : '2px solid transparent',
            marginBottom: '-2px'
          }}>
            {tab.label}
          </Link>
        ))}
      </div>

      <Routes>
        {isAdmin && (
          <>
            <Route index element={<UserManagement />} />
            <Route path="flows" element={<FlowManagement />} />
            <Route path="delegates" element={<DelegateManagement />} />
            <Route path="notifications" element={<NotificationTargets />} />
          </>
        )}
        {(isSupervisor || isAdmin) && (
          <Route path="my-delegates" element={<MyDelegates userProfile={userProfile} />} />
        )}
        <Route path="change-password" element={<ChangePassword />} />
      </Routes>
    </div>
  )
}

// ===== 共用樣式 =====
const cardStyle = { backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const labelStyle = { display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: '500', color: '#374151' }
const inputStyle = { width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' }
const btnPrimary = { padding: '8px 18px', backgroundColor: '#4F46E5', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px', fontWeight: '500' }
const btnSecondary = { padding: '8px 18px', backgroundColor: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px' }

export default AdminPanel