import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, Skeleton, TextField } from '../components/ui'
import { useToast } from '../context/ToastContext'
import './AdminPanel.css'

/**
 * 假別英文名稱（leave_types.name_en）
 *
 * 假別名稱是資料庫裡的資料，不是介面文字，所以沒辦法寫進前端的 i18n 字典 ——
 * 只能在這裡逐一維護。留白＝切成英文時沿用中文名，不會變空白。
 *
 * 刻意做成獨立元件：管理員（負責用字是否正確）跟財務（負責額度）都要用得到，
 * 兩邊共用同一份，不會出現兩套行為不一樣的輸入框。
 */
function LeaveTypeNames() {
  const [leaveTypes, setLeaveTypes] = useState([])
  const [namesEn, setNamesEn] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const { showToast } = useToast()

  useEffect(() => { fetchTypes() }, [])

  async function fetchTypes() {
    const { data, error } = await supabase.from('leave_types').select('*').order('name')
    if (error) {
      showToast('讀取假別失敗：' + error.message, { tone: 'error' })
      setLoading(false)
      return
    }
    setLeaveTypes(data || [])
    setNamesEn(Object.fromEntries((data || []).map(t => [t.id, t.name_en || ''])))
    setLoading(false)
  }

  async function handleSave() {
    setSaving(true)
    for (const t of leaveTypes) {
      const value = (namesEn[t.id] || '').trim() || null
      if ((t.name_en ?? null) === value) continue
      const { data: updated, error } = await supabase.from('leave_types')
        .update({ name_en: value }).eq('id', t.id).select()
      // RLS 擋下 UPDATE 時 Postgres 不會報錯，只會回 0 列 —— 所以 0 列也算失敗，
      // 否則會出現「顯示已儲存、實際上什麼都沒寫進去」。
      if (error || !updated?.length) {
        showToast(`「${t.name}」的英文名儲存失敗：` + (error?.message || '沒有權限寫入'), { tone: 'error' })
        setSaving(false)
        return
      }
    }
    setSaving(false)
    showToast('已更新假別英文名稱')
    fetchTypes()
  }

  return (
    <Card className="admin-form-card">
      <h4 className="admin-form-card__title">假別英文名稱</h4>
      <p className="admin-form-card__hint">
        同仁把介面語言切成 English 時顯示的假別名稱。留白的話會直接顯示中文名，不會變空白。
      </p>
      {loading ? <Skeleton height="120px" /> : (
        <>
          <div className="admin-form-grid">
            {leaveTypes.map(t => (
              <TextField
                key={t.id}
                label={t.name}
                value={namesEn[t.id] ?? ''}
                onChange={e => setNamesEn(p => ({ ...p, [t.id]: e.target.value }))}
                placeholder="留白＝顯示中文名"
              />
            ))}
          </div>
          <div className="admin-form-actions">
            <Button loading={saving} onClick={handleSave}>儲存英文名稱</Button>
          </div>
        </>
      )}
    </Card>
  )
}

export default LeaveTypeNames
