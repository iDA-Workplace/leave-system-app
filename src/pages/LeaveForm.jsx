import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const TIME_OPTIONS = []
for (let h = 8; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 18 && m > 0) break
    const hh = String(h).padStart(2, '0')
    const mm = String(m).padStart(2, '0')
    TIME_OPTIONS.push(`${hh}:${mm}`)
  }
}

function calcHours(start, end) {
  if (!start || !end) return 0
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  if (endMin <= startMin) return 0
  let total = endMin - startMin
  const lunchStart = 12 * 60
  const lunchEnd = 13 * 60
  const overlapStart = Math.max(startMin, lunchStart)
  const overlapEnd = Math.min(endMin, lunchEnd)
  if (overlapEnd > overlapStart) total -= (overlapEnd - overlapStart)
  return Math.max(0, total / 60)
}

function LeaveForm({ userProfile }) {
  const navigate = useNavigate()
  const [leaveTypes, setLeaveTypes] = useState([])
  const [flowSteps, setFlowSteps] = useState([])
  const [colleagues, setColleagues] = useState([])
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [form, setForm] = useState({
    leave_type_id: '',
    start_date: '',
    end_date: '',
    start_time: '09:00',
    end_time: '18:00',
    proxy_user_id: '',
    reason: ''
  })

  const isMultiDay = form.start_date && form.end_date && form.end_date > form.start_date
  const hours = isMultiDay ? null : calcHours(form.start_time, form.end_time)

  useEffect(() => {
    fetchLeaveTypes()
    fetchColleagues()
    if (userProfile?.default_flow_id) fetchFlowSteps(userProfile.default_flow_id)
  }, [userProfile])

  async function fetchLeaveTypes() {
    const { data } = await supabase.from('leave_types').select('*').eq('is_active', true)
    setLeaveTypes(data || [])
  }

  async function fetchFlowSteps(flowId) {
    const { data } = await supabase
      .from('approval_flow_steps')
      .select('step_order, approver:users!approval_flow_steps_approver_id_fkey(full_name)')
      .eq('flow_id', flowId)
      .order('step_order')
    setFlowSteps(data || [])
  }

  async function fetchColleagues() {
    const { data } = await supabase
      .from('users')
      .select('id, full_name')
      .eq('is_active', true)
      .neq('id', userProfile.id)
      .order('full_name')
    setColleagues(data || [])
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.leave_type_id || !form.start_date || !form.end_date || !form.reason) {
      alert('請填寫所有欄位'); return
    }
    if (form.end_date < form.start_date) {
      alert('結束日期不能早於開始日期'); return
    }
    if (!isMultiDay && form.end_time <= form.start_time) {
      alert('結束時間不能早於或等於開始時間'); return
    }
    if (!isMultiDay && hours === 0) {
      alert('請假時數不能為 0'); return
    }
    if (!userProfile.default_flow_id) {
      alert('您尚未被指定審核流程，請聯繫管理員設定'); return
    }

    setLoading(true)

    const { data, error } = await supabase
      .from('leave_requests')
      .insert({
        requester_id: userProfile.id,
        leave_type_id: form.leave_type_id,
        flow_id: userProfile.default_flow_id,
        start_date: form.start_date,
        end_date: form.end_date,
        start_time: isMultiDay ? '09:00' : form.start_time,
        end_time: isMultiDay ? '18:00' : form.end_time,
        hours: isMultiDay ? null : hours,
        proxy_user_id: form.proxy_user_id || null,
        reason: form.reason,
        status: 'pending',
        current_step: 1
      })
      .select()
      .single()

    if (error) {
      alert('送出失敗，請稍後再試')
      setLoading(false)
      return
    }

    await supabase.functions.invoke('send-slack-notification', {
      body: { type: 'new_request', request_id: data.id }
    })

    setSuccess(true)
    setLoading(false)
  }

  if (success) return (
    <div style={{
      backgroundColor: 'white', borderRadius: '12px', padding: '48px',
      textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      maxWidth: '560px', margin: '0 auto'
    }}>
      <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
      <h3 style={{ color: '#1f2937', marginBottom: '8px' }}>假單已送出！</h3>
      <p style={{ color: '#6b7280', marginBottom: '24px', fontSize: '14px' }}>已通知審核人，請等候審核結果。</p>
      <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
        <button
          onClick={() => { setSuccess(false); setForm({ leave_type_id: '', start_date: '', end_date: '', start_time: '09:00', end_time: '18:00', proxy_user_id: '', reason: '' }) }}
          style={{ padding: '10px 20px', backgroundColor: '#4F46E5', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px' }}
        >再請一張</button>
        <button
          onClick={() => navigate('/leave/my')}
          style={{ padding: '10px 20px', backgroundColor: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px' }}
        >查看我的假單</button>
      </div>
    </div>
  )

  return (
    <div style={{ maxWidth: '560px', margin: '0 auto' }}>
      <h2 style={{ marginBottom: '24px', color: '#1f2937', fontSize: '22px' }}>申請請假</h2>
      <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '32px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <form onSubmit={handleSubmit}>

          <div style={{ marginBottom: '20px' }}>
            <label style={labelStyle}>申請人</label>
            <input type="text" value={userProfile?.full_name || ''} disabled style={{ ...inputStyle, backgroundColor: '#f9fafb', color: '#6b7280' }} />
          </div>

          {flowSteps.length > 0 && (
            <div style={{ marginBottom: '20px' }}>
              <label style={labelStyle}>審核流程</label>
              <div style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                {flowSteps.map((step, i) => (
                  <div key={step.step_order} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {i > 0 && <span style={{ color: '#9ca3af' }}>→</span>}
                    <span style={{ backgroundColor: '#EEF2FF', color: '#4F46E5', padding: '4px 12px', borderRadius: '20px', fontSize: '13px', fontWeight: '500' }}>
                      第{step.step_order}關：{step.approver?.full_name}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!userProfile?.default_flow_id && (
            <div style={{ backgroundColor: '#FEF3C7', color: '#D97706', padding: '12px', borderRadius: '8px', marginBottom: '20px', fontSize: '13px' }}>
              ⚠️ 您尚未被指定審核流程，請聯繫管理員設定後再送出假單。
            </div>
          )}

          <div style={{ marginBottom: '20px' }}>
            <label style={labelStyle}>假別 *</label>
            <select value={form.leave_type_id} onChange={e => setForm(prev => ({ ...prev, leave_type_id: e.target.value }))} required style={inputStyle}>
              <option value="">請選擇假別</option>
              {leaveTypes.map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
            <div>
              <label style={labelStyle}>開始日期 *</label>
              <input type="date" value={form.start_date} onChange={e => setForm(prev => ({ ...prev, start_date: e.target.value }))} required style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>結束日期 *</label>
              <input type="date" value={form.end_date} onChange={e => setForm(prev => ({ ...prev, end_date: e.target.value }))} required min={form.start_date} style={inputStyle} />
            </div>
          </div>

          {!isMultiDay && form.start_date && (
            <div style={{ marginBottom: '20px' }}>
              <label style={labelStyle}>請假時段 *</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '8px', alignItems: 'center' }}>
                <select value={form.start_time} onChange={e => setForm(prev => ({ ...prev, start_time: e.target.value }))} style={inputStyle}>
                  {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <span style={{ color: '#6b7280', textAlign: 'center' }}>～</span>
                <select value={form.end_time} onChange={e => setForm(prev => ({ ...prev, end_time: e.target.value }))} style={inputStyle}>
                  {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              {hours > 0 && (
                <div style={{ marginTop: '10px', backgroundColor: '#EEF2FF', color: '#4F46E5', padding: '10px 14px', borderRadius: '8px', fontSize: '14px', fontWeight: '500' }}>
                  🕐 請假時數：{hours} 小時
                  {form.start_time < '13:00' && form.end_time > '12:00' && (
                    <span style={{ fontSize: '12px', color: '#6366f1', fontWeight: '400', marginLeft: '6px' }}>（已扣除午休 1 小時）</span>
                  )}
                </div>
              )}
              {hours === 0 && form.start_time && form.end_time && form.end_time <= form.start_time && (
                <div style={{ marginTop: '10px', backgroundColor: '#FEE2E2', color: '#EF4444', padding: '10px 14px', borderRadius: '8px', fontSize: '13px' }}>
                  ⚠️ 結束時間不能早於或等於開始時間
                </div>
              )}
            </div>
          )}

          {isMultiDay && (
            <div style={{ marginBottom: '20px', backgroundColor: '#EEF2FF', color: '#4F46E5', padding: '10px 14px', borderRadius: '8px', fontSize: '14px' }}>
              📅 跨天請假：09:00 ～ 18:00（整天）
            </div>
          )}

          <div style={{ marginBottom: '20px' }}>
            <label style={labelStyle}>工作代理人</label>
            <select value={form.proxy_user_id} onChange={e => setForm(prev => ({ ...prev, proxy_user_id: e.target.value }))} style={inputStyle}>
              <option value="">請選擇代理人（選填）</option>
              {colleagues.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
            </select>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>請假期間由此人代理您的工作事務</p>
          </div>

          <div style={{ marginBottom: '28px' }}>
            <label style={labelStyle}>請假原因 *</label>
            <textarea value={form.reason} onChange={e => setForm(prev => ({ ...prev, reason: e.target.value }))} required rows={4} style={{ ...inputStyle, resize: 'vertical' }} placeholder="請簡述請假原因" />
          </div>

          <button
            type="submit"
            disabled={loading || !userProfile?.default_flow_id}
            style={{
              width: '100%', padding: '12px',
              backgroundColor: loading || !userProfile?.default_flow_id ? '#a5b4fc' : '#4F46E5',
              color: 'white', border: 'none', borderRadius: '8px',
              fontSize: '16px', fontWeight: '600',
              cursor: loading || !userProfile?.default_flow_id ? 'not-allowed' : 'pointer'
            }}
          >
            {loading ? '送出中...' : '送出申請'}
          </button>
        </form>
      </div>
    </div>
  )
}

const labelStyle = { display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: '500', color: '#374151' }
const inputStyle = { width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box', outline: 'none' }

export default LeaveForm