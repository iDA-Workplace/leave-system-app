import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Dialog, Select, Textarea } from './ui'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'
import { calcHours, countWorkdays, leaveTypeName } from '../lib/leaveEntitlements'

// 同仁要在幾天內確認。改這個數字的話，Slack 通知裡那句「N 天內未確認視同
// 確認」會跟著變（文字用的是同一個變數），但排程那邊是讀 ack_deadline 欄位，
// 不需要跟著改。
export const ACK_DAYS = 3

const TIME_OPTIONS = []
for (let h = 8; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 18 && m > 30) break
    TIME_OPTIONS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  }
}

const EMPTY = {
  requester_id: '', leave_type_id: '', start_date: '', end_date: '',
  start_time: '09:00', end_time: '18:00', reason: '',
}

/**
 * HR 代同仁登記請假。
 *
 * 跟同仁自己送的假單有三個關鍵差別：
 *   1. 直接 approved，不走簽核流程 —— 這種假已經請完了（人真的沒來、HR 也
 *      知道），再送主管核准有點倒因為果，主管沒按還會卡住。
 *   2. 會記下 registered_by（誰登的）與 ack_deadline（確認期限）。
 *   3. 送出後私訊同仁請他確認，通知裡明寫「N 天內未確認視同確認」。
 *
 * 表單刻意跟一般請假長得很像，只多一個「幫誰登記」，這樣 HR 不用重新學。
 */
function HrRegisterLeaveDialog({ hrUser, onClose, onDone }) {
  const { t, lang } = useLanguage()
  const { showToast } = useToast()
  const [colleagues, setColleagues] = useState([])
  const [leaveTypes, setLeaveTypes] = useState([])
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)

  const isMultiDay = form.start_date && form.end_date && form.end_date > form.start_date
  const hours = isMultiDay ? null : calcHours(form.start_time, form.end_time)

  useEffect(() => {
    (async () => {
      const [{ data: people }, { data: types }] = await Promise.all([
        supabase.from('users').select('id, full_name').eq('is_active', true).order('full_name'),
        supabase.from('leave_types').select('*').eq('is_active', true),
      ])
      setColleagues(people || [])
      setLeaveTypes(types || [])
    })()
  }, [])

  async function handleSubmit() {
    if (!form.requester_id || !form.leave_type_id || !form.start_date || !form.end_date || !form.reason) {
      showToast(t('leaveform_err_required'), { tone: 'error' }); return
    }
    if (form.end_date < form.start_date) {
      showToast(t('leaveform_err_date_order'), { tone: 'error' }); return
    }
    if (!isMultiDay && form.end_time <= form.start_time) {
      showToast(t('leaveform_time_order_error'), { tone: 'error' }); return
    }
    if (!isMultiDay && hours === 0) {
      showToast(t('leaveform_err_zero_hours'), { tone: 'error' }); return
    }

    setSaving(true)

    const deadline = new Date()
    deadline.setDate(deadline.getDate() + ACK_DAYS)

    const { data, error } = await supabase
      .from('leave_requests')
      .insert({
        requester_id: form.requester_id,
        leave_type_id: form.leave_type_id,
        // flow_id 留空、current_step 也不設 —— 這張不走簽核。
        start_date: form.start_date,
        end_date: form.end_date,
        start_time: isMultiDay ? '09:00' : form.start_time,
        end_time: isMultiDay ? '18:00' : form.end_time,
        hours: isMultiDay ? null : hours,
        reason: form.reason,
        status: 'approved',
        registered_by: hrUser.id,
        ack_deadline: deadline.toISOString(),
      })
      .select()
      .single()

    if (error) {
      showToast(t('hrreg_err_submit', { msg: error.message }), { tone: 'error' })
      setSaving(false)
      return
    }

    // 通知失敗不該讓整個登記失敗 —— 假單已經建立了，那才是重點。
    // 通知沒發出去頂多是同仁不知道，HR 可以口頭補講；但假單沒建立，
    // 結算就會漏，那是這個功能要解決的問題本身。
    const { error: notifyError } = await supabase.functions.invoke('send-slack-notification', {
      body: { type: 'hr_registered', request_id: data.id },
    })

    setSaving(false)
    onDone?.()
    showToast(notifyError ? t('hrreg_done_no_notify') : t('hrreg_done'))
    onClose()
  }

  const who = colleagues.find(c => c.id === form.requester_id)

  return (
    <Dialog
      title={t('hrreg_title')}
      labelledBy="hr-register-dialog-title"
      onClose={onClose}
      actions={(
        <>
          <Button variant="text" onClick={onClose}>{t('common_cancel')}</Button>
          <Button loading={saving} onClick={handleSubmit}>{t('hrreg_submit')}</Button>
        </>
      )}
    >
      <p className="admin-form-card__hint">{t('hrreg_hint', { days: ACK_DAYS })}</p>

      <div className="admin-form-grid">
        <Select
          label={t('hrreg_for_whom')}
          required
          value={form.requester_id}
          onChange={e => setForm(p => ({ ...p, requester_id: e.target.value }))}
        >
          <option value="">{t('hrreg_select_person')}</option>
          {colleagues.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
        </Select>

        <Select
          label={t('field_leave_type')}
          required
          value={form.leave_type_id}
          onChange={e => setForm(p => ({ ...p, leave_type_id: e.target.value }))}
        >
          <option value="">{t('leaveform_select_type')}</option>
          {leaveTypes.map(lt => (
            <option key={lt.id} value={lt.id}>{leaveTypeName(lt, lang)}</option>
          ))}
        </Select>

        <label className="ui-field">
          <span className="ui-field__label">{t('hrreg_start_date')} *</span>
          <input
            className="ui-field__control" type="date"
            value={form.start_date}
            onChange={e => setForm(p => ({ ...p, start_date: e.target.value, end_date: p.end_date || e.target.value }))}
          />
        </label>

        <label className="ui-field">
          <span className="ui-field__label">{t('hrreg_end_date')} *</span>
          <input
            className="ui-field__control" type="date"
            value={form.end_date}
            onChange={e => setForm(p => ({ ...p, end_date: e.target.value }))}
          />
        </label>

        {!isMultiDay && (
          <>
            <Select
              label={t('leaveform_start')}
              value={form.start_time}
              onChange={e => setForm(p => ({ ...p, start_time: e.target.value }))}
            >
              {TIME_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
            </Select>
            <Select
              label={t('leaveform_end')}
              value={form.end_time}
              onChange={e => setForm(p => ({ ...p, end_time: e.target.value }))}
            >
              {TIME_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
            </Select>
          </>
        )}
      </div>

      {isMultiDay
        ? <p className="admin-form-card__hint">{t('hrreg_multiday_hint', { n: countWorkdays(form.start_date, form.end_date) })}</p>
        : <p className="admin-form-card__hint">{t('leaveform_hours_note', { n: hours })}</p>}

      <Textarea
        label={t('field_reason')}
        required
        rows={3}
        value={form.reason}
        onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
        placeholder={t('hrreg_reason_placeholder')}
      />

      {who && (
        <p className="admin-form-card__hint">
          {t('hrreg_will_notify', { name: who.full_name, days: ACK_DAYS })}
        </p>
      )}
    </Dialog>
  )
}

export default HrRegisterLeaveDialog
