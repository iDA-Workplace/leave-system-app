import { useEffect, useState } from 'react'
import { Button, Card, Chip, Dialog, Textarea } from './ui'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'
import { decideProxy, fetchMyProxyRequests, PROXY_TODO_EVENT } from '../lib/proxy'

/**
 * 首頁「待你確認的職務代理」（2026-11）。
 *
 * 同仁請假時指定你當職務代理人，你同意之後假單才會送給主管審核。
 * 只顯示基本資料（誰、什麼假、哪天、幾點），看不到事由與附件（使用者決定）。
 * 沒有待確認的就整張卡片不顯示，一般同仁平常不會看到它。
 */
export default function ProxyRequestsCard() {
  const { t, lang } = useLanguage()
  const { showToast } = useToast()
  const [rows, setRows] = useState([])
  const [actingId, setActingId] = useState(null)
  const [declining, setDeclining] = useState(null)
  const [reason, setReason] = useState('')

  useEffect(() => {
    let alive = true
    const load = () => fetchMyProxyRequests().then(r => { if (alive) setRows(r) })
    load()
    window.addEventListener(PROXY_TODO_EVENT, load)
    return () => { alive = false; window.removeEventListener(PROXY_TODO_EVENT, load) }
  }, [])

  function resultToast(result, name) {
    if (result === 'approved') showToast(t('proxy_toast_approved', { name }))
    else if (result === 'approved_final') showToast(t('proxy_toast_approved_final', { name }))
    else if (result === 'returned') showToast(t('proxy_toast_returned', { name }))
    else if (result === 'reason_required') showToast(t('proxy_err_reason'), { tone: 'error' })
    else showToast(t('proxy_err_handled'), { tone: 'error' })
  }

  async function accept(row) {
    setActingId(row.id)
    try {
      resultToast(await decideProxy(row.id, true), row.requester_name)
    } catch (e) {
      showToast(t('proxy_err_failed', { msg: e.message }), { tone: 'error' })
    }
    setActingId(null)
  }

  async function submitDecline() {
    if (!reason.trim()) { showToast(t('proxy_err_reason'), { tone: 'error' }); return }
    setActingId(declining.id)
    try {
      resultToast(await decideProxy(declining.id, false, reason.trim()), declining.requester_name)
      setDeclining(null)
      setReason('')
    } catch (e) {
      showToast(t('proxy_err_failed', { msg: e.message }), { tone: 'error' })
    }
    setActingId(null)
  }

  if (rows.length === 0) return null

  const typeName = r => (lang === 'en' && r.leave_type_name_en) || r.leave_type_name || '—'
  const when = r => {
    if (r.end_date && r.end_date > r.start_date) return `${r.start_date} ~ ${r.end_date}`
    const time = r.start_time && r.end_time ? ` ${r.start_time.slice(0, 5)}~${r.end_time.slice(0, 5)}` : ''
    return `${r.start_date}${time}`
  }

  return (
    <Card className="dash-approval-card" id="pending-proxy">
      <div className="dash-card-header">
        <span className="dash-card-header__title">🤝 {t('proxy_card_title')}</span>
      </div>
      <p className="dash-empty-hint" style={{ textAlign: 'left', margin: '0 0 var(--space-150)' }}>{t('proxy_card_hint')}</p>
      <div className="ui-table-wrap">
        <table className="ui-table dash-approval-table">
          <thead>
            <tr><th>{t('home_employee_name')}</th><th>{t('field_leave_type')}</th><th>{t('field_leave_dates')}</th><th>{t('common_actions')}</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{r.requester_name}</td>
                <td><Chip tone="info">{typeName(r)}</Chip></td>
                <td className="tabular">{when(r)}</td>
                <td>
                  <div className="dash-approval-table__actions">
                    <Button size="sm" variant="outlined" disabled={actingId === r.id} onClick={() => { setDeclining(r); setReason('') }}>{t('proxy_decline')}</Button>
                    <Button size="sm" loading={actingId === r.id} onClick={() => accept(r)}>{t('proxy_accept')}</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {declining && (
        <Dialog
          title={t('proxy_decline_title', { name: declining.requester_name })}
          labelledBy="proxy-decline-title"
          onClose={() => setDeclining(null)}
          actions={(
            <>
              <Button variant="text" onClick={() => setDeclining(null)}>{t('common_cancel')}</Button>
              <Button variant="danger" loading={actingId === declining.id} onClick={submitDecline}>{t('proxy_decline_submit')}</Button>
            </>
          )}
        >
          <p className="admin-form-card__hint">{t('proxy_decline_hint')}</p>
          <Textarea
            label={t('proxy_decline_reason')}
            required
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder={t('proxy_decline_placeholder')}
          />
        </Dialog>
      )}
    </Card>
  )
}
