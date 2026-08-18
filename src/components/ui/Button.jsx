import './ui.css'

const VARIANT_CLASS = {
  filled: 'ui-btn--filled',
  tonal: 'ui-btn--tonal',
  outlined: 'ui-btn--outlined',
  text: 'ui-btn--text',
  danger: 'ui-btn--danger',
  'danger-outlined': 'ui-btn--danger-outlined',
}

function Button({ variant = 'filled', size, loading = false, disabled, block = false, children, className = '', ...props }) {
  const classes = [
    'ui-btn',
    VARIANT_CLASS[variant] || VARIANT_CLASS.filled,
    size === 'sm' ? 'ui-btn--sm' : '',
    block ? 'ui-btn--block' : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <button className={classes} disabled={disabled || loading} {...props}>
      {loading && <span className="ui-btn__spinner" aria-hidden="true" />}
      {children}
    </button>
  )
}

export default Button
