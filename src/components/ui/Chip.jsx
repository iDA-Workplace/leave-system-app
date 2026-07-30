import './ui.css'

const TONE_CLASS = {
  neutral: 'ui-chip--neutral',
  warning: 'ui-chip--warning',
  success: 'ui-chip--success',
  error: 'ui-chip--error',
  info: 'ui-chip--info',
}

function Chip({ tone = 'neutral', children, className = '', ...props }) {
  const classes = ['ui-chip', TONE_CLASS[tone] || TONE_CLASS.neutral, className].filter(Boolean).join(' ')
  return (
    <span className={classes} {...props}>
      {children}
    </span>
  )
}

export default Chip
