#!/usr/bin/env node
// 從 index.ts + _shared/*.ts 產生 standalone.ts。
//
// Supabase 後台的網頁版 Edge Function 編輯器一次只能貼一個檔案，不支援
// import '../_shared/...'，所以每支 function 都要有一份把共用程式碼攤平的
// standalone.ts。手動維護兩份副本遲早會改到不一致（已經發生過），所以改成
// 用這支腳本產生。
//
//   node supabase/functions/build-standalone.mjs
//
// 改完 index.ts 或 _shared/ 之後跑一次，standalone.ts 會自動同步。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const TARGETS = ['send-slack-notification', 'daily-leave-digest', 'daily-leave-job']

// 兩種相對路徑都要接受：index.ts 從自己的目錄看 _shared 是 '../_shared/xxx.ts'；
// _shared 底下的檔案彼此互相 import（例如 leave.ts 用到 i18n.ts 的 t()）則是
// 同目錄的 './xxx.ts'。少了後者，_shared 檔案之間的 import 沒被攤平腳本認得、
// 沒被剝掉，會直接把攤平不掉的 import 語句原封不動地留在 standalone.ts 裡，
// 貼到 Supabase 網頁編輯器會找不到模組而炸掉。
const SHARED_IMPORT = /^import\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+'((?:\.\.\/_shared\/|\.\/)[^']+)'\s*$/gm
const EXTERNAL_IMPORT = /^import\s+.*?from\s+'(https?:\/\/[^']+)'\s*$/gm

/** 把共用檔轉成可直接內聯的內容：拿掉 export、抽出外部 import。 */
function flattenShared(path, externals) {
  let src = readFileSync(path, 'utf8')
  src = src.replace(EXTERNAL_IMPORT, (line) => { externals.add(line.trim()); return '' })
  // 共用檔內部彼此的 import 也一併移除（攤平後同一個檔案裡本來就看得到）
  src = src.replace(SHARED_IMPORT, '')
  // 只去掉行首的 export 關鍵字，不動 "export default" 之外的其他語意
  return src.replace(/^export\s+(?=(async\s+)?(function|const|let|class|interface|type)\b)/gm, '')
}

let changed = 0
for (const name of TARGETS) {
  const indexPath = join(ROOT, name, 'index.ts')
  if (!existsSync(indexPath)) { console.warn(`跳過 ${name}：找不到 index.ts`); continue }

  const index = readFileSync(indexPath, 'utf8')
  const externals = new Set()
  const sharedPaths = [...index.matchAll(SHARED_IMPORT)].map(m => m[1])

  const sharedBodies = sharedPaths.map(rel => {
    const p = resolve(join(ROOT, name), rel)
    return `// ───── 內聯自 ${rel} ─────\n${flattenShared(p, externals).trim()}`
  })

  const body = index.replace(SHARED_IMPORT, '').replace(EXTERNAL_IMPORT, (line) => {
    externals.add(line.trim()); return ''
  })

  const header = `// ⚠️ 這個檔案是「自動產生」的，不要直接編輯。
//
// 由 supabase/functions/build-standalone.mjs 從 ${name}/index.ts 與
// _shared/*.ts 攤平而成，給 Supabase 後台的網頁版編輯器貼上用
// （網頁編輯器不支援多檔案匯入）。
//
// 要改邏輯請改 index.ts，然後跑：
//   node supabase/functions/build-standalone.mjs
`

  const out = [header, [...externals].join('\n'), ...sharedBodies, body.trim()]
    .filter(Boolean).join('\n\n') + '\n'

  const outPath = join(ROOT, name, 'standalone.ts')
  const prev = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
  if (prev !== out) { writeFileSync(outPath, out); changed++; console.log(`已更新 ${name}/standalone.ts`) }
  else console.log(`${name}/standalone.ts 已是最新`)
}

console.log(changed === 0 ? '全部已同步。' : `完成，共更新 ${changed} 個檔案。`)
