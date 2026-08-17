import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { translations } from '../i18n/translations'

const STORAGE_KEY = 'leave-system-language'
const LanguageContext = createContext(null)

function readStoredLang() {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'en' ? 'en' : 'zh'
}

export function LanguageProvider({ children }) {
  const [lang, setLang] = useState(readStoredLang)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, lang)
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant'
  }, [lang])

  const t = useMemo(() => {
    const lookup = (key) => translations[lang]?.[key] ?? translations.zh[key]

    // t('key') or t('key', { name: '小明', n: 3 }) —— 字典裡用 {name} 當佔位符。
    // 找不到 key 時退回中文，再找不到就把 key 本身吐出來，這樣漏翻的地方在畫
    // 面上一眼就看得出來，而不是變成空白。
    //
    // 單複數：只要傳了 n，就先找 `key_one`（n 剛好是 1 時）。中文沒有單複數
    // 之分，字典裡不會有 _one，自動退回原本那一條；英文才需要「1 hr」跟
    // 「3 hrs」分開寫。
    return (key, params) => {
      let text
      if (params && Number(params.n) === 1) text = lookup(`${key}_one`)
      if (text == null) text = lookup(key) ?? key
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          text = text.split(`{${name}}`).join(String(value))
        }
      }
      return text
    }
  }, [lang])

  const value = useMemo(() => ({ lang, setLang, t }), [lang, t])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider')
  return ctx
}
