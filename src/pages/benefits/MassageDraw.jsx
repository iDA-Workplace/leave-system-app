import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { Button, ConfirmDialog, Skeleton } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useLanguage } from '../../context/LanguageContext'
import {
  activeSignups, callMassage, fetchSessionBundle, fmtDate, fmtDateTime, holderOf,
  sessionWindow, slotRange, waitlistOf,
} from '../../lib/massage'
import { playDing, playFanfare, playRattle, playTicks } from '../../lib/lottoSound'
import LotteryDrum from './LotteryDrum'
import LotteryWheel from './LotteryWheel'

/**
 * 公開抽籤畫面。會投影給大家看，所以字要大、資訊要少。
 *
 * 規則（使用者確認）：
 *   · 只有管理員 / HR 能按（這個頁面本身也只有管理者進得來）
 *   · 抽一次就鎖定，不能重抽 —— 資料庫層也擋了，這裡只是事先講清楚
 *   · 報名人數沒超過名額時不抽籤，按下去就是照報名先後排定時段
 *
 * 樂透彩球機（2026-10 使用者要求）：
 *   · 按下「開始抽籤」的那一刻，資料庫就一次決定好所有名次（每人機率一樣）。
 *     之後的彩球動畫只是把「已經決定的結果」一位一位揭曉，動畫不會影響誰中籤。
 *   · 揭曉方式兩種都保留，由管理者選：主持人按一下開一位／自動一位接一位。
 *     任何時候都可以按「全部揭曉」。
 *   · 只有正取一位一位開；正取開完，候補名單一次列出。
 *   · 有音效，可以隨時關掉（記在這台電腦的瀏覽器裡）。
 *   · 動畫有兩種可以切換：樂透彩球機、輪盤（記在這台電腦的瀏覽器裡）。
 *     輪盤每揭曉一位就轉到那個人的格子停下，已揭曉的格子變灰、不拿掉。
 *   · 已經抽完的期數可以「重新播放揭曉」（例如畫面不小心重新整理了），
 *     播的是抽籤當下記下來的結果（異動紀錄裡的 draw_result）。
 */

const LOTTO_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16']
const MODE_KEY = 'massage-draw-mode'
const SOUND_KEY = 'massage-draw-sound'
const STYLE_KEY = 'massage-draw-style'
const MIX_MS = 1800       // 彩球機：每一顆開出來之前翻滾多久
const WHEEL_MS = 3600     // 輪盤：每一次轉多久
const SHOW_MS = 1000      // 開出來之後停留多久才能開下一顆
const AUTO_GAP_MS = 1200  // 自動播放時，兩顆之間再多等多久
const IDLE_SPEED = 0.5
const MIX_SPEED = 3.2

// 偏好設定存在瀏覽器裡；無痕模式等情況存不了就用預設值
function readPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value) } catch { /* 存不了沒關係，只是下次要重選 */ }
}

/** 抽籤當下的結果（異動紀錄），照名次排好：正取一位一位開，候補一次列出 */
async function loadDrawResult(sessionId, signups) {
  const { data } = await supabase.from('massage_events')
    .select('signup_id, slot_no, details').eq('session_id', sessionId).eq('event', 'draw_result')
  const nameOf = id => signups.find(s => s.id === id)?.user?.full_name || '—'
  const rows = (data || []).sort((a, b) => (a.details?.rank ?? 0) - (b.details?.rank ?? 0))
  return {
    order: rows.filter(r => r.details?.result === 'selected')
      .map(r => ({ id: r.signup_id, name: nameOf(r.signup_id), slot: r.slot_no, rank: r.details.rank })),
    waitlist: rows.filter(r => r.details?.result !== 'selected')
      .map(r => ({ id: r.signup_id, name: nameOf(r.signup_id) })),
  }
}

function MassageDraw() {
  const { sessionId } = useParams()
  const { t, lang } = useLanguage()
  const { showToast } = useToast()
  const stageRef = useRef(null)
  const [state, setState] = useState({ loading: true, session: null, signups: [], wasLottery: false })
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const [mode, setMode] = useState(() => readPref(MODE_KEY, 'manual'))       // manual | auto
  const [soundOn, setSoundOn] = useState(() => readPref(SOUND_KEY, 'on') === 'on')
  const [style, setStyle] = useState(() => readPref(STYLE_KEY, 'balls'))         // balls | wheel
  const [spin, setSpin] = useState(null)   // 輪盤：{ id, key } 這次要轉到誰
  // 揭曉中：{ order, waitlist, revealed, step: ready | mixing | showing | done }
  const [show, setShow] = useState(null)
  const speedRef = useRef(IDLE_SPEED)
  const showRef = useRef(null)
  const soundRef = useRef(soundOn)
  const timers = useRef([])

  useEffect(() => { showRef.current = show }, [show])
  useEffect(() => { soundRef.current = soundOn }, [soundOn])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const bundle = await fetchSessionBundle(sessionId)
      let wasLottery = false
      if (bundle.session?.drawn_at) {
        const { data } = await supabase.from('massage_events')
          .select('details').eq('session_id', sessionId).eq('event', 'drawn').maybeSingle()
        wasLottery = !!data?.details?.was_lottery
      }
      if (!cancelled) setState({ loading: false, ...bundle, wasLottery })
    })()
    return () => { cancelled = true }
  }, [sessionId, tick])

  function later(fn, ms) {
    timers.current.push(setTimeout(fn, ms))
  }

  async function startReveal(signups) {
    const result = await loadDrawResult(sessionId, signups)
    speedRef.current = IDLE_SPEED
    setSpin(null)
    setShow({ ...result, revealed: 0, step: 'ready' })
  }

  async function draw() {
    setBusy(true)
    const res = await callMassage('massage_run_draw', { p_session_id: sessionId })
    setBusy(false)
    setConfirming(false)
    if (!res.ok) showToast(t(res.errorKey), { tone: 'error' })
    else if (res.data?.was_lottery) await startReveal(state.signups)
    setTick(n => n + 1)
  }

  function revealNext() {
    const s = showRef.current
    if (!s || s.step !== 'ready' || s.revealed >= s.order.length) return
    const wheel = style === 'wheel'
    const duration = wheel ? WHEEL_MS : MIX_MS
    setShow({ ...s, step: 'mixing' })
    if (wheel) {
      setSpin({ id: s.order[s.revealed].id, key: Date.now() })
      if (soundRef.current) playTicks(duration)
    } else {
      speedRef.current = MIX_SPEED
      if (soundRef.current) playRattle(duration)
    }
    later(() => {
      speedRef.current = IDLE_SPEED
      const revealed = s.revealed + 1
      const done = revealed >= s.order.length
      setShow(cur => ({ ...cur, revealed, step: done ? 'done' : 'showing' }))
      if (soundRef.current) playDing()
      if (done) {
        if (soundRef.current) later(playFanfare, 450)
      } else {
        later(() => setShow(cur => ({ ...cur, step: 'ready' })), SHOW_MS)
      }
    }, duration)
  }

  function revealAll() {
    timers.current.forEach(clearTimeout)
    timers.current = []
    speedRef.current = IDLE_SPEED
    setShow(cur => ({ ...cur, revealed: cur.order.length, step: 'done' }))
    if (soundRef.current) playFanfare()
  }

  // 自動播放：每次回到 ready 就排下一顆
  const revealRef = useRef(revealNext)
  useEffect(() => { revealRef.current = revealNext })
  useEffect(() => {
    if (mode !== 'auto' || !show || show.step !== 'ready' || show.revealed >= show.order.length) return undefined
    const id = setTimeout(() => revealRef.current(), show.revealed === 0 ? 400 : AUTO_GAP_MS)
    return () => clearTimeout(id)
  }, [mode, show])

  function chooseMode(next) {
    setMode(next)
    writePref(MODE_KEY, next)
  }
  function chooseStyle(next) {
    setStyle(next)
    writePref(STYLE_KEY, next)
  }
  function toggleSound() {
    setSoundOn(on => {
      writePref(SOUND_KEY, on ? 'off' : 'on')
      return !on
    })
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.()
    else stageRef.current?.requestFullscreen?.()
  }

  const { loading, session, signups, wasLottery } = state
  if (loading) return <div className="massage-page"><Skeleton height="300px" /></div>
  if (!session) return <div className="massage-page"><p>{t('massage_session_not_found')}</p></div>

  const win = sessionWindow(session)
  const active = activeSignups(signups)
  const overCapacity = active.length > session.slot_count
  const beforeDeadline = new Date() < new Date(session.signup_deadline)
  const waitlist = waitlistOf(signups)

  // 罐子裡的球：抽籤前是目前報名的人；揭曉時是抽籤當下的所有人。都照報名先後排，
  // 顏色才不會在按下抽籤的瞬間全部換掉。
  const byId = Object.fromEntries(signups.map(s => [s.id, s]))
  const drumPeople = show
    ? [...show.order, ...show.waitlist].map(x => byId[x.id]).filter(Boolean)
    : active
  const balls = [...drumPeople]
    .sort((a, b) => new Date(a.signed_up_at) - new Date(b.signed_up_at))
    .map((s, i) => ({ id: s.id, name: s.user?.full_name || '—', color: LOTTO_COLORS[i % LOTTO_COLORS.length] }))
  const colorOf = id => balls.find(b => b.id === id)?.color
  // 手機上看的時候罐子跟著縮小（投影時是 380px）
  const drumSize = Math.min(380, window.innerWidth - 72)
  const outIds = new Set(show ? show.order.slice(0, show.revealed).map(x => x.id) : [])

  const mixing = show?.step === 'mixing'
  const visual = idle => (style === 'wheel'
    ? <LotteryWheel entries={balls} outIds={outIds} spinTarget={spin} spinMs={WHEEL_MS} idle={idle} size={drumSize} />
    : <LotteryDrum balls={balls} speedRef={speedRef} outIds={outIds} size={drumSize} />)

  const controls = (
    <div className="lotto-controls">
      <div className="lotto-mode" role="radiogroup" aria-label={t('massage_draw_style_label')}>
        <span className="lotto-mode__label">{t('massage_draw_style_label')}</span>
        {['balls', 'wheel'].map(v => (
          <button key={v} type="button" role="radio" aria-checked={style === v} disabled={mixing}
            className={`lotto-mode__opt${style === v ? ' is-on' : ''}`} onClick={() => chooseStyle(v)}>
            {t(`massage_draw_style_${v}`)}
          </button>
        ))}
      </div>
      <div className="lotto-mode" role="radiogroup" aria-label={t('massage_draw_mode_label')}>
        <span className="lotto-mode__label">{t('massage_draw_mode_label')}</span>
        {['manual', 'auto'].map(m => (
          <button key={m} type="button" role="radio" aria-checked={mode === m}
            className={`lotto-mode__opt${mode === m ? ' is-on' : ''}`} onClick={() => chooseMode(m)}>
            {t(`massage_draw_mode_${m}`)}
          </button>
        ))}
      </div>
      <button type="button" className="lotto-sound" onClick={toggleSound} aria-pressed={soundOn}>
        {soundOn ? `🔊 ${t('massage_draw_sound_on')}` : `🔇 ${t('massage_draw_sound_off')}`}
      </button>
    </div>
  )

  let body
  if (show) {
    const current = show.revealed > 0 ? show.order[show.revealed - 1] : null
    const slotName = Object.fromEntries(show.order.slice(0, show.revealed).filter(x => x.slot).map(x => [x.slot, x]))
    const pending = new Set(show.order.map(x => x.slot))
    body = (
      <>
        <div className="lotto-layout">
          <div className="lotto-left">
            {visual(false)}
            <div className="lotto-result" aria-live="polite">
              {show.step === 'mixing' ? (
                <span className="lotto-result__hint">{t('massage_draw_mixing', { k: show.revealed + 1 })}</span>
              ) : current ? (
                <div key={current.id} className="lotto-result__ball" style={{ background: colorOf(current.id) }}>
                  <span className="lotto-result__rank">{t('massage_draw_rank', { k: show.revealed })}</span>
                  <span className="lotto-result__name">{current.name}</span>
                  {current.slot && <span className="lotto-result__slot">{slotRange(session, current.slot).from}</span>}
                </div>
              ) : (
                <span className="lotto-result__hint">{t('massage_draw_ready', { n: show.order.length })}</span>
              )}
            </div>
          </div>

          <div className="lotto-right">
            <div className="massage-stage__grid lotto-grid">
              {Array.from({ length: session.slot_count }, (_, i) => i + 1).map(n => {
                const who = slotName[n]
                return (
                  <div key={n} className={`massage-stage__cell${who ? ' lotto-cell--filled' : ''}${who && who.id === current?.id ? ' lotto-cell--new' : ''}`}>
                    <div className="massage-stage__time">{slotRange(session, n).from}</div>
                    <div className="massage-stage__who">{who ? who.name : pending.has(n) ? '?' : '—'}</div>
                  </div>
                )
              })}
            </div>
            {show.step === 'done' && show.waitlist.length > 0 && (
              <div className="massage-stage__waitlist">
                <span className="massage-stage__label">{t('massage_waitlist_title')}</span>
                {show.waitlist.map((w, i) => <span key={w.id} className="massage-stage__name">{i + 1}. {w.name}</span>)}
              </div>
            )}
          </div>
        </div>

        <div className="lotto-bar">
          {controls}
          <div className="lotto-bar__actions">
            <span className="lotto-progress">{t('massage_draw_progress', { k: show.revealed, n: show.order.length })}</span>
            {show.step !== 'done' && mode === 'manual' && (
              <Button onClick={revealNext} disabled={show.step !== 'ready'}>{t('massage_draw_next')}</Button>
            )}
            {show.step !== 'done' && (
              <Button variant="outlined" onClick={revealAll}>{t('massage_draw_reveal_all')}</Button>
            )}
            {show.step === 'done' && (
              <Button variant="outlined" onClick={() => setShow(null)}>{t('massage_draw_close_reveal')}</Button>
            )}
          </div>
        </div>
        {session.drawn_at && <p className="massage-stage__note">{t('massage_draw_locked', { time: fmtDateTime(session.drawn_at, lang) })}</p>}
      </>
    )
  } else if (!session.drawn_at) {
    body = (
      <>
        {overCapacity && !beforeDeadline ? (
          <div className="lotto-layout lotto-layout--center">
            {visual(true)}
          </div>
        ) : (
          <div className="massage-stage__names">
            {[...active]
              .sort((a, b) => new Date(a.signed_up_at) - new Date(b.signed_up_at))
              .map(s => <span key={s.id} className="massage-stage__name">{s.user?.full_name}</span>)}
          </div>
        )}
        <div className="massage-stage__cta">
          {beforeDeadline ? (
            <p className="massage-stage__note">{t('massage_draw_wait_deadline', { time: fmtDateTime(session.signup_deadline, lang) })}</p>
          ) : (
            <>
              <p className="massage-stage__note">
                {overCapacity ? t('massage_draw_note_lottery', { n: session.slot_count }) : t('massage_draw_note_no_lottery', { n: session.slot_count })}
              </p>
              {overCapacity && controls}
              <Button onClick={() => setConfirming(true)} disabled={active.length === 0}>
                {overCapacity ? t('massage_draw_start') : t('massage_draw_assign')}
              </Button>
              {overCapacity && <p className="massage-stage__note">{t('massage_draw_fair_note')}</p>}
            </>
          )}
        </div>
      </>
    )
  } else {
    body = (
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
        {wasLottery && (
          <div className="massage-stage__cta">
            <Button variant="outlined" onClick={() => startReveal(signups)}>{t('massage_draw_replay')}</Button>
            <p className="massage-stage__note">{t('massage_draw_replay_note')}</p>
          </div>
        )}
      </>
    )
  }

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
        {body}
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
