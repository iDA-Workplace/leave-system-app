import './ui.css'

let uid = 0
function useFieldId(id) {
  if (id) return id
  uid += 1
  return `ui-field-${uid}`
}

function FieldShell({ label, required, error, helper, htmlFor, children }) {
  return (
    <div className={`ui-field${error ? ' ui-field--error' : ''}`}>
      {label && (
        <label className="ui-field__label" htmlFor={htmlFor}>
          {label}{required && <span className="ui-field__required">*</span>}
        </label>
      )}
      {children}
      {error ? <span className="ui-field__error">{error}</span> : helper ? <span className="ui-field__helper">{helper}</span> : null}
    </div>
  )
}

export function TextField({ label, required, error, helper, id, className = '', ...props }) {
  const fieldId = useFieldId(id)
  return (
    <FieldShell label={label} required={required} error={error} helper={helper} htmlFor={fieldId}>
      <input id={fieldId} className={`ui-field__control ${className}`} {...props} />
    </FieldShell>
  )
}

export function Textarea({ label, required, error, helper, id, className = '', ...props }) {
  const fieldId = useFieldId(id)
  return (
    <FieldShell label={label} required={required} error={error} helper={helper} htmlFor={fieldId}>
      <textarea id={fieldId} className={`ui-field__control ${className}`} {...props} />
    </FieldShell>
  )
}

export function Select({ label, required, error, helper, id, children, className = '', ...props }) {
  const fieldId = useFieldId(id)
  return (
    <FieldShell label={label} required={required} error={error} helper={helper} htmlFor={fieldId}>
      <select id={fieldId} className={`ui-field__control ${className}`} {...props}>
        {children}
      </select>
    </FieldShell>
  )
}
