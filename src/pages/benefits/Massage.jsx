import { Routes, Route, Navigate } from 'react-router-dom'
import { isMassageManager } from '../../lib/massage'
import MassageHome from './MassageHome'
import MassageManage from './MassageManage'
import MassageSessionPanel from './MassageSessionPanel'
import MassageDraw from './MassageDraw'
import './Massage.css'

/**
 * 按摩預約。
 *   /benefits/massage                 同仁：本期預約、名單、規則
 *   /benefits/massage/manage          管理者：開新的一期、各期列表
 *   /benefits/massage/manage/:id      管理者：某一期的現場面板（沒到、指定遞補、改時段、出席）
 *   /benefits/massage/draw/:id        管理者：公開抽籤畫面
 *
 * 管理頁面在前端只是「不顯示」；真正的權限檢查在資料庫函式裡。
 */
function Massage({ userProfile }) {
  const manager = isMassageManager(userProfile)
  return (
    <Routes>
      <Route index element={<MassageHome userProfile={userProfile} manager={manager} />} />
      {manager && <Route path="manage" element={<MassageManage userProfile={userProfile} />} />}
      {manager && <Route path="manage/:sessionId" element={<MassageSessionPanel />} />}
      {manager && <Route path="draw/:sessionId" element={<MassageDraw />} />}
      <Route path="*" element={<Navigate to="/benefits/massage" replace />} />
    </Routes>
  )
}

export default Massage
