import { createContext, useCallback, useContext, useRef, useState } from 'react'
import '../components/ui/ui.css'

const ToastContext = createContext(null)
let idSeq = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timers = useRef({})

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    clearTimeout(timers.current[id])
    delete timers.current[id]
  }, [])

  const showToast = useCallback((message, { tone = 'default', actionLabel, onAction, duration } = {}) => {
    idSeq += 1
    const id = idSeq
    setToasts((prev) => [...prev, { id, message, tone, actionLabel, onAction }])
    const autoDismissMs = duration ?? (tone === 'error' ? null : 4000)
    if (autoDismissMs) {
      timers.current[id] = setTimeout(() => dismiss(id), autoDismissMs)
    }
    return id
  }, [dismiss])

  return (
    <ToastContext.Provider value={{ showToast, dismiss }}>
      {children}
      <div className="ui-toast-region" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`ui-toast${t.tone === 'error' ? ' ui-toast--error' : ''}`} role={t.tone === 'error' ? 'alert' : 'status'}>
            <span>{t.message}</span>
            {t.actionLabel && (
              <button
                type="button"
                className="ui-toast__action"
                onClick={() => { t.onAction?.(); dismiss(t.id) }}
              >
                {t.actionLabel}
              </button>
            )}
            <button type="button" className="ui-toast__action" onClick={() => dismiss(t.id)} aria-label="關閉">✕</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
