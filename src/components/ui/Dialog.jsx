import { useEffect, useRef } from 'react'
import Button from './Button'
import './ui.css'

export function Dialog({ title, children, actions, onClose, labelledBy }) {
  const dialogRef = useRef(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement
    dialogRef.current?.focus()

    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [onClose])

  return (
    <div className="ui-dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div
        className="ui-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        ref={dialogRef}
      >
        {title && <h3 className="ui-dialog__title" id={labelledBy}>{title}</h3>}
        <div className="ui-dialog__body">{children}</div>
        {actions && <div className="ui-dialog__actions">{actions}</div>}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  title, description, confirmLabel = '確定', cancelLabel = '取消',
  danger = false, loading = false, onConfirm, onCancel,
}) {
  return (
    <Dialog
      title={title}
      labelledBy="ui-confirm-dialog-title"
      onClose={onCancel}
      actions={(
        <>
          <Button variant="text" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'filled'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {description}
    </Dialog>
  )
}

export default Dialog
