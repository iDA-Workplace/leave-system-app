import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'

import Login from './pages/Login'
import Home from './pages/Home'
import LeaveForm from './pages/LeaveForm'
import MyLeaves from './pages/MyLeaves'
import AdminPanel from './pages/AdminPanel'
import Layout from './components/Layout'
import Review from './pages/Review'
import Settings from './pages/Settings'
import InstallGuide from './pages/InstallGuide'
import { useLanguage } from './context/LanguageContext'

function App() {
  const { t } = useLanguage()
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
    .select('*')
    .eq('id', userId)
    .single()
  console.log('userProfile data:', data)
  setUserProfile(data)
  setLoading(false)
}

  // 斷網時卡在「載入中…」是最糟的一種畫面 —— 使用者不知道是自己網路的問題還是
  // 系統壞了。裝成 App 之後這個情境會變常見（點圖示就開，不像瀏覽器會先報錯），
  // 所以這裡直接把原因寫出來。
  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', padding: '24px', textAlign: 'center' }}>
      <p>{navigator.onLine === false ? t('offline_banner') : t('common_loading')}</p>
    </div>
  )

  if (!session) return <Login />

  return (
    <Layout userProfile={userProfile}>
      <Routes>
        <Route path="/" element={<Home userProfile={userProfile} />} />
        <Route path="/review/*" element={<Review userProfile={userProfile} />} />
        <Route path="/leave/new" element={<LeaveForm userProfile={userProfile} />} />
        <Route path="/leave/my" element={<MyLeaves userProfile={userProfile} />} />
        <Route path="/approval" element={<Navigate to="/leave/my" replace />} />
        <Route path="/admin/*" element={<AdminPanel userProfile={userProfile} />} />
        <Route path="/settings" element={<Settings userProfile={userProfile} />} />
        <Route path="/install" element={<InstallGuide />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  )
}

export default App
