import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useTheme } from '../context/ThemeContext'
import {
  DashboardIcon, AddNoteIcon, ListIcon, HistoryIcon, CalendarIcon,
  ApprovalIcon, ReviewIcon, AdminIcon, ChevronLeftIcon, MoreIcon,
  BellIcon, SunIcon, MoonIcon, LogoutIcon, CloseIcon,
} from './icons'
import './AppShell.css'

const RAIL_EXPANDED_KEY = 'leave-system-rail-expanded'

const APPROVER_ROLES = ['supervisor', 'deputy_supervisor', 'admin', 'boss']
const ADMIN_ROLES = ['admin', 'boss']

const ROLE_LABELS = {
  employee: '員工',
  deputy_supervisor: '副主管',
  supervisor: '主管',
  admin: '管理員',
  boss: '老闆',
}

function buildNavItems(userProfile, pendingCount) {
  const items = [
    { path: '/', label: '儀表板', icon: DashboardIcon, end: true },
    { path: '/leave/new', label: '申請請假', icon: AddNoteIcon },
    { path: '/leave/my', label: '我的假單', icon: ListIcon },
    { path: '/past-leaves', label: '過往假期', icon: HistoryIcon },
    { path: '/calendar', label: '團隊行事曆', icon: CalendarIcon },
  ]

  if (APPROVER_ROLES.includes(userProfile?.role)) {
    items.push({ path: '/approval', label: '簽核中心', icon: ApprovalIcon, badge: pendingCount })
  }

  items.push({ path: '/review', label: '年度考核', icon: ReviewIcon })

  if (ADMIN_ROLES.includes(userProfile?.role)) {
    items.push({ path: '/admin', label: '管理後台', icon: AdminIcon })
  }

  return items
}

function isItemActive(item, pathname) {
  if (item.end) return pathname === item.path
  return pathname === item.path || pathname.startsWith(item.path + '/')
}

function initials(name) {
  if (!name) return '?'
  return name.trim().slice(0, 1).toUpperCase()
}

function Layout({ children, userProfile }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { mode, setMode, resolvedTheme } = useTheme()
  const [pendingCount, setPendingCount] = useState(0)
  const [railExpanded, setRailExpanded] = useState(
    () => localStorage.getItem(RAIL_EXPANDED_KEY) === 'true'
  )
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const [moreSheetOpen, setMoreSheetOpen] = useState(false)
  const avatarMenuRef = useRef(null)
  const themeMenuRef = useRef(null)

  useEffect(() => {
    if (APPROVER_ROLES.includes(userProfile?.role)) {
      fetchPendingCount()

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

  useEffect(() => {
    function handleClickOutside(e) {
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(e.target)) {
        setAvatarMenuOpen(false)
      }
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target)) {
        setThemeMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

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

  function toggleRail() {
    setRailExpanded(prev => {
      const next = !prev
      localStorage.setItem(RAIL_EXPANDED_KEY, String(next))
      return next
    })
  }

  const navItems = buildNavItems(userProfile, pendingCount)
  const activeItem = navItems.find(item => isItemActive(item, location.pathname))
  const bottomNavItems = navItems.slice(0, 3)
  const moreItems = navItems.slice(3)

  const themeOptions = [
    { value: 'light', label: '淺色', icon: SunIcon },
    { value: 'dark', label: '深色', icon: MoonIcon },
    { value: 'system', label: '跟隨系統', icon: DashboardIcon },
  ]

  return (
    <div className="shell">
      <a href="#main-content" className="skip-link">跳到主要內容</a>

      <header className="app-bar">
        <div className="app-bar__brand">
          <span className="app-bar__title">{activeItem?.label || '請假系統'}</span>
        </div>
        <div className="app-bar__actions">
          <div className="avatar-menu" ref={themeMenuRef}>
            <button
              type="button"
              className="icon-button"
              aria-label="切換主題"
              aria-haspopup="menu"
              aria-expanded={themeMenuOpen}
              onClick={() => setThemeMenuOpen(o => !o)}
            >
              {resolvedTheme === 'dark' ? <MoonIcon size={20} /> : <SunIcon size={20} />}
            </button>
            {themeMenuOpen && (
              <div className="theme-menu__panel" role="menu">
                {themeOptions.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={mode === opt.value}
                    className={`theme-menu__option${mode === opt.value ? ' theme-menu__option--selected' : ''}`}
                    onClick={() => { setMode(opt.value); setThemeMenuOpen(false) }}
                  >
                    <opt.icon size={18} />
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            className="icon-button"
            aria-label={`簽核中心，${pendingCount} 筆待處理`}
            onClick={() => navigate('/approval')}
          >
            <BellIcon size={20} />
            {pendingCount > 0 && <span className="icon-button__badge">{pendingCount}</span>}
          </button>

          <div className="avatar-menu" ref={avatarMenuRef}>
            <button
              type="button"
              className="avatar"
              aria-label="使用者選單"
              aria-haspopup="menu"
              aria-expanded={avatarMenuOpen}
              onClick={() => setAvatarMenuOpen(o => !o)}
            >
              {initials(userProfile?.full_name)}
            </button>
            {avatarMenuOpen && (
              <div className="avatar-menu__panel" role="menu">
                <div className="avatar-menu__identity">
                  <div className="avatar-menu__name">{userProfile?.full_name}</div>
                  <div className="avatar-menu__role">{ROLE_LABELS[userProfile?.role] || userProfile?.role}</div>
                </div>
                <button type="button" className="avatar-menu__item avatar-menu__item--danger" onClick={handleLogout}>
                  <LogoutIcon size={18} />
                  登出
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="shell__body">
        <nav className={`rail${railExpanded ? ' rail--expanded' : ''}`} aria-label="主要導覽">
          <div className="rail__toggle-row">
            <button
              type="button"
              className="icon-button"
              aria-label={railExpanded ? '收合導覽列' : '展開導覽列'}
              onClick={toggleRail}
              style={{ transform: railExpanded ? 'none' : 'rotate(180deg)' }}
            >
              <ChevronLeftIcon size={20} />
            </button>
          </div>
          <ul className="rail__list">
            {navItems.map(item => {
              const active = isItemActive(item, location.pathname)
              return (
                <li key={item.path}>
                  <Link
                    to={item.path}
                    className={`rail-item${active ? ' rail-item--active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    title={item.label}
                  >
                    <span className="rail-item__icon">
                      <item.icon size={22} filled={active} />
                    </span>
                    <span className="rail-item__label">{item.label}</span>
                    {item.badge > 0 && <span className="rail-item__badge">{item.badge}</span>}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>

        <main id="main-content" className="shell__content">
          <div className="shell__content-inner">
            {children}
          </div>
        </main>
      </div>

      <nav className="bottom-nav" aria-label="主要導覽（行動版）">
        {bottomNavItems.map(item => {
          const active = isItemActive(item, location.pathname)
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`bottom-nav-item${active ? ' bottom-nav-item--active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <item.icon size={22} filled={active} />
              {item.label}
              {item.badge > 0 && <span className="bottom-nav-item__badge">{item.badge}</span>}
            </Link>
          )
        })}
        <button type="button" className="bottom-nav-item" onClick={() => setMoreSheetOpen(true)} aria-haspopup="dialog">
          <MoreIcon size={22} />
          更多
        </button>
      </nav>

      {moreSheetOpen && (
        <>
          <div className="more-sheet-scrim" onClick={() => setMoreSheetOpen(false)} />
          <div className="more-sheet" role="dialog" aria-label="更多功能">
            <div className="more-sheet__header">
              <span className="more-sheet__title">更多功能</span>
              <button type="button" className="icon-button" aria-label="關閉" onClick={() => setMoreSheetOpen(false)}>
                <CloseIcon size={20} />
              </button>
            </div>
            <ul className="more-sheet__list">
              {moreItems.map(item => (
                <li key={item.path}>
                  <Link to={item.path} className="more-sheet__item" onClick={() => setMoreSheetOpen(false)}>
                    <item.icon size={20} />
                    {item.label}
                    {item.badge > 0 && <span className="rail-item__badge" style={{ marginLeft: 'auto', position: 'static' }}>{item.badge}</span>}
                  </Link>
                </li>
              ))}
              <li>
                <button type="button" className="more-sheet__item" onClick={handleLogout}>
                  <LogoutIcon size={20} />
                  登出
                </button>
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

export default Layout
