import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { loadHolidays } from './lib/holidays'
import { clearPushOnLogout } from './lib/push'

import Login, { LOGIN_NOTICE_KEY } from './pages/Login'
import Home from './pages/Home'
import LeaveForm from './pages/LeaveForm'
import MyLeaves from './pages/MyLeaves'
import AdminPanel from './pages/AdminPanel'
import Layout from './components/Layout'
import Review from './pages/Review'
import Settings from './pages/Settings'
import InstallGuide from './pages/InstallGuide'
import Benefits from './pages/benefits/Benefits'
import TeamLeaveStats from './pages/TeamLeaveStats'
import { useLanguage } from './context/LanguageContext'

function App() {
  const { t } = useLanguage()
  const [session, setSession] = useState(null)
  const [userProfile, setUserProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  // 「哪一個帳號的個人資料已經讀完了」。剛登入的那一刻已經有登入狀態、但個人資料還在讀，
  // 這時候如果先把頁面畫出來，會被當成「沒有管理權限」：例如從 Slack「前往抽籤」點進來、
  // 在登入頁登入後，抽籤頁會以為你不是管理者而把你轉回按摩首頁（2026-11 的 bug）。
  // 所以個人資料讀完之前一律顯示「載入中」。用帳號 id 判斷而不是 true/false：
  // 登入狀態每小時自動更新一次（同一個帳號），不會因此閃一下載入畫面。
  const [profileFor, setProfileFor] = useState(null)

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
  // 國定假日跟個人資料一起讀：畫面出來時算請假天數一定已經扣掉假日（lib/holidays.js）
  const [{ data }] = await Promise.all([
    supabase.from('users').select('*').eq('id', userId).single(),
    loadHolidays(),
  ])
  console.log('userProfile data:', data)
  // 已停用（離職）的帳號：直接登出，登入頁顯示「帳號已停用」。
  // 停用時後台也會封鎖登入（manage-users），這裡是第二道關卡：擋住封鎖前就已經
  // 登入、還留著登入狀態的人。
  if (data?.is_active === false) {
    try { sessionStorage.setItem(LOGIN_NOTICE_KEY, 'login_disabled') } catch { /* 無痕模式等存不了就算了 */ }
    await clearPushOnLogout()   // 這台裝置不再收這個帳號的通知
    await supabase.auth.signOut()
    return
  }
  setUserProfile(data)
  setProfileFor(userId)
  setLoading(false)
}

  // 斷網時卡在「載入中…」是最糟的一種畫面 —— 使用者不知道是自己網路的問題還是
  // 系統壞了。裝成 App 之後這個情境會變常見（點圖示就開，不像瀏覽器會先報錯），
  // 所以這裡直接把原因寫出來。
  if (loading || (session && profileFor !== session.user.id)) return (
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
        <Route path="/benefits/*" element={<Benefits userProfile={userProfile} />} />
        <Route path="/team-stats" element={<TeamLeaveStats userProfile={userProfile} />} />
        <Route path="/settings" element={<Settings userProfile={userProfile} />} />
        <Route path="/install" element={<InstallGuide />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  )
}

export default App
