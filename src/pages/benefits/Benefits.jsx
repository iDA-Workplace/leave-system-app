import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { PageHeader, Tabs } from '../../components/ui'
import { useLanguage } from '../../context/LanguageContext'
import Massage from './Massage'

/**
 * 員工福利。目前只有按摩預約；之後的員工旅遊等其他福利也加在這裡的分頁，
 * 左邊選單維持只有一個「員工福利」入口。
 */
function Benefits({ userProfile }) {
  const { t } = useLanguage()
  const location = useLocation()

  const tabs = [
    {
      key: 'massage',
      label: t('benefits_tab_massage'),
      to: '/benefits/massage',
      active: location.pathname.startsWith('/benefits/massage'),
    },
  ]

  return (
    <div>
      <PageHeader title={t('nav_benefits')} />
      <Tabs tabs={tabs} />
      <Routes>
        <Route index element={<Navigate to="massage" replace />} />
        <Route path="massage/*" element={<Massage userProfile={userProfile} />} />
        <Route path="*" element={<Navigate to="/benefits/massage" replace />} />
      </Routes>
    </div>
  )
}

export default Benefits
