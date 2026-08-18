import './ui.css'

function Card({ children, flush = false, style, className = '', ...props }) {
  const classes = ['ui-card', flush ? 'ui-card--flush' : '', className].filter(Boolean).join(' ')
  return (
    <div className={classes} style={style} {...props}>
      {children}
    </div>
  )
}

export default Card
