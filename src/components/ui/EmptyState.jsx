import './ui.css'

function EmptyState({ icon = '📭', title, description, action }) {
  return (
    <div className="ui-empty-state">
      <div className="ui-empty-state__icon" aria-hidden="true">{icon}</div>
      {title && <div className="ui-empty-state__title">{title}</div>}
      {description && <div className="ui-empty-state__description">{description}</div>}
      {action}
    </div>
  )
}

export default EmptyState
