import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'
import { attachmentPath } from '../lib/attachments'

/**
 * 假單附件的「查看附件」連結（2026-11 第 2 階段第 6 步）。
 *
 * 附件儲存空間改成不公開：點的時候才向 Supabase 要一個 5 分鐘有效的連結再打開。
 * 資料庫會再確認一次這個人能不能看這張假單（本人、流程裡的簽核人、直屬主管、HR），
 * 所以連結就算被看到也無法給別人用太久，沒權限的人也拿不到連結。
 */
export default function AttachmentLink({ leave }) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [busy, setBusy] = useState(false)
  const path = attachmentPath(leave)
  if (!path) return null

  async function open() {
    // 先開視窗再填網址：等連結回來才開的話，瀏覽器（尤其 iOS Safari）會當成彈出視窗擋掉
    const win = window.open('', '_blank')
    setBusy(true)
    const { data, error } = await supabase.storage.from('leave-attachments').createSignedUrl(path, 300)
    setBusy(false)
    if (error || !data?.signedUrl) {
      win?.close()
      showToast(t('attachment_err_open'), { tone: 'error' })
      return
    }
    if (win) win.location.href = data.signedUrl
    else window.location.href = data.signedUrl
  }

  return (
    <button type="button" className="attachment-link" onClick={open} disabled={busy}
      title={leave.attachment_name || ''}>
      📎 {t('attachment_view')}
    </button>
  )
}
