import { Card } from '../../components/ui'
import { useLanguage } from '../../context/LanguageContext'
import { fmtDateTime, sessionWindow } from '../../lib/massage'

/**
 * 按摩預約規則（寫死在系統裡，使用者確認）。
 *
 * 內容來自原本「盲人按摩報名」試算表的規則分頁，加上 2026-10 確認的調整。
 * 數字（名額、分鐘數、截止時間）跟著這一期的設定走，不是寫死的。
 * 沒有任何一期時，用試算表原本的預設值顯示。
 */
function MassageRules({ session, ownerName }) {
  const { t, lang } = useLanguage()

  const slot = session?.slot_minutes ?? 15
  const brk = session?.break_minutes ?? 5
  const n = session?.slot_count ?? 9
  const win = session ? sessionWindow(session) : { from: '13:00', to: '16:00' }
  const signupDeadline = session ? fmtDateTime(session.signup_deadline, lang) : t('massage_rules_default_signup_deadline')
  const cancelDeadline = session ? fmtDateTime(session.cancel_deadline, lang) : t('massage_rules_default_cancel_deadline')

  const sections = [
    ['massage_rules_basic_h', [
      t('massage_rules_basic_1', { slot, brk }),
      t('massage_rules_basic_2', { n, from: win.from, to: win.to }),
    ]],
    ['massage_rules_signup_h', [
      t('massage_rules_signup_1'),
      t('massage_rules_signup_2', { deadline: signupDeadline }),
      t('massage_rules_signup_3'),
    ]],
    ['massage_rules_draw_h', [
      t('massage_rules_draw_1', { n }),
      t('massage_rules_draw_2', { n }),
      t('massage_rules_draw_3'),
      t('massage_rules_draw_4'),
    ]],
    ['massage_rules_cancel_h', [
      t('massage_rules_cancel_1', { deadline: cancelDeadline }),
      t('massage_rules_cancel_2'),
      t('massage_rules_cancel_3'),
      t('massage_rules_cancel_4'),
    ]],
    ['massage_rules_health_h', [
      t('massage_rules_health_1'),
    ]],
  ]

  return (
    <Card className="massage-rules">
      <h3 className="massage-card-title">{t('massage_rules_title')}</h3>
      {sections.map(([heading, items]) => (
        <section key={heading} className="massage-rules__section">
          <h4 className="massage-rules__heading">{t(heading)}</h4>
          <ul className="massage-rules__list">
            {items.map((text, i) => <li key={i}>{text}</li>)}
          </ul>
        </section>
      ))}
      {ownerName && <p className="massage-hint">{t('massage_rules_owner', { name: ownerName })}</p>}
    </Card>
  )
}

export default MassageRules
