import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, ConfirmDialog, Skeleton } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useLanguage } from '../../context/LanguageContext'
import {
  activeSignups, callMassage, fetchSessionBundle, fmtDate, fmtDateTime, holderOf,
  sessionWindow, slotRange, waitlistOf,
} from '../../lib/massage'

/**
 * 公開抽籤畫面。會投影給大家看，所以字要大、資訊要少。
 *
 * 規則（使用者確認）：
 *   · 只有管理員 / HR 能按（這個頁面本身也只有管理者進得來）
 *   · 抽一次就鎖定，不能重抽 —— 資料庫層也擋了，這裡只是事先講清楚
 *   · 結果一次全部公布
 *   · 報名人數沒超過名額時不抽籤，按下去就是照報名先後排定時段
 */
function MassageDraw() {
  const { sessionId } = useParams()
  const { t, lang } = useLanguage()
  const { showToast } = useToast()
  const stageRef = useRef(null)
  const [state, setState] = useState({ loading: true, session: null, signups: [] })
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const bundle = await fetchSessionBundle(sessionId)
      if (!cancelled) setState({ loading: false, ...bundle })
    })()
    return () => { cancelled = true }
  }, [sessionId, tick])

  async function draw() {
    setBusy(true)
    const res = await callMassage('massage_run_draw', { p_session_id: sessionId })
    setBusy(false)
    setConfirming(false)
    if (!res.ok) showToast(t(res.errorKey), { tone: 'error' })
    setTick(n => n + 1)
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.()
    else stageRef.current?.requestFullscreen?.()
  }

  const { loading, session, signups } = state
  if (loading) return <div className="massage-page"><Skeleton height="300px" /></div>
  if (!session) return <div className="massage-page"><p>{t('massage_session_not_found')}</p></div>

  const win = sessionWindow(session)
  const active = activeSignups(signups)
  const overCapacity = active.length > session.slot_count
  const beforeDeadline = new Date() < new Date(session.signup_deadline)
  const waitlist = waitlistOf(signups)

  return (
    <div className="massage-page">
      <div className="massage-toolbar">
        <Link to={`/benefits/massage/manage/${session.id}`} className="massage-link">← {t('massage_back_panel')}</Link>
        <Button size="sm" variant="outlined" onClick={toggleFullscreen}>{t('massage_fullscreen')}</Button>
      </div>

      <div className="massage-stage" ref={stageRef}>
        <div className="massage-stage__head">
          <div className="massage-stage__title">{session.title}</div>
          <div className="massage-stage__meta">
            {fmtDate(session.session_date, lang)} {win.from}–{win.to} · {t('massage_capacity_value', { n: active.length, cap: session.slot_count })}
          </div>
        </div>

        {!session.drawn_at ? (
          <>
            <div className="massage-stage__names">
              {[...active]
                .sort((a, b) => new Date(a.signed_up_at) - new Date(b.signed_up_at))
                .map(s => <span key={s.id} className="massage-stage__name">{s.user?.full_name}</span>)}
            </div>
            <div className="massage-stage__cta">
              {beforeDeadline ? (
                <p className="massage-stage__note">{t('massage_draw_wait_deadline', { time: fmtDateTime(session.signup_deadline, lang) })}</p>
              ) : (
                <>
                  <p className="massage-stage__note">
                    {overCapacity ? t('massage_draw_note_lottery', { n: session.slot_count }) : t('massage_draw_note_no_lottery', { n: session.slot_count })}
                  </p>
                  <Button onClick={() => setConfirming(true)} disabled={active.length === 0}>
                    {overCapacity ? t('massage_draw_start') : t('massage_draw_assign')}
                  </Button>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="massage-stage__grid">
              {Array.from({ length: session.slot_count }, (_, i) => i + 1).map(n => {
                const r = slotRange(session, n)
                const h = holderOf(signups, n)
                return (
                  <div key={n} className="massage-stage__cell">
                    <div className="massage-stage__time">{r.from}</div>
                    <div className="massage-stage__who">{h ? h.user?.full_name : '—'}</div>
                  </div>
                )
              })}
            </div>
            {waitlist.length > 0 && (
              <div className="massage-stage__waitlist">
                <span className="massage-stage__label">{t('massage_waitlist_title')}</span>
                {waitlist.map((w, i) => <span key={w.id} className="massage-stage__name">{i + 1}. {w.user?.full_name}</span>)}
              </div>
            )}
            <p className="massage-stage__note">{t('massage_draw_locked', { time: fmtDateTime(session.drawn_at, lang) })}</p>
          </>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title={overCapacity ? t('massage_draw_start') : t('massage_draw_assign')}
          description={t('massage_confirm_draw_desc')}
          confirmLabel={overCapacity ? t('massage_draw_start') : t('massage_draw_assign')}
          loading={busy}
          onConfirm={draw}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

export default MassageDraw
