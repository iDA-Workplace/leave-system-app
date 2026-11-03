/**
 * 上傳附件前把「照片」縮小（使用者決定）。手機拍的診斷證明動輒 3～5 MB，
 * 縮到長邊 2000 像素、JPEG 品質 0.82 之後通常只剩幾百 KB，文字一樣清楚。
 * 省下的是 Supabase 的檔案空間（免費方案 1 GB）。
 *
 * 只處理 JPG / PNG；PDF 和其他檔案原樣上傳。壓完反而變大（例如本來就很小的截圖）、
 * 或瀏覽器讀不了這張圖，就用原檔 —— 寧可多佔一點空間，也不要讓上傳失敗。
 */
const MAX_SIDE = 2000
const QUALITY = 0.82

export async function compressImage(file) {
  if (!/^image\/(jpeg|png)$/.test(file.type)) return file
  try {
    // 照片的方向（手機直拍）照 EXIF 轉正
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    // PNG 透明的地方轉成 JPEG 會變黑，先鋪白底
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
    if (!blob || blob.size >= file.size) return file
    const name = file.name.replace(/\.(jpe?g|png)$/i, '') + '.jpg'
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified })
  } catch {
    return file
  }
}
