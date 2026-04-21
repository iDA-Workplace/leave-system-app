import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

function LeaveForm({ userProfile }) {
  const navigate = useNavigate()
  const [leaveTypes, setLeaveTypes] = useState([])
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [form, setForm] = useState({
    leave_type_id: '',
    start_date: '',
    end_date: '',
    reason: ''
  })

  useEffect(() => {
    fetchLeaveTypes()
  }, [])

  async function fetchLeaveTypes() {
    const { data } = await supabase
      .from('leave_types')
      .select('*')
      .eq('is_active', true)
    setLeaveTypes(data || [])
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.leave_type_id || !form.start_date || !form.end_date || !form.reason) {
      alert('請填寫所有欄位')
      return
    }
    if (form.end_date < form.start_date) {
      alert('結束日期不能早於開始日期')
      return
    }
    if (!userProfile.default_flow_id) {
      alert('您尚未被指定審核流程，請聯繫管理員設定')
      return
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
      backgroundColor: 'white',
      borderRadius: '12px',
      padding: '48px',
      textAlign: 'center',
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      maxWidth: '560px',
      margin: '0 auto'
    }}>
      <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
      <h3 style={{ color: '#1f2937', marginBottom: '8px' }}>假單已送出！</h3>
      <p style={{ color: '#6b7280', marginBottom: '24px', fontSize: '14px' }}>
        已通知審核人，請等候審核結果。
      </p>
      <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
        <button
          onClick={() => { setSuccess(false); setForm({ leave_type_id: '', start_date: '', end_date: '', reason: '' }) }}
          style={{ padding: '10px 20px', backgroundColor: '#4F46E5', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px' }}
        >
          再請一張
        </button>
        <button
          onClick={() => navigate('/leave/my')}
          style={{ padding: '10px 20px', backgroundColor: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px' }}
        >
          查看我的假單
        </button>
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

          <div style={{ marginBottom: '20px' }}>
            <label style={labelStyle}>假別 *</label>
            <select value={form.leave_type_id} onChange={e => setForm(prev => ({ ...prev, leave_type_id: e.target.value }))} required style={inputStyle}>
              <option value="">請選擇假別</option>
              {leaveTypes.map(lt => (
                <option key={lt.id} value={lt.id}>{lt.name}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label style={labelStyle}>開始日期 *</label>
            <input type="date" value={form.start_date} onChange={e => setForm(prev => ({ ...prev, start_date: e.target.value }))} required style={inputStyle} />
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label style={labelStyle}>結束日期 *</label>
            <input type="date" value={form.end_date} onChange={e => setForm(prev => ({ ...prev, end_date: e.target.value }))} required min={form.start_date} style={inputStyle} />
          </div>

          <div style={{ marginBottom: '28px' }}>
            <label style={labelStyle}>請假原因 *</label>
            <textarea value={form.reason} onChange={e => setForm(prev => ({ ...prev, reason: e.target.value }))} required rows={4} style={{ ...inputStyle, resize: 'vertical' }} placeholder="請簡述請假原因" />
          </div>

          <button type="submit" disabled={loading} style={{
            width: '100%', padding: '12px',
            backgroundColor: loading ? '#a5b4fc' : '#4F46E5',
            color: 'white', border: 'none', borderRadius: '8px',
            fontSize: '16px', fontWeight: '600',
            cursor: loading ? 'not-allowed' : 'pointer'
          }}>
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