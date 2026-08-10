import { useEffect, useRef } from 'react'
import Button from './Button'
import './ui.css'

export function Dialog({ title, children, actions, onClose, labelledBy, size }) {
  const dialogRef = useRef(null)
  // Callers routinely pass an inline arrow function as onClose, which is a
  // new reference on every render of the parent (e.g. every keystroke in a
  // field inside this dialog, since that updates the parent's state). A ref
  // lets the Escape handler always call the latest onClose without making
  // it an effect dependency -- putting onClose in the deps array made this
  // effect re-run on every parent re-render, which re-focused the dialog
  // wrapper (dialogRef.current.focus()) and yanked focus straight out from
  // under whatever input the user was typing into.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previouslyFocused = document.activeElement
    dialogRef.current?.focus()

    function handleKeyDown(e) {
      if (e.key === 'Escape') onCloseRef.current?.()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="ui-dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div
        className={`ui-dialog${size === 'lg' ? ' ui-dialog--lg' : ''}`}
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
