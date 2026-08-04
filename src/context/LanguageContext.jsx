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
  }, [lang])

  const t = useMemo(() => {
    return (key) => translations[lang]?.[key] ?? translations.zh[key] ?? key
  }, [lang])

  const value = useMemo(() => ({ lang, setLang, t }), [lang, t])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider')
  return ctx
}
