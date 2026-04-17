import { Link, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'

function Layout({ children, userProfile }) {
  const navigate = useNavigate()
  const location = useLocation()

  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/')
  }

  const navItems = [
    { path: '/', label: '首頁' },
    { path: '/leave/new', label: '申請請假' },
    { path: '/leave/my', label: '我的假單' },
  ]

  if (userProfile?.role === 'supervisor' || userProfile?.role === 'admin') {
    navItems.push({ path: '/approval', label: '審核假單' })
  }

  if (userProfile?.role === 'admin') {
    navItems.push({ path: '/admin', label: '管理後台' })
  }

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f5f5f5' }}>
      <nav style={{
        backgroundColor: '#4F46E5',
        padding: '0 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '60px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <span style={{ color: 'white', fontWeight: 'bold', fontSize: '18px' }}>
            請假系統
          </span>
          {navItems.map(item => (
            <Link
              key={item.path}
              to={item.path}
              style={{
                color: location.pathname === item.path ? '#fff' : 'rgba(255,255,255,0.75)',
                textDecoration: 'none',
                fontSize: '14px',
                fontWeight: location.pathname === item.path ? '600' : '400',
                borderBottom: location.pathname === item.path ? '2px solid white' : 'none',
                paddingBottom: '4px'
              }}
            >
              {item.label}
            </Link>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: '14px' }}>
            {userProfile?.full_name}
          </span>
          <button
            onClick={handleLogout}
            style={{
              backgroundColor: 'rgba(255,255,255,0.2)',
              color: 'white',
              border: 'none',
              padding: '6px 14px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            登出
          </button>
        </div>
      </nav>
      <main style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
        {children}
      </main>
    </div>
  )
}

export default Layout