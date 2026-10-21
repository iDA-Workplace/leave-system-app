import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { Button, Card, Chip, ConfirmDialog, EmptyState, Skeleton } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useLanguage } from '../../context/LanguageContext'
import {
  activeSignups, callMassage, fetchOwnerName, fetchSessionBundle, fmtDate, fmtDateTime, fmtTime,
  holderOf, pendingOfferFor, phaseTone, sessionPhase, sessionWindow, slotEndAt, slotRange,
  slotStartAt, taipeiToday, waitlistOf,
} from '../../lib/massage'
import MassageRules from './MassageRules'

/** 同仁看到的「這一期」：最近一個還沒到的；都過了就顯示最近結束的那一期 */
async function fetchCurrentSession() {
  const today = taipeiToday()
  const { data: upcoming } = await supabase
    .from('massage_sessions').select('*')
    .gte('session_date', today).order('session_date').limit(1)
  if (upcoming?.length) return upcoming[0]
  const { data: past } = await supabase
    .from('massage_sessions').select('*')
    .lt('session_date', today).order('session_date', { ascending: false }).limit(1)
  return past?.[0] || null
}

/** 假單的簡短描述：「11/18 14:00–18:00 事假（審核中）」 */
function leaveText(leave, t, lang) {
  if (!leave) return ''
  const md = d => { const [, m, day] = d.split('-'); return `${Number(m)}/${Number(day)}` }
  const when = leave.start_date === leave.end_date
    ? `${md(leave.start_date)} ${leave.start_time}–${leave.end_time}`
    : `${md(leave.start_date)}–${md(leave.end_date)}`
  const type = (lang === 'en' && leave.leave_type_en) || leave.leave_type || ''
  return t('massage_leave_desc', { when, type, status: t(`massage_leave_status_${leave.status}`) })
}

function MassageHome({ userProfile, manager }) {
  const { t, lang } = useLanguage()
  const { showToast } = useToast()
  const [state, setState] = useState({ loading: true, session: null, signups: [], leave: null, ownerName: null })
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const reload = () => setTick(n => n + 1)
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const session = await fetchCurrentSession()
      let signups = []
      let leave = null
      if (session) {
        const bundle = await fetchSessionBundle(session.id)
        signups = bundle.signups
        const { data } = await supabase.rpc('massage_my_leave_status', { p_session_id: session.id })
        leave = data
      }
      const ownerName = await fetchOwnerName()
      if (!cancelled) setState({ loading: false, session, signups, leave, ownerName })
    })()
    return () => { cancelled = true }
  }, [tick])

  async function run(fn, args, successKey, params) {
    setBusy(true)
    const res = await callMassage(fn, args)
    setBusy(false)
    setConfirm(null)
    if (!res.ok) showToast(t(res.errorKey), { tone: 'error' })
    else if (successKey) showToast(t(successKey, params))
    reload()
  }

  const { loading, session, signups, leave, ownerName } = state

  // 從首頁過來：「按摩名單」帶 #massage-lists、「詳情與規則」帶 #massage-rules，
  // 資料載入後捲到那一塊
  useEffect(() => {
    if (!loading && (location.hash === '#massage-lists' || location.hash === '#massage-rules')) {
      document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [loading, location.hash])

  const managerLink = manager && (
    <div className="massage-toolbar">
      <Link to="/benefits/massage/manage" className="massage-link">{t('massage_manage_link')} →</Link>
    </div>
  )

  if (loading) return <div className="massage-page">{managerLink}<Skeleton height="160px" /></div>

  if (!session) {
    return (
      <div className="massage-page">
        {managerLink}
        <Card><EmptyState icon="💆" title={t('massage_no_session')} description={t('massage_no_session_desc')} /></Card>
        <MassageRules session={null} ownerName={ownerName} />
      </div>
    )
  }

  const now = new Date()
  const phase = sessionPhase(session, now)
  const win = sessionWindow(session)
  const active = activeSignups(signups)
  const mine = signups.find(s => s.user_id === userProfile?.id)

  return (
    <div className="massage-page">
      {managerLink}

      <Card className="massage-session">
        <div className="massage-session__head">
          <div>
            <div className="massage-session__title">{session.title}</div>
            <div className="massage-session__meta">{fmtDate(session.session_date, lang)} {win.from}–{win.to}</div>
          </div>
          <Chip tone={phaseTone(phase)}>{t(`massage_phase_${phase}`)}</Chip>
        </div>
        <dl className="massage-facts">
          <div><dt>{t('massage_signup_deadline')}</dt><dd>{fmtDateTime(session.signup_deadline, lang)}</dd></div>
          {session.draw_scheduled_at && (
            <div><dt>{t('massage_draw_time')}</dt><dd>{fmtDateTime(session.draw_scheduled_at, lang)}</dd></div>
          )}
          <div><dt>{t('massage_cancel_deadline')}</dt><dd>{fmtDateTime(session.cancel_deadline, lang)}</dd></div>
          <div><dt>{t('massage_capacity')}</dt><dd>{t('massage_capacity_value', { n: active.length, cap: session.slot_count })}</dd></div>
        </dl>
      </Card>

      <MyStatus
        session={session} phase={phase} now={now} mine={mine} signups={signups} leave={leave}
        busy={busy} run={run} setConfirm={setConfirm}
      />

      <PublicLists session={session} phase={phase} signups={signups} myId={userProfile?.id} />

      <MassageRules session={session} ownerName={ownerName} />

      {confirm && (
        <ConfirmDialog
          title={t(confirm.titleKey)}
          description={t(confirm.descKey, confirm.params)}
          confirmLabel={t(confirm.confirmKey)}
          danger={confirm.danger}
          loading={busy}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

/**
 * 「我的預約」卡片：依目前階段與自己的狀態，只顯示能做的事。
 * 首頁的「報名按摩」也用這一塊（embedded：不包卡片、不加標題），規則跟這裡完全一樣。
 */
export function MyStatus({ session, phase, now, mine, signups, leave, busy, run, setConfirm, embedded = false }) {
  const { t, lang } = useLanguage()
  const isActive = mine && !mine.released_at
  const okSlots = Array.isArray(leave?.ok_slots) ? leave.ok_slots : null

  let body = null

  if (phase === 'open') {
    if (!isActive) {
      if (leave?.state === 'blocked') {
        body = (
          <>
            <p className="massage-status__main">{t('massage_cannot_signup')}</p>
            <p className="massage-warn">{t('massage_leave_blocked', { leave: leaveText(leave.leave, t, lang) })}</p>
            <Button disabled>{t('massage_signup')}</Button>
          </>
        )
      } else {
        body = (
          <>
            <p className="massage-status__main">{t('massage_not_signed_up_open')}</p>
            {leave?.state === 'partial' && (
              <p className="massage-note">{t('massage_leave_partial', { leave: leaveText(leave.leave, t, lang) })}</p>
            )}
            <Button loading={busy} onClick={() => run('massage_sign_up', { p_session_id: session.id }, 'massage_toast_signed_up')}>
              {t('massage_signup')}
            </Button>
          </>
        )
      }
    } else {
      const order = activeSignups(signups)
        .sort((a, b) => new Date(a.signed_up_at) - new Date(b.signed_up_at))
        .findIndex(s => s.id === mine.id) + 1
      body = (
        <>
          <p className="massage-status__main">{t('massage_signed_up', { n: order })}</p>
          {leave?.state === 'partial' && (
            <p className="massage-note">{t('massage_leave_partial', { leave: leaveText(leave.leave, t, lang) })}</p>
          )}
          <Button variant="danger-outlined" onClick={() => setConfirm({
            titleKey: 'massage_confirm_withdraw_title', descKey: 'massage_confirm_withdraw_desc',
            confirmKey: 'massage_withdraw', danger: true,
            onConfirm: () => run('massage_release', { p_signup_id: mine.id }, 'massage_toast_withdrawn'),
          })}>{t('massage_withdraw')}</Button>
        </>
      )
    }
  } else if (phase === 'closed') {
    body = <p className="massage-status__main">{isActive ? t('massage_waiting_draw') : t('massage_closed_not_signed')}</p>
  } else if (!mine) {
    body = <p className="massage-status__main">{t('massage_not_in_session')}</p>
  } else if (mine.released_at) {
    const key = mine.yield_answer === 'yielded' ? 'massage_you_yielded'
      : mine.attendance === 'no_show' ? 'massage_you_no_show'
        : 'massage_you_released'
    body = <p className="massage-status__main">{t(key)}</p>
  } else if (mine.slot_no) {
    const r = slotRange(session, mine.slot_no)
    const started = now >= slotStartAt(session, mine.slot_no)
    const over = now >= slotEndAt(session, mine.slot_no)
    const conflict = mine.slot_conflict || (okSlots && !okSlots.includes(mine.slot_no))
    const late = now >= new Date(session.cancel_deadline)
    body = (
      <>
        <p className="massage-status__main">{t('massage_your_slot', { n: mine.slot_no, from: r.from, to: r.to })}</p>
        {mine.attendance && (
          <Chip tone={mine.attendance === 'attended' ? 'success' : 'error'}>{t(`massage_attendance_${mine.attendance}`)}</Chip>
        )}
        {conflict && !over && <p className="massage-warn">{t('massage_slot_conflict_warn')}</p>}

        {mine.yield_asked && !mine.yield_answer && !over && (
          <div className="massage-callout">
            <p>{t('massage_yield_question')}</p>
            <div className="massage-actions">
              <Button variant="outlined" loading={busy} onClick={() => run('massage_answer_yield', { p_signup_id: mine.id, p_yield: false }, 'massage_toast_kept')}>
                {t('massage_yield_keep')}
              </Button>
              <Button loading={busy} onClick={() => setConfirm({
                titleKey: 'massage_confirm_yield_title', descKey: 'massage_confirm_yield_desc',
                confirmKey: 'massage_yield_give',
                onConfirm: () => run('massage_answer_yield', { p_signup_id: mine.id, p_yield: true }, 'massage_toast_yielded'),
              })}>{t('massage_yield_give')}</Button>
            </div>
          </div>
        )}

        <div className="massage-actions">
          {started && !mine.attendance && (
            <Button loading={busy} onClick={() => run('massage_mark_done', { p_signup_id: mine.id }, 'massage_toast_done')}>
              {t('massage_mark_done')}
            </Button>
          )}
          {!started && (
            <Button variant="danger-outlined" onClick={() => setConfirm({
              titleKey: 'massage_confirm_release_title',
              descKey: late ? 'massage_confirm_release_late' : 'massage_confirm_release_desc',
              confirmKey: 'massage_release', danger: true,
              onConfirm: () => run('massage_release', { p_signup_id: mine.id }, 'massage_toast_released'),
            })}>{t('massage_release')}</Button>
          )}
        </div>
      </>
    )
  } else {
    // 候補
    const position = waitlistOf(signups).findIndex(s => s.id === mine.id) + 1
    const offer = mine.offer_status === 'pending' ? slotRange(session, mine.offer_slot_no) : null
    body = (
      <>
        {offer ? (
          <div className="massage-callout massage-callout--strong">
            <p className="massage-status__main">{t('massage_offer', { n: mine.offer_slot_no, from: offer.from, to: offer.to })}</p>
            <p className="massage-note">
              {mine.offer_expires_at
                ? t('massage_offer_until', { time: fmtTime(mine.offer_expires_at) })
                : t('massage_offer_no_limit')}
            </p>
            <div className="massage-actions">
              <Button loading={busy} onClick={() => run('massage_accept_offer', { p_signup_id: mine.id }, 'massage_toast_accepted')}>
                {t('massage_accept')}
              </Button>
              <Button variant="outlined" onClick={() => setConfirm({
                titleKey: 'massage_confirm_decline_title', descKey: 'massage_confirm_decline_desc',
                confirmKey: 'massage_decline', danger: true,
                onConfirm: () => run('massage_release', { p_signup_id: mine.id }, 'massage_toast_released'),
              })}>{t('massage_decline')}</Button>
            </div>
          </div>
        ) : (
          <>
            <p className="massage-status__main">{t('massage_waitlist_pos', { n: position })}</p>
            <p className="massage-note">{t('massage_waitlist_hint')}</p>
            {phase === 'drawn' && (
              <Button variant="danger-outlined" onClick={() => setConfirm({
                titleKey: 'massage_confirm_leave_waitlist_title', descKey: 'massage_confirm_leave_waitlist_desc',
                confirmKey: 'massage_leave_waitlist', danger: true,
                onConfirm: () => run('massage_release', { p_signup_id: mine.id }, 'massage_toast_released'),
              })}>{t('massage_leave_waitlist')}</Button>
            )}
          </>
        )}
      </>
    )
  }

  if (embedded) return <div className="massage-status">{body}</div>
  return (
    <Card className="massage-status">
      <h3 className="massage-card-title">{t('massage_my_booking')}</h3>
      {body}
    </Card>
  )
}

/** 公開的名單：抽籤前是報名名單，抽籤後是時段表＋候補名單（全公司都看得到） */
function PublicLists({ session, phase, signups, myId }) {
  const { t, lang } = useLanguage()
  const active = activeSignups(signups)
  const you = s => (s.user_id === myId ? t('massage_you_suffix') : '')

  if (phase === 'open' || phase === 'closed') {
    const list = [...active].sort((a, b) => new Date(a.signed_up_at) - new Date(b.signed_up_at))
    return (
      <Card className="massage-list" id="massage-lists">
        <h3 className="massage-card-title">{t('massage_signup_list', { n: list.length })}</h3>
        {list.length === 0 ? <p className="massage-hint">{t('massage_signup_list_empty')}</p> : (
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead><tr><th>#</th><th>{t('massage_col_name')}</th><th>{t('massage_col_signed_at')}</th></tr></thead>
              <tbody>
                {list.map((s, i) => (
                  <tr key={s.id}>
                    <td>{i + 1}</td>
                    <td>{s.user?.full_name}{you(s)}</td>
                    <td>{fmtDateTime(s.signed_up_at, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    )
  }

  const waitlist = waitlistOf(signups)
  return (
    <Card className="massage-list" id="massage-lists">
      <h3 className="massage-card-title">{t('massage_slot_table')}</h3>
      <div className="ui-table-wrap">
        <table className="ui-table">
          <thead><tr><th>{t('massage_col_slot')}</th><th>{t('massage_col_time')}</th><th>{t('massage_col_name')}</th><th></th></tr></thead>
          <tbody>
            {Array.from({ length: session.slot_count }, (_, i) => i + 1).map(n => {
              const r = slotRange(session, n)
              const h = holderOf(signups, n)
              const offer = !h && pendingOfferFor(signups, n)
              return (
                <tr key={n}>
                  <td>{n}</td>
                  <td>{r.from}–{r.to}</td>
                  <td>{h ? `${h.user?.full_name}${you(h)}` : <span className="massage-muted">{t('massage_slot_empty')}</span>}</td>
                  <td>
                    {h?.attendance === 'attended' && <Chip tone="success">{t('massage_attendance_attended')}</Chip>}
                    {offer && <Chip tone="warning">{t('massage_offering', { name: offer.user?.full_name })}</Chip>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {waitlist.length > 0 && (
        <>
          <h4 className="massage-subtitle">{t('massage_waitlist_title')}</h4>
          <ol className="massage-waitlist">
            {waitlist.map(s => <li key={s.id}>{s.user?.full_name}{you(s)}</li>)}
          </ol>
        </>
      )}
    </Card>
  )
}

export default MassageHome
