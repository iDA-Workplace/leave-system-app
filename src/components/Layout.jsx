import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useTheme } from '../context/ThemeContext'
import { useLanguage } from '../context/LanguageContext'
import {
  DashboardIcon, AddNoteIcon, ListIcon,
  ReviewIcon, AdminIcon, SettingsIcon, ChevronLeftIcon, MoreIcon,
  BellIcon, SunIcon, MoonIcon, LogoutIcon, CloseIcon, SearchIcon,
} from './icons'
import './AppShell.css'

const ROLE_BADGE_LABELS = {
  employee: 'EMPLOYEE',
  deputy_supervisor: 'DEPUTY',
  supervisor: 'SUPERVISOR',
  boss: 'BOSS',
}

const RAIL_EXPANDED_KEY = 'leave-system-rail-expanded'

const APPROVER_ROLES = ['supervisor', 'deputy_supervisor', 'boss']

function buildNavItems(userProfile, t) {
  const items = [
    { path: '/', label: t('nav_home'), icon: DashboardIcon, end: true },
    { path: '/leave/my', label: t('nav_leave_management'), icon: ListIcon },
    { path: '/review', label: t('nav_review'), icon: ReviewIcon },
  ]

  if (userProfile?.is_admin || userProfile?.is_finance) {
    items.push({ path: '/admin', label: t('nav_admin'), icon: AdminIcon })
  }

  items.push({ path: '/settings', label: t('nav_settings'), icon: SettingsIcon })

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
  const { t } = useLanguage()
  const [pendingCount, setPendingCount] = useState(0)
  const [railExpanded, setRailExpanded] = useState(
    () => localStorage.getItem(RAIL_EXPANDED_KEY) === 'true'
  )
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const [moreSheetOpen, setMoreSheetOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const avatarMenuRef = useRef(null)
  const themeMenuRef = useRef(null)
  const searchRef = useRef(null)

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
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function fetchPendingCount() {
    const { data: flowSteps } = await supabase
      .from('approval_flow_steps')
      .select('flow_id, step_order')
      .eq('approver_id', userProfile.id)

    const allSteps = flowSteps || []
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

  const navItems = buildNavItems(userProfile, t)
  const bottomNavItems = navItems.slice(0, 3)
  const moreItems = navItems.slice(3)

  const searchMatches = searchQuery.trim()
    ? navItems.filter(item => item.label.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : []

  function handleSearchSubmit(e) {
    e.preventDefault()
    if (searchMatches.length > 0) {
      navigate(searchMatches[0].path)
      setSearchQuery('')
      setSearchOpen(false)
    }
  }

  function handleSearchSelect(path) {
    navigate(path)
    setSearchQuery('')
    setSearchOpen(false)
  }

  const themeOptions = [
    { value: 'light', label: t('theme_light'), icon: SunIcon },
    { value: 'dark', label: t('theme_dark'), icon: MoonIcon },
    { value: 'system', label: t('theme_system'), icon: DashboardIcon },
  ]

  return (
    <div className="shell">
      <a href="#main-content" className="skip-link">{t('app_skip_to_content')}</a>

      <header className="app-bar">
        <form className="app-bar__search" ref={searchRef} onSubmit={handleSearchSubmit}>
          <SearchIcon size={18} className="app-bar__search-icon" />
          <input
            type="search"
            className="app-bar__search-input"
            placeholder={t('app_bar_search_placeholder')}
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setSearchOpen(true) }}
            onFocus={() => setSearchOpen(true)}
            aria-label={t('app_bar_search_placeholder')}
          />
          {searchOpen && searchMatches.length > 0 && (
            <ul className="app-bar__search-results" role="listbox">
              {searchMatches.map(item => (
                <li key={item.path}>
                  <button type="button" onClick={() => handleSearchSelect(item.path)}>
                    <item.icon size={18} />
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
        <div className="app-bar__actions">
          <div className="avatar-menu" ref={themeMenuRef}>
            <button
              type="button"
              className="icon-button"
              aria-label={t('app_bar_theme_toggle')}
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
            aria-label={t('app_bar_pending_aria', { n: pendingCount })}
            onClick={() => navigate('/#pending-team-approvals')}
          >
            <BellIcon size={20} />
            {pendingCount > 0 && <span className="icon-button__badge">{pendingCount}</span>}
          </button>

          <div className="avatar-menu" ref={avatarMenuRef}>
            <button
              type="button"
              className="app-bar__identity"
              aria-label={t('app_bar_user_menu')}
              aria-haspopup="menu"
              aria-expanded={avatarMenuOpen}
              onClick={() => setAvatarMenuOpen(o => !o)}
            >
              {ROLE_BADGE_LABELS[userProfile?.role] && (
                <span className="app-bar__role-badge">
                  {ROLE_BADGE_LABELS[userProfile.role]}{userProfile?.is_admin ? ' · ADMIN' : ''}
                </span>
              )}
              <span className="avatar">{initials(userProfile?.full_name)}</span>
              <span className="app-bar__name">{userProfile?.full_name}</span>
            </button>
            {avatarMenuOpen && (
              <div className="avatar-menu__panel" role="menu">
                <div className="avatar-menu__identity">
                  <div className="avatar-menu__name">{userProfile?.full_name}</div>
                  <div className="avatar-menu__role">
                    {userProfile?.role ? t(`role_${userProfile.role}`) : ''}{userProfile?.is_admin ? t('role_admin_suffix') : ''}
                  </div>
                </div>
                <button type="button" className="avatar-menu__item avatar-menu__item--danger" onClick={handleLogout}>
                  <LogoutIcon size={18} />
                  {t('app_bar_logout')}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="shell__body">
        <nav className={`rail${railExpanded ? ' rail--expanded' : ''}`} aria-label={t('app_nav_primary')}>
          <div className="rail__brand">
            {/* Placeholder wordmark until the real logo file can be added to
                the repo (this session can't extract a pasted chat image to
                disk) -- swap for <img src="/logo.png" .../> once it lands. */}
            <span className="rail__brand-name">
              <span className="rail__brand-name-full">iDA Workplace</span>
              <span className="rail__brand-name-short">iDA</span>
            </span>
            <span className="rail__brand-caption">{t('app_brand_caption')}</span>
          </div>

          <Link to="/leave/new" className="rail__cta" title={t('nav_leave_apply')}>
            <AddNoteIcon size={18} />
            <span className="rail__cta-label">{t('nav_leave_apply')}</span>
          </Link>

          <div className="rail__toggle-row">
            <button
              type="button"
              className="icon-button"
              aria-label={railExpanded ? t('app_rail_collapse') : t('app_rail_expand')}
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

      <nav className="bottom-nav" aria-label={t('app_nav_primary_mobile')}>
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
          {t('app_more')}
        </button>
      </nav>

      {moreSheetOpen && (
        <>
          <div className="more-sheet-scrim" onClick={() => setMoreSheetOpen(false)} />
          <div className="more-sheet" role="dialog" aria-label={t('app_more_features')}>
            <div className="more-sheet__header">
              <span className="more-sheet__title">{t('app_more_features')}</span>
              <button type="button" className="icon-button" aria-label={t('common_close')} onClick={() => setMoreSheetOpen(false)}>
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
                  {t('app_bar_logout')}
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
