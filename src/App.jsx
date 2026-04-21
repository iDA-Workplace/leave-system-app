import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'

import Login from './pages/Login'
import Home from './pages/Home'
import LeaveForm from './pages/LeaveForm'
import MyLeaves from './pages/MyLeaves'
import ApprovalList from './pages/ApprovalList'
import AdminPanel from './pages/AdminPanel'
import Layout from './components/Layout'

function App() {
  const [session, setSession] = useState(null)
  const [userProfile, setUserProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) fetchProfile(session.user.id)
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) fetchProfile(session.user.id)
      else { setUserProfile(null); setLoading(false) }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function fetchProfile(userId) {
  const { data } = await supabase
    .from('users')
    .select('*, default_flow:approval_flows(id, name)')
    .eq('id', userId)
    .single()
  setUserProfile(data)
  setLoading(false)
}

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <p>載入中...</p>
    </div>
  )

  if (!session) return <Login />

  return (
    <Layout userProfile={userProfile}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/leave/new" element={<LeaveForm userProfile={userProfile} />} />
        <Route path="/leave/my" element={<MyLeaves userProfile={userProfile} />} />
        <Route path="/approval" element={<ApprovalList userProfile={userProfile} />} />
        {userProfile?.role === 'admin' && (
          <Route path="/admin/*" element={<AdminPanel userProfile={userProfile} />} />
        )}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  )
}

export default App