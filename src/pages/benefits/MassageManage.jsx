import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { Button, Card, Chip, ConfirmDialog, Dialog, EmptyState, Skeleton, TextField } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useLanguage } from '../../context/LanguageContext'
import {
  defaultDeadlines, fetchOwnerName, fmtDate, fromTaipeiInput, phaseTone, sessionPhase,
  sessionWindow, toTaipeiInput,
} from '../../lib/massage'

function blankForm() {
  return {
    title: '',
    session_date: '',
    start_time: '13:00',
    slot_minutes: 15,
    break_minutes: 5,
    slot_count: 9,
    signup_deadline: '',
    draw_scheduled_at: '',
    cancel_deadline: '',
  }
}

function formFromSession(s) {
  return {
    title: s.title,
    session_date: s.session_date,
    start_time: String(s.start_time).slice(0, 5),
    slot_minutes: s.slot_minutes,
    break_minutes: s.break_minutes,
    slot_count: s.slot_count,
    signup_deadline: toTaipeiInput(s.signup_deadline),
    draw_scheduled_at: toTaipeiInput(s.draw_scheduled_at),
    cancel_deadline: toTaipeiInput(s.cancel_deadline),
  }
}

/** 表單 → 資料庫欄位；有問題回傳錯誤字串的 key */
function toRow(form, t) {
  if (!form.session_date || !form.start_time || !form.signup_deadline || !form.cancel_deadline) {
    return { errorKey: 'massage_form_err_required' }
  }
  const [, m, d] = form.session_date.split('-')
  const row = {
    title: form.title.trim() || t('massage_default_title', { md: `${Number(m)}/${Number(d)}` }),
    session_date: form.session_date,
    start_time: form.start_time,
    slot_minutes: Number(form.slot_minutes),
    break_minutes: Number(form.break_minutes),
    slot_count: Number(form.slot_count),
    signup_deadline: fromTaipeiInput(form.signup_deadline),
    draw_scheduled_at: fromTaipeiInput(form.draw_scheduled_at),
    cancel_deadline: fromTaipeiInput(form.cancel_deadline),
  }
  if (![row.slot_minutes, row.break_minutes, row.slot_count].every(Number.isFinite)
      || row.slot_minutes < 5 || row.slot_count < 1 || row.break_minutes < 0) {
    return { errorKey: 'massage_form_err_numbers' }
  }
  const startAt = new Date(`${row.session_date}T${row.start_time}:00+08:00`)
  if (new Date(row.signup_deadline) >= startAt) return { errorKey: 'massage_form_err_signup_after_start' }
  if (new Date(row.cancel_deadline) < new Date(row.signup_deadline)) return { errorKey: 'massage_form_err_cancel_before_signup' }
  return { row }
}

function SessionForm({ form, setForm, isNew }) {
  const { t } = useLanguage()
  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }))

  // 新增時：選了日期就自動帶入試算表原本的三個時間（前一天 12:00 截止、16:00 抽籤、當天 12:00 取消期限）
  function onDate(e) {
    const date = e.target.value
    setForm(f => ({ ...f, session_date: date, ...(isNew && date ? defaultDeadlines(date) : {}) }))
  }

  return (
    <div className="massage-form">
      <TextField label={t('massage_form_title')} value={form.title} onChange={set('title')} placeholder={t('massage_default_title_hint')} />
      <div className="massage-form__row">
        <TextField label={t('massage_form_date')} type="date" required value={form.session_date} onChange={onDate} />
        <TextField label={t('massage_form_start')} type="time" required value={form.start_time} onChange={set('start_time')} />
      </div>
      <div className="massage-form__row">
        <TextField label={t('massage_form_slot_minutes')} type="number" min="5" value={form.slot_minutes} onChange={set('slot_minutes')} />
        <TextField label={t('massage_form_break_minutes')} type="number" min="0" value={form.break_minutes} onChange={set('break_minutes')} />
        <TextField label={t('massage_form_slot_count')} type="number" min="1" value={form.slot_count} onChange={set('slot_count')} />
      </div>
      <div className="massage-form__row">
        <TextField label={t('massage_signup_deadline')} type="datetime-local" required value={form.signup_deadline} onChange={set('signup_deadline')} />
        <TextField label={t('massage_draw_time')} type="datetime-local" value={form.draw_scheduled_at} onChange={set('draw_scheduled_at')}
          helper={t('massage_form_draw_helper')} />
        <TextField label={t('massage_cancel_deadline')} type="datetime-local" required value={form.cancel_deadline} onChange={set('cancel_deadline')}
          helper={t('massage_form_cancel_helper')} />
      </div>
    </div>
  )
}

function MassageManage() {
  const { t, lang } = useLanguage()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const [state, setState] = useState({ loading: true, sessions: [], counts: {}, ownerName: null })
  const [tick, setTick] = useState(0)
  const [form, setForm] = useState(blankForm)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(null)       // { id, form }
  const [deleting, setDeleting] = useState(null)     // session
  const reload = () => setTick(n => n + 1)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [{ data: sessions }, { data: signups }, ownerName] = await Promise.all([
        supabase.from('massage_sessions').select('*').order('session_date', { ascending: false }),
        supabase.from('massage_signups').select('session_id').is('released_at', null),
        fetchOwnerName(),
      ])
      const counts = {}
      for (const s of signups || []) counts[s.session_id] = (counts[s.session_id] || 0) + 1
      if (!cancelled) setState({ loading: false, sessions: sessions || [], counts, ownerName })
    })()
    return () => { cancelled = true }
  }, [tick])

  async function handleCreate() {
    const { row, errorKey } = toRow(form, t)
    if (errorKey) { showToast(t(errorKey), { tone: 'error' }); return }
    setSaving(true)
    const { data, error } = await supabase.from('massage_sessions').insert(row).select('id').single()
    setSaving(false)
    if (error || !data) { showToast(t('massage_err_save', { msg: error?.message || '' }), { tone: 'error' }); return }
    showToast(t('massage_toast_session_created'))
    setForm(blankForm())
    navigate(`/benefits/massage/manage/${data.id}`)
  }

  async function handleSaveEdit() {
    const { row, errorKey } = toRow(editing.form, t)
    if (errorKey) { showToast(t(errorKey), { tone: 'error' }); return }
    setSaving(true)
    // 被權限或「抽過籤就鎖定」擋下時，update 可能不會報錯只回 0 筆 —— 兩種都要檢查
    const { data, error } = await supabase.from('massage_sessions').update(row).eq('id', editing.id).select('id')
    setSaving(false)
    if (error || !data?.length) {
      showToast(t('massage_err_save', { msg: error?.message || t('massage_err_not_allowed') }), { tone: 'error' })
      return
    }
    showToast(t('massage_toast_session_updated'))
    setEditing(null)
    reload()
  }

  async function handleDelete() {
    setSaving(true)
    const { data, error } = await supabase.from('massage_sessions').delete().eq('id', deleting.id).select('id')
    setSaving(false)
    if (error || !data?.length) {
      showToast(t('massage_err_delete', { msg: error?.message || t('massage_err_not_allowed') }), { tone: 'error' })
    } else {
      showToast(t('massage_toast_session_deleted'))
    }
    setDeleting(null)
    reload()
  }

  return (
    <div className="massage-page">
      <div className="massage-toolbar">
        <Link to="/benefits/massage" className="massage-link">← {t('massage_back_home')}</Link>
      </div>

      <Card>
        <h3 className="massage-card-title">{t('massage_manage_title')}</h3>
        <p className="massage-hint">
          {state.ownerName
            ? t('massage_owner_is', { name: state.ownerName })
            : t('massage_owner_unset')}
          {' '}{t('massage_owner_where')}
        </p>
      </Card>

      <Card>
        <h3 className="massage-card-title">{t('massage_new_session')}</h3>
        <SessionForm form={form} setForm={setForm} isNew />
        <div className="massage-actions">
          <Button loading={saving} onClick={handleCreate}>{t('massage_create')}</Button>
        </div>
      </Card>

      <Card>
        <h3 className="massage-card-title">{t('massage_sessions')}</h3>
        {state.loading ? <Skeleton height="120px" /> : state.sessions.length === 0 ? (
          <EmptyState icon="💆" title={t('massage_sessions_empty')} />
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>{t('massage_col_date')}</th><th>{t('massage_col_title')}</th>
                  <th>{t('massage_col_status')}</th><th>{t('massage_col_count')}</th><th>{t('common_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {state.sessions.map(s => {
                  const phase = sessionPhase(s)
                  const win = sessionWindow(s)
                  return (
                    <tr key={s.id}>
                      <td>{fmtDate(s.session_date, lang)}<div className="massage-muted">{win.from}–{win.to}</div></td>
                      <td>{s.title}</td>
                      <td><Chip tone={phaseTone(phase)}>{t(`massage_phase_${phase}`)}</Chip></td>
                      <td>{t('massage_capacity_value', { n: state.counts[s.id] || 0, cap: s.slot_count })}</td>
                      <td>
                        <div className="massage-actions massage-actions--tight">
                          <Button size="sm" onClick={() => navigate(`/benefits/massage/manage/${s.id}`)}>{t('massage_open_panel')}</Button>
                          {!s.drawn_at && (
                            <>
                              <Button size="sm" variant="outlined" onClick={() => navigate(`/benefits/massage/draw/${s.id}`)}>{t('massage_open_draw')}</Button>
                              <Button size="sm" variant="outlined" onClick={() => setEditing({ id: s.id, form: formFromSession(s) })}>{t('common_edit')}</Button>
                              <Button size="sm" variant="danger-outlined" onClick={() => setDeleting(s)}>{t('common_delete')}</Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Dialog
          size="lg"
          title={t('massage_edit_session')}
          labelledBy="massage-edit-title"
          onClose={() => setEditing(null)}
          actions={(
            <>
              <Button variant="text" onClick={() => setEditing(null)}>{t('common_cancel')}</Button>
              <Button loading={saving} onClick={handleSaveEdit}>{t('common_save')}</Button>
            </>
          )}
        >
          <SessionForm form={editing.form} setForm={f => setEditing(e => ({ ...e, form: typeof f === 'function' ? f(e.form) : f }))} />
        </Dialog>
      )}

      {deleting && (
        <ConfirmDialog
          title={t('massage_confirm_delete_title')}
          description={t('massage_confirm_delete_desc', { title: deleting.title, n: state.counts[deleting.id] || 0 })}
          confirmLabel={t('common_delete')}
          danger
          loading={saving}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}

export default MassageManage
