import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { Button, Card, Chip, ConfirmDialog, EmptyState, Select, Skeleton } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useLanguage } from '../../context/LanguageContext'
import {
  activeSignups, callMassage, fetchSessionBundle, fmtDate, fmtDateTime, holderOf,
  pendingOfferFor, phaseTone, sessionPhase, sessionWindow, slotEndAt, slotRange, slotStartAt,
  waitlistOf,
} from '../../lib/massage'

/**
 * 某一期的現場面板（管理者用）。
 *
 * 現場的事情都在這裡：按「沒到」、直接指定候補遞補、對調時段、標記出席。
 * 候補功能照使用者要求保留彈性 —— 下拉選單照候補順序排，但可以選任何一位。
 */
function MassageSessionPanel() {
  const { sessionId } = useParams()
  const { t, lang } = useLanguage()
  const { showToast } = useToast()
  const [state, setState] = useState({ loading: true, session: null, signups: [], okSlots: {} })
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const reload = () => setTick(n => n + 1)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [{ session, signups }, { data: ok }] = await Promise.all([
        fetchSessionBundle(sessionId),
        supabase.rpc('massage_session_ok_slots', { p_session_id: sessionId }),
      ])
      const okSlots = Object.fromEntries((ok || []).map(r => [r.signup_id, r.ok_slots || []]))
      if (!cancelled) setState({ loading: false, session, signups, okSlots })
    })()
    return () => { cancelled = true }
  }, [sessionId, tick])

  async function run(fn, args, successKey, params) {
    setBusy(true)
    const res = await callMassage(fn, args)
    setBusy(false)
    setConfirm(null)
    if (!res.ok) showToast(t(res.errorKey), { tone: 'error' })
    else if (successKey) showToast(t(successKey, typeof params === 'function' ? params(res.data) : params))
    reload()
    return res
  }

  const { loading, session, signups, okSlots } = state
  if (loading) return <div className="massage-page"><Skeleton height="200px" /></div>
  if (!session) {
    return (
      <div className="massage-page">
        <Card><EmptyState title={t('massage_session_not_found')} /></Card>
      </div>
    )
  }

  const now = new Date()
  const phase = sessionPhase(session, now)
  const win = sessionWindow(session)
  const active = activeSignups(signups)
  const waitlist = waitlistOf(signups)
  const nameOf = id => signups.find(s => s.id === id)?.user?.full_name || ''
  const okFor = (signup, n) => {
    const ok = okSlots[signup.id]
    return !ok || ok.includes(n)
  }
  const slots = Array.from({ length: session.slot_count }, (_, i) => i + 1)
  const unmarked = active.filter(s => s.slot_no && !s.attendance && now >= slotEndAt(session, s.slot_no)).length

  return (
    <div className="massage-page">
      <div className="massage-toolbar">
        <Link to="/benefits/massage/manage" className="massage-link">← {t('massage_back_manage')}</Link>
        <div className="massage-actions massage-actions--tight">
          {!session.drawn_at && (
            <Link to={`/benefits/massage/draw/${session.id}`} className="massage-link">{t('massage_open_draw')} →</Link>
          )}
          <Button size="sm" variant="outlined" onClick={reload}>{t('massage_refresh')}</Button>
        </div>
      </div>

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
          <div><dt>{t('massage_cancel_deadline')}</dt><dd>{fmtDateTime(session.cancel_deadline, lang)}</dd></div>
          <div><dt>{t('massage_capacity')}</dt><dd>{t('massage_capacity_value', { n: active.length, cap: session.slot_count })}</dd></div>
          {session.drawn_at && <div><dt>{t('massage_drawn_at')}</dt><dd>{fmtDateTime(session.drawn_at, lang)}</dd></div>}
        </dl>
        {unmarked > 0 && <p className="massage-warn">{t('massage_unmarked_count', { n: unmarked })}</p>}
      </Card>

      {!session.drawn_at ? (
        <Card>
          <h3 className="massage-card-title">{t('massage_signup_list', { n: active.length })}</h3>
          {active.length === 0 ? <p className="massage-hint">{t('massage_signup_list_empty')}</p> : (
            <div className="ui-table-wrap">
              <table className="ui-table">
                <thead><tr><th>#</th><th>{t('massage_col_name')}</th><th>{t('massage_col_signed_at')}</th><th>{t('massage_col_leave')}</th></tr></thead>
                <tbody>
                  {[...active].sort((a, b) => new Date(a.signed_up_at) - new Date(b.signed_up_at)).map((s, i) => {
                    const ok = okSlots[s.id]
                    const partial = ok && ok.length < session.slot_count
                    return (
                      <tr key={s.id}>
                        <td>{i + 1}</td>
                        <td>{s.user?.full_name}</td>
                        <td>{fmtDateTime(s.signed_up_at, lang)}</td>
                        <td>{partial ? <Chip tone="warning">{t('massage_partial_ok_slots', { slots: ok.join('、') || '—' })}</Chip> : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <>
          <Card>
            <h3 className="massage-card-title">{t('massage_slot_table')}</h3>
            <div className="massage-slots">
              {slots.map(n => {
                const r = slotRange(session, n)
                const h = holderOf(signups, n)
                const offer = !h && pendingOfferFor(signups, n)
                const started = now >= slotStartAt(session, n)
                const over = now >= slotEndAt(session, n)
                return (
                  <div key={n} className={`massage-slot${h ? '' : ' massage-slot--empty'}`}>
                    <div className="massage-slot__time">
                      <strong>{n}</strong>
                      <span>{r.from}–{r.to}</span>
                    </div>

                    <div className="massage-slot__who">
                      {h ? (
                        <>
                          <span className="massage-slot__name">{h.user?.full_name}</span>
                          {h.attendance && (
                            <Chip tone={h.attendance === 'attended' ? 'success' : 'error'}>{t(`massage_attendance_${h.attendance}`)}</Chip>
                          )}
                          {(h.slot_conflict || !okFor(h, n)) && <Chip tone="warning">{t('massage_chip_leave_conflict')}</Chip>}
                          {h.yield_asked && !h.yield_answer && <Chip tone="info">{t('massage_chip_yield_pending')}</Chip>}
                        </>
                      ) : (
                        <>
                          <span className="massage-muted">{t('massage_slot_empty')}</span>
                          {offer && <Chip tone="warning">{t('massage_offering', { name: offer.user?.full_name })}</Chip>}
                        </>
                      )}
                    </div>

                    <div className="massage-slot__actions">
                      {h && started && !over && !h.attendance && (
                        <Button size="sm" variant="danger-outlined" onClick={() => setConfirm({
                          title: t('massage_confirm_no_show_title'),
                          desc: t('massage_confirm_no_show_desc', { name: h.user?.full_name }),
                          label: t('massage_no_show'), danger: true,
                          onConfirm: () => run('massage_mark_no_show', { p_signup_id: h.id }, 'massage_toast_no_show',
                            data => ({ name: data.offered_signup_id ? nameOf(data.offered_signup_id) : t('massage_nobody') })),
                        })}>{t('massage_no_show')}</Button>
                      )}

                      {h && started && (
                        <Select
                          aria-label={t('massage_attendance')}
                          value={h.attendance || ''}
                          disabled={busy}
                          onChange={e => run('massage_set_attendance', { p_signup_id: h.id, p_status: e.target.value || null }, 'massage_toast_attendance')}
                        >
                          <option value="">{t('massage_attendance_unmarked')}</option>
                          <option value="attended">{t('massage_attendance_attended')}</option>
                          <option value="no_show">{t('massage_attendance_no_show')}</option>
                        </Select>
                      )}

                      {h && !over && (
                        <Select
                          aria-label={t('massage_move_slot')}
                          value=""
                          disabled={busy}
                          onChange={e => {
                            const target = Number(e.target.value)
                            if (!target) return
                            const other = holderOf(signups, target)
                            setConfirm({
                              title: t('massage_move_slot'),
                              desc: other
                                ? t('massage_confirm_swap', { a: h.user?.full_name, b: other.user?.full_name, x: n, y: target })
                                : t('massage_confirm_move', { a: h.user?.full_name, x: n, y: target }),
                              label: t('common_confirm'),
                              onConfirm: () => run('massage_move_slot', { p_signup_id: h.id, p_target_slot: target }, 'massage_toast_moved'),
                            })
                          }}
                        >
                          <option value="">{t('massage_move_slot')}…</option>
                          {slots.filter(x => x !== n && now < slotEndAt(session, x)).map(x => {
                            const other = holderOf(signups, x)
                            const rr = slotRange(session, x)
                            return (
                              <option key={x} value={x}>
                                {other
                                  ? t('massage_move_option_swap', { n: x, from: rr.from, name: other.user?.full_name })
                                  : t('massage_move_option_empty', { n: x, from: rr.from })}
                              </option>
                            )
                          })}
                        </Select>
                      )}

                      {!h && !over && waitlist.length > 0 && (
                        <Select
                          aria-label={t('massage_assign')}
                          value=""
                          disabled={busy}
                          onChange={e => {
                            const w = waitlist.find(x => x.id === e.target.value)
                            if (!w) return
                            const conflict = !okFor(w, n)
                            setConfirm({
                              title: t('massage_assign'),
                              desc: t(conflict ? 'massage_confirm_assign_conflict' : 'massage_confirm_assign',
                                { name: w.user?.full_name, n, from: r.from }),
                              label: t('common_confirm'),
                              onConfirm: () => run('massage_assign_waitlist', { p_signup_id: w.id, p_slot_no: n }, 'massage_toast_assigned',
                                { name: w.user?.full_name, n }),
                            })
                          }}
                        >
                          <option value="">{t('massage_assign')}…</option>
                          {waitlist.map((w, i) => (
                            <option key={w.id} value={w.id}>
                              {t('massage_assign_option', { k: i + 1, name: w.user?.full_name })}
                              {okFor(w, n) ? '' : t('massage_assign_option_leave')}
                              {w.offer_status === 'pending' ? t('massage_assign_option_offered', { n: w.offer_slot_no }) : ''}
                            </option>
                          ))}
                        </Select>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="massage-hint">{t('massage_panel_hint')}</p>
          </Card>

          <Card>
            <h3 className="massage-card-title">{t('massage_waitlist_title')}</h3>
            {waitlist.length === 0 ? <p className="massage-hint">{t('massage_waitlist_empty')}</p> : (
              <ol className="massage-waitlist">
                {waitlist.map(w => (
                  <li key={w.id}>
                    {w.user?.full_name}
                    {w.offer_status === 'pending' && (
                      <Chip tone="warning">{t('massage_chip_offered', { n: w.offer_slot_no })}</Chip>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          description={confirm.desc}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          loading={busy}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

export default MassageSessionPanel
