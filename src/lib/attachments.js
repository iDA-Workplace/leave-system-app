/** 附件在 leave-attachments 儲存空間裡的路徑。舊的假單只存了公開網址（attachment_url），沒有路徑時從網址裡取出。 */
export function attachmentPath(leave) {
  if (leave?.attachment_path) return leave.attachment_path
  const m = /\/leave-attachments\/([^?#]+)/.exec(leave?.attachment_url || '')
  if (!m) return null
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}
