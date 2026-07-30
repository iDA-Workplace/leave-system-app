import './ui.css'

function Skeleton({ width = '100%', height = '1em', style, className = '' }) {
  return (
    <div
      className={`ui-skeleton ${className}`}
      style={{ width, height, ...style }}
      aria-hidden="true"
    />
  )
}

export default Skeleton
