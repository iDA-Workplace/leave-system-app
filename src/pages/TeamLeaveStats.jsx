import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Card, PageHeader, TextField } from '../components/ui'
import LeaveAnalytics from '../components/LeaveAnalytics'
import { useLanguage } from '../context/LanguageContext'
import { quickRange } from '../lib/dateRange'
import { TEAM_STATS_ROLES } from '../lib/teamStats'
import './ExportReport.css'

/**
 * 團隊請假統計（左側選單）。使用者 2026-11 決定：
 *   · 看得到的人：角色是主管／副主管／老闆（lib/teamStats.js，Layout.jsx 的選單也用這份）
 *   · 團隊 = 員工帳號管理裡「直屬主管」是自己的在職同仁（不含自己、不含部屬的部屬）
 *   · 網頁上只顯示：部門統計、職務代理人、個人請假狀況、特休使用狀況
 *   · 可以匯出 Excel（跟 HR 一樣的統計總表，只有自己的部屬）
 * 統計規則跟 HR 的「匯出報表 → 請假統計」完全一樣（同一個元件 LeaveAnalytics）。
 */
const TEAM_SECTIONS = ['departments', 'proxies', 'person', 'annual']

function TeamLeaveStats({ userProfile }) {
  const { t } = useLanguage()
  const [startDate, setStartDate] = useState(() => quickRange('year')[0])
  const [endDate, setEndDate] = useState(() => quickRange('year')[1])

  if (!TEAM_STATS_ROLES.includes(userProfile?.role)) return <Navigate to="/" replace />

  return (
    <div className="export-report-page">
      <PageHeader title={t('nav_team_stats')} />
      <Card>
        <div className="export-report-quick" role="group" aria-label={t('export_quick')}>
          {['month', 'quarter', 'year'].map(k => {
            const [s, e] = quickRange(k)
            return (
              <button key={k} type="button"
                className={`export-report-chip ${startDate === s && endDate === e ? 'is-active' : ''}`}
                onClick={() => { setStartDate(s); setEndDate(e) }}>
                {t(`export_quick_${k}`)}
              </button>
            )
          })}
        </div>
        <div className="export-report-grid">
          <TextField label={t('export_start_date')} type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          <TextField label={t('export_end_date')} type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} />
        </div>
        <div className="export-report-hint">{t('team_stats_hint')}</div>
      </Card>

      <LeaveAnalytics startDate={startDate} endDate={endDate} scope={{ managerId: userProfile.id }} sections={TEAM_SECTIONS} />
    </div>
  )
}

export default TeamLeaveStats
