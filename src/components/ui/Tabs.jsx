import { Link } from 'react-router-dom'
import './ui.css'

// `tabs`: [{ key, label, to?, onClick?, active, badge? }]
// `badge` is an unread count; falsy (including 0) renders nothing.
function Tabs({ tabs }) {
  return (
    <div className="ui-tabs" role="tablist">
      {tabs.map((t) => {
        const className = `ui-tab${t.active ? ' ui-tab--active' : ''}`
        const content = (
          <>
            {t.label}
            {t.badge ? (
              <span className="ui-tab__badge" aria-label={`${t.badge} 則未讀`}>{t.badge}</span>
            ) : null}
          </>
        )
        if (t.to) {
          return (
            <Link key={t.key} to={t.to} className={className} role="tab" aria-selected={t.active}>
              {content}
            </Link>
          )
        }
        return (
          <button key={t.key} type="button" className={className} role="tab" aria-selected={t.active} onClick={t.onClick}>
            {content}
          </button>
        )
      })}
    </div>
  )
}

export default Tabs
