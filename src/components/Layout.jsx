import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

function Layout({ children, userProfile }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    if (userProfile?.role === 'supervisor' || userProfile?.role === 'admin' || userProfile?.role === 'boss') {
  fetchPendingCount()

      // 即時監聽假單狀態變更
      const subscription = supabase
        .channel('leave_requests_changes')
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'leave_requests'
        }, () => {
          fetchPendingCount()
        })
        .subscribe()

      return () => {
        supabase.removeChannel(subscription)
      }
    }
  }, [userProfile])

  async function fetchPendingCount() {
    const today = new Date().toISOString().split('T')[0]

    const { data: flowSteps } = await supabase
      .from('approval_flow_steps')
      .select('flow_id, step_order')
      .eq('approver_id', userProfile.id)

    const { data: delegateFor } = await supabase
      .from('approval_delegates')
      .select('original_approver_id')
      .eq('delegate_user_id', userProfile.id)
      .eq('is_active', true)
      .lte('start_date', today)
      .gte('end_date', today)

    const originalApproverIds = delegateFor?.map(d => d.original_approver_id) || []
    let delegateSteps = []
    if (originalApproverIds.length > 0) {
      const { data } = await supabase
        .from('approval_flow_steps')
        .select('flow_id, step_order')
        .in('approver_id', originalApproverIds)
      delegateSteps = data || []
    }

    const allSteps = [...(flowSteps || []), ...delegateSteps]
    if (allSteps.length === 0) { setPendingCount(0); return }

    const { data: requests } = await supabase
      .from('leave_requests')
      .select('id, flow_id, current_step')
      .eq('status', 'pending')

    const count = (requests || []).filter(req =>
      allSteps.some(step => step.flow_id === req.flow_id && step.step_order === req.current_step)
    ).length

    setPendingCount(count)
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/')
  }

  const navItems = [
    { path: '/', label: '首頁' },
    { path: '/calendar', label: '請假行事曆' },
    { path: '/past-leaves', label: '過往假期' },
    { path: '/leave/new', label: '申請請假' },
    { path: '/leave/my', label: '我的假單' },
  ]

  if (userProfile?.role === 'supervisor' || userProfile?.role === 'admin' || userProfile?.role === 'boss') {
  navItems.push({ path: '/approval', label: '審核假單', badge: pendingCount })
}

  navItems.push({ path: '/admin', label: '管理後台' })

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f5f5f5' }}>
      <nav style={{
        backgroundColor: '#4F46E5', padding: '0 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: '60px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <span style={{ color: 'white', fontWeight: 'bold', fontSize: '18px' }}>請假系統</span>
          {navItems.map(item => (
            <Link key={item.path} to={item.path} style={{
              color: location.pathname === item.path ? '#fff' : 'rgba(255,255,255,0.75)',
              textDecoration: 'none', fontSize: '14px',
              fontWeight: location.pathname === item.path ? '600' : '400',
              borderBottom: location.pathname === item.path ? '2px solid white' : 'none',
              paddingBottom: '4px', display: 'flex', alignItems: 'center', gap: '6px'
            }}>
              {item.label}
              {item.badge > 0 && (
                <span style={{
                  backgroundColor: '#EF4444', color: 'white',
                  borderRadius: '20px', padding: '1px 7px',
                  fontSize: '11px', fontWeight: '600', lineHeight: '1.6'
                }}>
                  {item.badge}
                </span>
              )}
            </Link>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: '14px' }}>{userProfile?.full_name}</span>
          <button onClick={handleLogout} style={{
            backgroundColor: 'rgba(255,255,255,0.2)', color: 'white',
            border: 'none', padding: '6px 14px', borderRadius: '6px',
            cursor: 'pointer', fontSize: '14px'
          }}>登出</button>
        </div>
      </nav>
      <main style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
        {children}
      </main>
    </div>
  )
}

export default Layout