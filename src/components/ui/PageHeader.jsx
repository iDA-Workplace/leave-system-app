import './ui.css'

function PageHeader({ title, badge, actions }) {
  return (
    <div className="ui-page-header">
      <h2 className="ui-page-header__title">
        {title}
        {badge}
      </h2>
      {actions && <div className="ui-page-header__actions">{actions}</div>}
    </div>
  )
}

export default PageHeader
