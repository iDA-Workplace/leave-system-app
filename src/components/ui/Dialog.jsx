import { useEffect, useRef } from 'react'
import Button from './Button'
import { useLanguage } from '../../context/LanguageContext'
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
    return () => { previouslyFocused?.focus?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 視窗只能用「取消／關閉」按鈕收起來 —— 點外面的灰色區域或按 Esc 都不會
  // 關閉。這兩種都太容易誤觸，而視窗裡常常是填到一半的表單（主管評分、員工
  // 自評、編輯員工資料），一關就整份不見，代價遠大於「少一種關閉方式」的
  // 不便。每個視窗本來就都有明確的關閉按鈕，不會關不掉。
  return (
    <div className="ui-dialog-scrim">
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
  title, description, confirmLabel, cancelLabel,
  danger = false, loading = false, onConfirm, onCancel,
}) {
  const { t } = useLanguage()
  confirmLabel = confirmLabel ?? t('common_confirm')
  cancelLabel = cancelLabel ?? t('common_cancel')
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
