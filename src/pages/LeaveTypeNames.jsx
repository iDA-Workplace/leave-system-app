import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Card, Skeleton, TextField } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'
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
  const { t } = useLanguage()

  useEffect(() => { fetchTypes() }, [])

  async function fetchTypes() {
    const { data, error } = await supabase.from('leave_types').select('*').order('name')
    if (error) {
      showToast(t('ltnames_err_fetch', { msg: error.message }), { tone: 'error' })
      setLoading(false)
      return
    }
    setLeaveTypes(data || [])
    setNamesEn(Object.fromEntries((data || []).map(lt => [lt.id, lt.name_en || ''])))
    setLoading(false)
  }

  async function handleSave() {
    setSaving(true)
    // 迴圈變數刻意不叫 t —— 那會遮蔽翻譯用的 t()
    for (const lt of leaveTypes) {
      const value = (namesEn[lt.id] || '').trim() || null
      if ((lt.name_en ?? null) === value) continue
      const { data: updated, error } = await supabase.from('leave_types')
        .update({ name_en: value }).eq('id', lt.id).select()
      // RLS 擋下 UPDATE 時 Postgres 不會報錯，只會回 0 列 —— 所以 0 列也算失敗，
      // 否則會出現「顯示已儲存、實際上什麼都沒寫進去」。
      if (error || !updated?.length) {
        showToast(t('ltnames_err_save', { name: lt.name, msg: error?.message || t('admin_no_write_permission') }), { tone: 'error' })
        setSaving(false)
        return
      }
    }
    setSaving(false)
    showToast(t('ltnames_saved'))
    fetchTypes()
  }

  return (
    <Card className="admin-form-card">
      <h4 className="admin-form-card__title">{t('ltnames_title')}</h4>
      <p className="admin-form-card__hint">{t('ltnames_hint')}</p>
      {loading ? <Skeleton height="120px" /> : (
        <>
          <div className="admin-form-grid">
            {leaveTypes.map(lt => (
              <TextField
                key={lt.id}
                label={lt.name}
                value={namesEn[lt.id] ?? ''}
                onChange={e => setNamesEn(p => ({ ...p, [lt.id]: e.target.value }))}
                placeholder={t('ltnames_placeholder')}
              />
            ))}
          </div>
          <div className="admin-form-actions">
            <Button loading={saving} onClick={handleSave}>{t('ltnames_save')}</Button>
          </div>
        </>
      )}
    </Card>
  )
}

export default LeaveTypeNames
