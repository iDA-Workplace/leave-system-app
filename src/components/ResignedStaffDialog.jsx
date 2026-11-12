import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchAllRows } from '../lib/fetchAllRows'
import { countWorkdays, leaveTypeName } from '../lib/leaveEntitlements'
import { useLanguage } from '../context/LanguageContext'
import { useToast } from '../context/ToastContext'
import { Button, Card, Chip, Dialog, EmptyState, Select, Skeleton, TextField } from './ui'
import LeaveAnalytics from './LeaveAnalytics'
import AttachmentLink from './AttachmentLink'
import './ResignedStaffDialog.css'

/**
 * 離職同仁專區（員工帳號管理 → 只有 HR 看得到的按鈕）。使用者 2026-11 決定：
 *   · 可以依「離職年份」「月份」「人物」篩選（離職 = 最後工作日）
 *   · 內容：基本資料、請假紀錄、特休結算、考核紀錄、請假統計（整個在職期間）
 *   · 特休結算 = 離職當年度全額 − 當年已核准的特休（資料庫函式 annual_leave_settlement）
 *   · 還沒填最後工作日的（2026-11 之前就刪除的帳號）由 HR 在這裡補填
 *   · 不提供永久刪除
 */
const NONE = 'none'   // 年份篩選：還沒填最後工作日

function ResignedStaffDialog({ users, onClose, onChanged }) {
  const { t } = useLanguage()
  const resigned = useMemo(() => users.filter(u => !u.is_active)
    .sort((a, b) => (b.last_working_day || '').localeCompare(a.last_working_day || '') || (a.full_name || '').localeCompare(b.full_name || '')), [users])
  const [year, setYear] = useState('')
  const [month, setMonth] = useState('')
  const [personId, setPersonId] = useState('')

  const years = [...new Set(resigned.map(u => u.last_working_day?.slice(0, 4)).filter(Boolean))].sort().reverse()
  const hasMissing = resigned.some(u => !u.last_working_day)
  const byFilter = resigned.filter(u => {
    if (year === NONE) return !u.last_working_day
    if (year && u.last_working_day?.slice(0, 4) !== year) return false
    if (year && month && Number(u.last_working_day?.slice(5, 7)) !== Number(month)) return false
    return true
  })
  const shown = personId ? byFilter.filter(u => u.id === personId) : byFilter
  const selected = resigned.find(u => u.id === personId) ?? (shown.length === 1 ? shown[0] : null)
  const managerName = id => users.find(u => u.id === id)?.full_name || '—'

  return (
    <Dialog title={t('resigned_title')} labelledBy="resigned-title" size="lg" onClose={onClose}
      actions={<Button variant="text" onClick={onClose}>{t('common_close')}</Button>}>
      <p className="admin-form-card__hint">{t('resigned_hint')}</p>

      <div className="admin-inline-form resigned-filters">
        <Select value={year} onChange={e => { setYear(e.target.value); setMonth(''); setPersonId('') }} aria-label={t('resigned_filter_year')}>
          <option value="">{t('resigned_all_years')}</option>
          {years.map(y => <option key={y} value={y}>{t('resigned_year_n', { y })}</option>)}
          {hasMissing && <option value={NONE}>{t('resigned_missing_day')}</option>}
        </Select>
        <Select value={month} disabled={!year || year === NONE} onChange={e => { setMonth(e.target.value); setPersonId('') }} aria-label={t('resigned_filter_month')}>
          <option value="">{t('resigned_all_months')}</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map(m => <option key={m} value={m}>{t('resigned_month_n', { m })}</option>)}
        </Select>
        <Select value={personId} onChange={e => setPersonId(e.target.value)} aria-label={t('resigned_filter_person')}>
          <option value="">{t('resigned_all_people')}</option>
          {byFilter.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </Select>
      </div>

      {resigned.length === 0 ? <EmptyState title={t('resigned_empty')} /> : (
        <>
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>{t('adminusers_col_name')}</th><th>{t('adminusers_col_department')}</th>
                  <th className="resigned-hide-m">{t('adminusers_col_title')}</th>
                  <th className="resigned-hide-m">{t('resigned_hire_date')}</th><th>{t('resigned_last_day')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(u => (
                  <tr key={u.id} className={`resigned-row ${selected?.id === u.id ? 'is-selected' : ''}`} onClick={() => setPersonId(u.id)}>
                    <td>{u.full_name}</td>
                    <td>{u.department || '—'}</td>
                    <td className="resigned-hide-m">{u.job_title || '—'}</td>
                    <td className="resigned-hide-m tabular">{u.hire_date || '—'}</td>
                    <td className="tabular">{u.last_working_day || <Chip tone="warning">{t('resigned_missing_short')}</Chip>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!selected && shown.length > 0 && <p className="admin-hint">{t('resigned_pick_hint')}</p>}
          {selected && <PersonRecord key={selected.id} user={selected} managerName={managerName(selected.manager_id)} onChanged={onChanged} />}
        </>
      )}
    </Dialog>
  )
}

function PersonRecord({ user, managerName, onChanged }) {
  const { t, lang } = useLanguage()
  const { showToast } = useToast()
  const [lastDay, setLastDay] = useState(user.last_working_day || '')
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState(null)   // { leaves, reviews, settlement }

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetchAllRows(() => supabase.from('leave_requests')
        .select('id, start_date, end_date, hours, status, reason, registered_by, attachment_path, attachment_url, attachment_name, leave_type:leave_types(name, name_en, is_wfh)')
        .eq('requester_id', user.id).order('start_date', { ascending: false }).order('id')),
      supabase.from('annual_review_participants').select('*, review:annual_reviews(title, year)').eq('user_id', user.id),
      supabase.rpc('annual_leave_settlement', { p_user_id: user.id }),
    ]).then(([leaves, reviews, settlement]) => {
      if (cancelled) return
      setData({
        leaves: leaves.data || [], leavesError: leaves.error?.message,
        reviews: (reviews.data || []).sort((a, b) => (b.review?.year ?? 0) - (a.review?.year ?? 0)), reviewsError: reviews.error?.message,
        settlement: settlement.data?.[0] ?? null, settlementError: settlement.error?.message,
      })
    })
    return () => { cancelled = true }
  }, [user.id, user.last_working_day])

  async function saveLastDay() {
    if (!lastDay) { showToast(t('resigned_err_last_day'), { tone: 'error' }); return }
    setSaving(true)
    const { data: updated, error } = await supabase.from('users').update({ last_working_day: lastDay }).eq('id', user.id).select()
    setSaving(false)
    if (error || !updated?.length) {
      showToast(t('resigned_err_save', { msg: error?.message || t('admin_no_write_permission') }), { tone: 'error' }); return
    }
    showToast(t('resigned_saved'))
    onChanged?.()
  }

  const tenure = (() => {
    if (!user.hire_date || !user.last_working_day) return '—'
    const a = new Date(`${user.hire_date}T00:00:00Z`), b = new Date(`${user.last_working_day}T00:00:00Z`)
    let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())
    if (b.getUTCDate() < a.getUTCDate()) months -= 1
    return t('resigned_tenure', { y: Math.floor(months / 12), m: months % 12 })
  })()

  // 請假統計：整個在職期間（使用者決定）。沒有到職日就從第一張假單開始
  const firstLeave = data?.leaves.length ? data.leaves[data.leaves.length - 1].start_date : null
  const statsStart = user.hire_date || firstLeave
  const statsEnd = user.last_working_day || new Date().toISOString().slice(0, 10)

  const statusText = s => t(`status_${s}`)
  const reviewStatus = r => r.published_at ? t('resigned_review_published')
    : r.supervisor_submitted ? t('resigned_review_scored')
    : r.self_submitted ? t('resigned_review_self') : t('resigned_review_open')

  return (
    <div className="resigned-record">
      <Card>
        <h4 className="admin-form-card__title">{user.full_name}{user.english_name ? `（${user.english_name}）` : ''}</h4>
        <dl className="resigned-info">
          <div><dt>{t('adminusers_col_department')}</dt><dd>{user.department || '—'}</dd></div>
          <div><dt>{t('adminusers_col_title')}</dt><dd>{user.job_title || '—'}</dd></div>
          <div><dt>{t('adminusers_col_role')}</dt><dd>{user.role ? t(`role_${user.role}`) : '—'}</dd></div>
          <div><dt>{t('adminusers_col_manager')}</dt><dd>{managerName}</dd></div>
          <div><dt>{t('settings_email')}</dt><dd>{user.email || '—'}</dd></div>
          <div><dt>{t('resigned_hire_date')}</dt><dd className="tabular">{user.hire_date || '—'}</dd></div>
          <div><dt>{t('resigned_last_day')}</dt><dd className="tabular">{user.last_working_day || '—'}</dd></div>
          <div><dt>{t('resigned_tenure_label')}</dt><dd>{tenure}</dd></div>
        </dl>
        <div className="resigned-lastday">
          <TextField label={user.last_working_day ? t('resigned_edit_last_day') : t('resigned_fill_last_day')} type="date"
            value={lastDay} onChange={e => setLastDay(e.target.value)} />
          <Button size="sm" loading={saving} disabled={!lastDay || lastDay === user.last_working_day} onClick={saveLastDay}>{t('common_save')}</Button>
        </div>
      </Card>

      {!data ? <Skeleton height="200px" /> : (
        <>
          <Card>
            <h4 className="admin-form-card__title">{t('resigned_settlement')}</h4>
            {data.settlementError ? <p className="admin-hint">{t('resigned_err_load', { msg: data.settlementError })}</p>
              : !data.settlement ? <p className="admin-hint">{t('resigned_settlement_need_day')}</p> : (
                <>
                  <div className="resigned-settle">
                    <div><span>{t('resigned_settle_year')}</span><strong>{data.settlement.year}</strong></div>
                    <div><span>{t('resigned_settle_entitled')}</span><strong>{Number(data.settlement.entitled)}</strong> {t('stats_unit_days')}</div>
                    <div><span>{t('resigned_settle_used')}</span><strong>{Number(data.settlement.used)}</strong> {t('stats_unit_days')}</div>
                    <div className="is-key"><span>{t('resigned_settle_remaining')}</span><strong>{Number(data.settlement.remaining)}</strong> {t('stats_unit_days')}</div>
                  </div>
                  <p className="admin-form-card__hint">
                    {data.settlement.is_manual ? t('resigned_settle_manual') : t('resigned_settle_rule')}
                    {Number(data.settlement.remaining) < 0 && <> {t('resigned_settle_negative')}</>}
                  </p>
                </>
              )}
          </Card>

          <Card>
            <h4 className="admin-form-card__title">{t('resigned_leaves', { n: data.leaves.length })}</h4>
            {data.leavesError ? <p className="admin-hint">{t('resigned_err_load', { msg: data.leavesError })}</p>
              : data.leaves.length === 0 ? <p className="admin-hint">{t('resigned_no_leaves')}</p> : (
                <div className="ui-table-wrap resigned-scroll">
                  <table className="ui-table">
                    <thead><tr><th>{t('resigned_col_dates')}</th><th>{t('xls_col_leave_type')}</th><th>{t('resigned_col_amount')}</th><th>{t('xls_col_status')}</th></tr></thead>
                    <tbody>
                      {data.leaves.map(l => (
                        <tr key={l.id}>
                          <td className="tabular">{l.start_date}{l.end_date && l.end_date !== l.start_date ? ` ~ ${l.end_date}` : ''}</td>
                          <td>{leaveTypeName(l.leave_type, lang)}{l.registered_by && <> <Chip tone="info">{t('resigned_hr_registered')}</Chip></>}<AttachmentLink leave={l} /></td>
                          <td>{l.hours != null ? t('common_hours', { n: Number(l.hours) }) : t('common_days', { n: countWorkdays(l.start_date, l.end_date) })}</td>
                          <td>{statusText(l.status)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>

          <Card>
            <h4 className="admin-form-card__title">{t('resigned_reviews')}</h4>
            {data.reviewsError ? <p className="admin-hint">{t('resigned_err_load', { msg: data.reviewsError })}</p>
              : data.reviews.length === 0 ? <p className="admin-hint">{t('resigned_no_reviews')}</p> : (
                <div className="ui-table-wrap">
                  <table className="ui-table">
                    <thead><tr><th>{t('resigned_col_review')}</th><th>{t('resigned_col_score')}</th><th>{t('xls_col_status')}</th></tr></thead>
                    <tbody>
                      {data.reviews.map(r => (
                        <tr key={r.id}>
                          <td>{r.review?.title || r.review?.year || '—'}</td>
                          <td className="tabular">{r.final_score ?? '—'}</td>
                          <td>{reviewStatus(r)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>

          {statsStart && (
            <LeaveAnalytics startDate={statsStart} endDate={statsEnd < statsStart ? statsStart : statsEnd}
              scope={{ userId: user.id }} sections={['person']} />
          )}
        </>
      )}
    </div>
  )
}

export default ResignedStaffDialog
