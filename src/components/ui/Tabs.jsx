import { Link } from 'react-router-dom'
import './ui.css'

// `tabs`: [{ key, label, to?, onClick?, active }]
function Tabs({ tabs }) {
  return (
    <div className="ui-tabs" role="tablist">
      {tabs.map((t) => {
        const className = `ui-tab${t.active ? ' ui-tab--active' : ''}`
        if (t.to) {
          return (
            <Link key={t.key} to={t.to} className={className} role="tab" aria-selected={t.active}>
              {t.label}
            </Link>
          )
        }
        return (
          <button key={t.key} type="button" className={className} role="tab" aria-selected={t.active} onClick={t.onClick}>
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

export default Tabs
