import { useState, useEffect } from 'react'
import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  Button, Card, Chip, ConfirmDialog, Dialog, EmptyState, PageHeader, Select, Skeleton, Tabs, Textarea,
} from '../components/ui'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'
import './Review.css'

const EVALUATOR_ROLES = ['supervisor', 'deputy_supervisor', 'boss']
const PAGE_SIZE = 5

// 分數區間對照表 (from iDA's own past annual-evaluation spreadsheet).
const RATING_BANDS = [
  { min: 90, max: 100, key: 'excellent', tone: 'success' },
  { min: 80, max: 89, key: 'great', tone: 'success' },
  { min: 70, max: 79, key: 'expected', tone: 'info' },
  { min: 61, max: 69, key: 'improve', tone: 'warning' },
  { min: 0, max: 60, key: 'poor', tone: 'error' },
]
// 回傳 { tone, key }；顯示文字要用 t(`rating_${band.key}`) 取，等級名稱是
// 介面文字不是資料，寫死在這裡就沒辦法跟著語言切換。
function ratingFor(score) {
  if (score === null || score === undefined) return null
  return RATING_BANDS.find(b => score >= b.min && score <= b.max) || null
}

function formatTenure(hireDate, t) {
  if (!hireDate) return null
  const start = new Date(hireDate)
  const now = new Date()
  let years = now.getFullYear() - start.getFullYear()
  let months = now.getMonth() - start.getMonth()
  if (now.getDate() < start.getDate()) months -= 1
  if (months < 0) { years -= 1; months += 12 }
  if (years < 0) return t('finleave_tenure', { y: 0, m: 0 })
  return t('finleave_tenure', { y: years, m: months })
}

// Questions are scoped by department, not by role. A department without its
// own template falls back to the cycle's default template_id (全公司預設).
async function resolveTemplateId(review, department) {
  if (department) {
    const { data } = await supabase.from('review_templates').select('id').eq('department', department).limit(1)
    if (data && data.length > 0) return data[0].id
  }
  return review?.template_id ?? null
}

// Evaluation flows (簽核鏈) are also scoped by department, set up by that
// department's supervisor/boss in 部門考核設定.
async function resolveFlowId(department) {
  if (department) {
    const { data } = await supabase.from('review_flows').select('id').eq('department', department).limit(1)
    if (data && data.length > 0) return data[0].id
  }
  const { data } = await supabase.from('review_flows').select('id').is('department', null).limit(1)
  return data && data.length > 0 ? data[0].id : null
}

async function fetchQuestionsAndResponses(templateId, participantId) {
  const { data: qs } = await supabase
    .from('review_template_questions')
    .select('*')
    .eq('template_id', templateId)
    .order('order_index')

  const { data: rs } = await supabase
    .from('review_responses')
    .select('*')
    .eq('participant_id', participantId)

  // question_type lives on the QUESTION, never on the answer row -- we don't
  // write it there and no migration adds it, so `r.question_type` was always
  // undefined and every score answer silently fell through to text_answer
  // (which is null for score questions) and rendered as "—". Since each write
  // fills exactly one of the two columns, reading them in order is both
  // correct and independent of the question template.
  const responseMap = {}
  for (const r of rs || []) {
    responseMap[r.question_id] = {
      answer: r.score_answer ?? r.text_answer,
      example_note: r.example_note || '',
    }
  }
  return { questions: qs || [], responses: responseMap }
}

// Once a participant's evaluation chain is fully done, compute the 0-100
// final score: for each step, % = 100 x (sum of that step's score-question
// answers) / (score question count x 10), then average across all steps
// that actually scored this participant.
async function computeFinalScore(participantId, scoreQuestionIds) {
  if (scoreQuestionIds.length === 0) return null
  const { data: evals } = await supabase
    .from('review_evaluations')
    .select('step_order, question_id, score_answer')
    .eq('participant_id', participantId)
    .eq('is_overall', false)

  const byStep = {}
  for (const e of evals || []) {
    if (!scoreQuestionIds.includes(e.question_id)) continue
    const key = e.step_order ?? 0
    if (!byStep[key]) byStep[key] = []
    byStep[key].push(e.score_answer || 0)
  }
  const stepPercents = Object.values(byStep)
    .filter(arr => arr.length > 0)
    .map(arr => 100 * arr.reduce((s, v) => s + v, 0) / (scoreQuestionIds.length * 10))
  if (stepPercents.length === 0) return null
  return Math.round(stepPercents.reduce((s, v) => s + v, 0) / stepPercents.length)
}

// 讀出一位參與者的完整考核結果：題目、他的自評、各關評分與總評。
// 員工自己的「查看詳情」與主管／老闆的「團隊年度考核」用的是同一份資料，
// 所以抽出來共用，免得同一段解析邏輯散在三個地方各自長歪
// （question_type 那個 bug 就是這樣一次錯在三處的）。
async function fetchReviewResult(participant, department) {
  const templateId = await resolveTemplateId(participant.review, department)
  const { questions, responses } = await fetchQuestionsAndResponses(templateId, participant.id)

  const { data: evals } = await supabase
    .from('review_evaluations')
    .select('*, evaluator:users!review_evaluations_evaluator_id_fkey(full_name)')
    .eq('participant_id', participant.id)
    .order('step_order')

  const stepsMap = {}
  for (const e of evals || []) {
    const key = e.step_order ?? 0
    if (!stepsMap[key]) stepsMap[key] = { step_order: key, evaluator_name: e.evaluator?.full_name, answers: {}, overall_score: null, overall_comment: null }
    if (e.is_overall) {
      stepsMap[key].overall_score = e.overall_score
      stepsMap[key].overall_comment = e.overall_comment
    } else if (e.question_id) {
      // score_answer 優先：question_type 不是這張表的欄位
      stepsMap[key].answers[e.question_id] = { answer: e.score_answer ?? e.text_answer, example_note: e.example_note || '' }
    }
  }
  return { questions, responses, steps: Object.values(stepsMap).sort((a, b) => a.step_order - b.step_order) }
}

// 考核結果 modal 的內容（員工看自己的、主管／老闆看部屬的，版面一致）
function ReviewResultBody({ questions, responses, steps, finalScore, selfLabel }) {
  const { t } = useLanguage()
  const label = selfLabel ?? t('review_self_mine')
  const stepName = step => step.evaluator_name || t('adminflows_step', { n: step.step_order })
  return (
    <>
      {questions.map((q, i) => (
        <div key={q.id} className="review-result-question">
          <div className="review-result-question__title">{i + 1}. {q.question_text}</div>
          <div className="review-result-box">
            <div className="review-result-box__label">{label}</div>
            <div>{responses[q.id]?.answer ?? '—'}</div>
            {responses[q.id]?.example_note && <div className="review-result-box__note">{t('review_example_note', { text: responses[q.id].example_note })}</div>}
          </div>
          {steps.map(step => step.answers[q.id] && (
            <div key={step.step_order} className="review-result-box review-result-box--eval">
              <div className="review-result-box__label review-result-box__label--eval">{t('review_evaluator_score', { name: stepName(step) })}</div>
              <div>{step.answers[q.id].answer ?? '—'}</div>
              {step.answers[q.id].example_note && <div className="review-result-box__note">{t('review_example_note', { text: step.answers[q.id].example_note })}</div>}
            </div>
          ))}
        </div>
      ))}
      {steps.map(step => (
        <div key={step.step_order} className="review-overall">
          <div className="review-overall__title">{t('review_evaluator_overall', { name: stepName(step) })}</div>
          <div className="review-overall__score">{t('review_overall_score_prefix')}<strong>{step.overall_score ?? '—'}</strong></div>
          {step.overall_comment && <div className="review-overall__comment">{step.overall_comment}</div>}
        </div>
      ))}
      {finalScore != null && (
        <div className="review-overall">
          <div className="review-overall__title">{t('review_final_rating')}</div>
          <div className="review-overall__score">
            {t('review_points', { n: finalScore })}
            {(() => { const r = ratingFor(finalScore); return r ? `${t('common_meta_separator')}${t(`rating_${r.key}`)}` : '' })()}
          </div>
        </div>
      )}
    </>
  )
}

function ScoreButtons({ min, max, value, onChange }) {
  return (
    <div className="review-score-row">
      {Array.from({ length: max - min + 1 }, (_, i) => i + min).map(score => (
        <button
          key={score}
          type="button"
          className={`review-score-btn${value === score ? ' review-score-btn--active' : ''}`}
          onClick={() => onChange(score)}
        >
          {score}
        </button>
      ))}
    </div>
  )
}

function FlowSteps({ flow }) {
  const { t } = useLanguage()
  if (!flow?.steps?.length) return null
  const sorted = [...flow.steps].sort((a, b) => a.step_order - b.step_order)
  return (
    <div className="review-flow-steps">
      {sorted.map((s, i) => (
        <span key={i}>
          {i > 0 && <span className="review-flow-arrow">→</span>}
          <Chip tone="neutral">{t('adminflows_step_with_name', { n: s.step_order, name: s.evaluator?.full_name || t('adminusers_unassigned') })}</Chip>
        </span>
      ))}
    </div>
  )
}

// ===== 員工資訊 =====
function EmployeeInfoHeader({ userProfile, year }) {
  const { t } = useLanguage()
  const tenure = formatTenure(userProfile.hire_date, t)
  const name = userProfile.full_name
    ? `${userProfile.full_name}${userProfile.english_name ? ` (${userProfile.english_name})` : ''}`
    : userProfile.english_name
  const items = [
    [t('adminusers_col_name'), name],
    [t('adminusers_col_department'), userProfile.department],
    [t('adminusers_col_title'), userProfile.job_title],
    [t('review_info_hire_date'), userProfile.hire_date],
    [t('finleave_col_tenure'), tenure],
    [t('review_info_year'), year ? t('review_year_label', { y: year }) : null],
  ]
  return (
    <Card className="review-employee-card">
      {items.map(([label, value]) => (
        <div key={label}>
          <div className="review-employee-card__label">{label}</div>
          <div className="review-employee-card__value">{value || '—'}</div>
        </div>
      ))}
    </Card>
  )
}

// ===== 員工的年度自評／過往考核紀錄（可自由切換） =====
function EmployeeReviewSection({ userProfile }) {
  // 首頁的「查看評分結果 →」帶 ?tab=past 過來，要直接落在過往考核紀錄這一頁。
  const location = useLocation()
  const [tab, setTab] = useState(
    new URLSearchParams(location.search).get('tab') === 'past' ? 'past' : 'self'
  )
  const [activeParticipants, setActiveParticipants] = useState([])
  const [pastParticipants, setPastParticipants] = useState([])
  const [headerYear, setHeaderYear] = useState(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const { showToast } = useToast()
  const { t } = useLanguage()

  const [assessModal, setAssessModal] = useState(null)
  const [assessQuestions, setAssessQuestions] = useState([])
  const [assessResponses, setAssessResponses] = useState({})
  const [assessSaving, setAssessSaving] = useState(false)

  const [detailModal, setDetailModal] = useState(null)
  const [detailQuestions, setDetailQuestions] = useState([])
  const [detailResponses, setDetailResponses] = useState({})
  const [detailSteps, setDetailSteps] = useState([])

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [activeRes, pastRes, reviewsRes] = await Promise.all([
      supabase.from('annual_review_participants')
        .select('*, review:annual_reviews(*)')
        .eq('user_id', userProfile.id).eq('supervisor_submitted', false)
        .order('id', { ascending: false }),
      supabase.from('annual_review_participants')
        .select('*, review:annual_reviews(*), flow:review_flows(name, steps:review_flow_steps(step_order, evaluator:users(full_name)))')
        .eq('user_id', userProfile.id).eq('supervisor_submitted', true)
        .order('supervisor_submitted_at', { ascending: false }),
      supabase.from('annual_reviews').select('year, status').order('year', { ascending: false }),
    ])

    const activeRows = (activeRes.data || []).filter(p => p.review?.status === 'active')
    if (activeRows.length > 0) {
      const { data: draftRows } = await supabase.from('review_responses').select('participant_id').in('participant_id', activeRows.map(p => p.id))
      const draftSet = new Set((draftRows || []).map(r => r.participant_id))
      for (const p of activeRows) p._hasDraft = draftSet.has(p.id)
    }

    const reviews = reviewsRes.data || []
    const activeReview = reviews.find(r => r.status === 'active')
    setHeaderYear(activeReview?.year ?? reviews[0]?.year ?? null)
    setActiveParticipants(activeRows)
    setPastParticipants(pastRes.data || [])
    setPage(1)
    setLoading(false)
  }

  async function openAssessModal(participant) {
    const templateId = await resolveTemplateId(participant.review, userProfile.department)
    const { questions, responses } = await fetchQuestionsAndResponses(templateId, participant.id)
    setAssessQuestions(questions)
    setAssessResponses(responses)
    setAssessModal(participant)
  }

  async function handleSaveAssess(submit) {
    if (submit) {
      for (const q of assessQuestions) {
        const v = assessResponses[q.id]
        if (v === undefined || v.answer === undefined || v.answer === '') {
          showToast(t('review_err_required_q', { q: q.question_text }), { tone: 'error' })
          return
        }
      }
    }
    setAssessSaving(true)

    // 同上：每一步都檢查。原本整段沒有檢查，被權限規則擋下時畫面照樣顯示
    // 「自評已送出」，員工以為交了、主管卻永遠等不到。
    for (const q of assessQuestions) {
      const v = assessResponses[q.id]
      if (v === undefined || v.answer === undefined || v.answer === '') continue
      const { error } = await supabase.from('review_responses').upsert({
        review_id: assessModal.review_id,
        participant_id: assessModal.id,
        question_id: q.id,
        text_answer: q.question_type === 'text' ? String(v.answer) : null,
        score_answer: q.question_type === 'score' ? Number(v.answer) : null,
        example_note: q.question_type === 'score' ? (v.example_note || null) : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'participant_id,question_id' })
      if (error) {
        showToast(t('review_err_save_self', { msg: error.message }), { tone: 'error' })
        setAssessSaving(false)
        return
      }
    }

    if (submit) {
      // 被 RLS 擋下的 UPDATE 不會報錯，只會回 0 筆，所以要一起看資料列數
      const { data: updated, error } = await supabase.from('annual_review_participants')
        .update({ self_submitted: true, self_submitted_at: new Date().toISOString() })
        .eq('id', assessModal.id)
        .select()
      if (error || !updated?.length) {
        showToast(
          error ? t('review_err_submit', { msg: error.message }) : t('review_err_submit_rls'),
          { tone: 'error' },
        )
        setAssessSaving(false)
        return
      }
    }

    setAssessSaving(false)
    showToast(submit ? t('review_self_submitted') : t('review_saved'))
    setAssessModal(null)
    fetchAll()
  }

  async function openDetailModal(participant) {
    const { questions, responses, steps } = await fetchReviewResult(participant, userProfile.department)
    setDetailQuestions(questions)
    setDetailResponses(responses)
    setDetailSteps(steps)
    setDetailModal(participant)

    // 看過就把這筆的未讀標記掉。刻意走 RPC 而不是直接 update：那支函式是
    // SECURITY DEFINER，只會寫 result_viewed_at 這一個欄位，不必為了標記已讀
    // 而開放員工更新自己整列資料（連 final_score 都能改）。
    if (!participant.result_viewed_at) {
      const { error } = await supabase.rpc('mark_review_result_viewed', { p_participant_id: participant.id })
      if (!error) {
        const now = new Date().toISOString()
        setPastParticipants(prev => prev.map(p => (p.id === participant.id ? { ...p, result_viewed_at: now } : p)))
      }
    }
  }

  if (loading) return <div><Skeleton height="120px" /></div>

  // 未讀 = 評分流程已跑完、但員工還沒點開看過結果的筆數。
  const unreadCount = pastParticipants.filter(p => !p.result_viewed_at).length
  const totalPages = Math.max(1, Math.ceil(pastParticipants.length / PAGE_SIZE))
  const pageItems = pastParticipants.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div>
      <EmployeeInfoHeader userProfile={userProfile} year={headerYear} />

      <Tabs tabs={[
        { key: 'self', label: t('review_tab_self'), active: tab === 'self', onClick: () => setTab('self') },
        { key: 'past', label: t('review_tab_past'), active: tab === 'past', onClick: () => setTab('past'), badge: unreadCount },
      ]} />

      {tab === 'self' && (
        activeParticipants.length === 0 ? (
          <Card><EmptyState title={t('home_review_not_in_period')} description={t('review_not_period_desc')} /></Card>
        ) : (
          <div className="review-list">
            {activeParticipants.map(p => (
              <Card key={p.id}>
                <div className="review-row">
                  <div>
                    <div className="review-row__title">{p.review?.title}</div>
                    <div className="review-row__meta">{t('review_cycle_meta', { year: t('review_year_label', { y: p.review?.year }), start: p.review?.start_date, end: p.review?.end_date })}</div>
                    {p.review?.self_assessment_deadline && (
                      <div className="review-row__sub">{t('review_self_deadline', { date: p.review.self_assessment_deadline })}</div>
                    )}
                  </div>
                  <div className="review-row__actions">
                    {p.self_submitted ? (
                      <Chip tone="warning">{t('review_self_done_pending')}</Chip>
                    ) : (
                      <Button size="sm" onClick={() => openAssessModal(p)}>{p._hasDraft ? t('review_continue_self') : t('review_start_self')}</Button>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )
      )}

      {tab === 'past' && (
        pastParticipants.length === 0 ? (
          <Card><EmptyState title={t('review_no_past')} /></Card>
        ) : (
          <>
            <div className="ui-table-wrap">
              <table className="ui-table">
                <thead><tr><th>{t('review_col_year')}</th><th>{t('review_col_final')}</th><th>{t('review_col_flow')}</th><th>{t('common_actions')}</th></tr></thead>
                <tbody>
                  {pageItems.map(p => {
                    const rating = ratingFor(p.final_score)
                    return (
                      <tr key={p.id}>
                        <td>{t('review_past_year_title', { year: t('review_year_label', { y: p.review?.year }), title: p.review?.title })}</td>
                        <td>
                          {p.final_score != null ? t('review_points', { n: p.final_score }) : '—'}
                          {rating && <> <Chip tone={rating.tone}>{t(`rating_${rating.key}`)}</Chip></>}
                        </td>
                        <td>
                          {p.flow?.name || '—'}
                          <FlowSteps flow={p.flow} />
                        </td>
                        <td><Button size="sm" variant="outlined" onClick={() => openDetailModal(p)}>{t('review_view_detail')}</Button></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="review-pagination">
                <Button size="sm" variant="outlined" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('common_prev_page')}</Button>
                <span className="review-pagination__label">{t('common_page_indicator', { page, total: totalPages })}</span>
                <Button size="sm" variant="outlined" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>{t('common_next_page')}</Button>
              </div>
            )}
          </>
        )
      )}

      {assessModal && (
        <Dialog
          size="lg"
          title={t('review_assess_title', { title: assessModal.review?.title })}
          onClose={() => setAssessModal(null)}
          labelledBy="assess-dialog-title"
          actions={(
            <>
              <Button variant="text" onClick={() => setAssessModal(null)}>{t('common_cancel')}</Button>
              <Button variant="outlined" loading={assessSaving} onClick={() => handleSaveAssess(false)}>{t('common_save')}</Button>
              <Button loading={assessSaving} onClick={() => handleSaveAssess(true)}>{t('review_submit')}</Button>
            </>
          )}
        >
          {assessQuestions.length === 0 ? (
            <p className="review-hint">{t('review_no_questions')}</p>
          ) : assessQuestions.map((q, i) => (
            <div key={q.id} className="review-question">
              <label className="review-question__label">{i + 1}. {q.question_text} <span className="review-required">*</span></label>
              {q.question_type === 'text' ? (
                <Textarea
                  value={assessResponses[q.id]?.answer || ''}
                  onChange={e => setAssessResponses(p => ({ ...p, [q.id]: { ...p[q.id], answer: e.target.value } }))}
                  rows={4} placeholder={t('review_fill_placeholder')}
                />
              ) : (
                <>
                  <ScoreButtons min={q.score_min} max={q.score_max} value={assessResponses[q.id]?.answer} onChange={v => setAssessResponses(p => ({ ...p, [q.id]: { ...p[q.id], answer: v } }))} />
                  <Textarea
                    value={assessResponses[q.id]?.example_note || ''}
                    onChange={e => setAssessResponses(p => ({ ...p, [q.id]: { ...p[q.id], example_note: e.target.value } }))}
                    rows={2} placeholder={t('review_example_placeholder')}
                  />
                </>
              )}
            </div>
          ))}
        </Dialog>
      )}

      {detailModal && (
        <Dialog
          size="lg"
          title={t('review_result_title', { title: detailModal.review?.title })}
          onClose={() => setDetailModal(null)}
          labelledBy="detail-dialog-title"
          actions={<Button variant="text" onClick={() => setDetailModal(null)}>{t('common_close')}</Button>}
        >
          <ReviewResultBody
            questions={detailQuestions}
            responses={detailResponses}
            steps={detailSteps}
            finalScore={detailModal.final_score}
          />
        </Dialog>
      )}
    </div>
  )
}

// ===== 團隊管理與年度考核（主管：走得到的簽核鏈／老闆：全公司） =====
function TeamReviewManagement({ userProfile, isBoss }) {
  const [participants, setParticipants] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [readOnly, setReadOnly] = useState(false)
  const [questions, setQuestions] = useState([])
  const [responses, setResponses] = useState({})
  const [evalResponses, setEvalResponses] = useState({})
  const [priorSteps, setPriorSteps] = useState([])
  const [overallScore, setOverallScore] = useState('')
  const [overallComment, setOverallComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { showToast } = useToast()
  const { t } = useLanguage()

  useEffect(() => { fetchParticipants() }, [])

  async function fetchParticipants() {
    const { data: myStepsData } = await supabase.from('review_flow_steps').select('flow_id, step_order').eq('evaluator_id', userProfile.id)
    const myFlowStepPairs = myStepsData || []
    const myFlowIds = [...new Set(myFlowStepPairs.map(s => s.flow_id))]

    if (!isBoss && myFlowIds.length === 0) { setParticipants([]); setLoading(false); return }

    // Deliberately conservative: only columns and relationships we know
    // exist. PostgREST fails the WHOLE request if any one embed or ordering
    // column can't be resolved, and it returns no rows rather than partial
    // data -- which is exactly how this screen ended up silently showing an
    // empty team list. Ordering is done client-side for the same reason
    // (annual_review_participants predates this project and its columns
    // aren't all ours to assume).
    let query = supabase
      .from('annual_review_participants')
      .select(`
        *,
        review:annual_reviews(*),
        user:users!annual_review_participants_user_id_fkey(full_name, email, role, department)
      `)
    if (!isBoss) query = query.in('flow_id', myFlowIds)
    const { data, error } = await query
    if (error) {
      showToast(t('review_err_fetch_team', { msg: error.message }), { tone: 'error' })
      setParticipants([])
      setLoading(false)
      return
    }

    const rows = data || []

    // Flows are fetched separately so a problem resolving them degrades to
    // "no flow shown" instead of blanking the entire team list.
    const flowIds = [...new Set(rows.map(r => r.flow_id).filter(Boolean))]
    let flowsById = {}
    if (flowIds.length > 0) {
      const { data: flows } = await supabase
        .from('review_flows')
        .select('id, name, steps:review_flow_steps(step_order, evaluator:users(full_name))')
        .in('id', flowIds)
      flowsById = Object.fromEntries((flows || []).map(f => [f.id, f]))
    }

    const myStepSet = new Set(myFlowStepPairs.map(s => `${s.flow_id}:${s.step_order}`))
    for (const p of rows) {
      p.flow = flowsById[p.flow_id] || null
      p._myTurn = p.self_submitted && !p.supervisor_submitted && p.flow_id && myStepSet.has(`${p.flow_id}:${p.current_step}`)
    }

    // 有草稿 = 這一關已經寫過評分、但流程還沒往下走。分開查一次而不是塞進
    // 上面那個 select：評分內容跟參與者是兩張表，硬併成一個 embed 只要有
    // 一個環節解析不掉就會讓整份名單變空（先前就踩過）。
    const myTurnIds = rows.filter(p => p._myTurn).map(p => p.id)
    if (myTurnIds.length > 0) {
      const { data: drafts } = await supabase
        .from('review_evaluations')
        .select('participant_id, step_order')
        .in('participant_id', myTurnIds)
      const draftSet = new Set(
        (drafts || []).map(d => `${d.participant_id}:${d.step_order}`),
      )
      for (const p of rows) {
        p._hasDraft = p._myTurn && draftSet.has(`${p.id}:${p.current_step}`)
      }
    }

    rows.sort((a, b) => (a.user?.full_name || '').localeCompare(b.user?.full_name || ''))

    setParticipants(rows)
    setLoading(false)
  }

  async function handleSelect(participant, viewOnly) {
    setSelected(participant)
    setReadOnly(viewOnly)
    const templateId = await resolveTemplateId(participant.review, participant.user?.department)
    const { questions: qs, responses: rs } = await fetchQuestionsAndResponses(templateId, participant.id)
    setQuestions(qs)
    setResponses(rs)
    setEvalResponses({})
    setOverallScore('')
    setOverallComment('')

    const { data: evals } = await supabase
      .from('review_evaluations')
      .select('*, evaluator:users!review_evaluations_evaluator_id_fkey(full_name)')
      .eq('participant_id', participant.id)
      .order('step_order')

    const stepsMap = {}
    const draft = {}
    for (const e of evals || []) {
      const key = e.step_order ?? 0

      // 自己這一關的資料不是「前面關卡的評分」，而是自己上次存的草稿 ——
      // 要回填到表單裡，不是放進唯讀的 priorSteps。（唯讀檢視時例外：那時
      // 整條簽核鏈都已完成，每一關都該以唯讀的樣子呈現。）
      if (key === participant.current_step && !viewOnly) {
        if (e.is_overall) {
          setOverallScore(e.overall_score != null ? String(e.overall_score) : '')
          setOverallComment(e.overall_comment || '')
        } else if (e.question_id) {
          draft[e.question_id] = { answer: e.score_answer ?? e.text_answer, example_note: e.example_note || '' }
        }
        continue
      }

      if (!stepsMap[key]) stepsMap[key] = { step_order: key, evaluator_name: e.evaluator?.full_name, answers: {}, overall_score: null, overall_comment: null }
      if (e.is_overall) { stepsMap[key].overall_score = e.overall_score; stepsMap[key].overall_comment = e.overall_comment }
      else if (e.question_id) stepsMap[key].answers[e.question_id] = { answer: e.score_answer ?? e.text_answer, example_note: e.example_note || '' }
    }
    setEvalResponses(draft)
    setPriorSteps(Object.values(stepsMap).sort((a, b) => a.step_order - b.step_order))
  }

  /**
   * 儲存草稿：填多少存多少，完全不做必填檢查（不然存不了半成品）。
   * 只寫評分內容，不動 annual_review_participants 的流程狀態 —— 所以這位
   * 員工仍然停在這一關，主管下次進來會看到「繼續評分」。
   */
  async function handleSaveDraft() {
    setSubmitting(true)
    const error = await writeEvaluations({ requireOverall: false })
    if (error) {
      showToast(t('review_err_save', { msg: error.message }), { tone: 'error' })
      setSubmitting(false)
      return
    }
    setSubmitting(false)
    setSelected(null)
    showToast(t('review_draft_saved'))
    fetchParticipants()
  }

  /**
   * 把目前畫面上的評分寫進資料庫。草稿與正式送出共用這一段，差別只在
   * requireOverall（草稿時總評沒填就整列不寫，避免存進一筆分數為 0 的假資料）。
   * 有錯誤就回傳該錯誤，沒有則回傳 null。
   */
  async function writeEvaluations({ requireOverall }) {
    for (const q of questions) {
      const v = evalResponses[q.id]
      // 草稿階段允許沒填的題目，直接略過不寫
      if (v === undefined || v.answer === undefined || v.answer === '') continue
      const { error } = await supabase.from('review_evaluations').upsert({
        review_id: selected.review_id,
        participant_id: selected.id,
        evaluator_id: userProfile.id,
        question_id: q.id,
        text_answer: q.question_type === 'text' ? String(v.answer) : null,
        score_answer: q.question_type === 'score' ? Number(v.answer) : null,
        example_note: q.question_type === 'score' ? (v.example_note || null) : null,
        is_overall: false,
        step_order: selected.current_step,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'participant_id,question_id,step_order' })
      if (error) return error
    }

    // Overall row has question_id = NULL, which a plain unique constraint
    // can't dedupe -- delete-then-insert instead of upsert.
    const hasOverall = overallScore !== '' && overallScore != null
    if (!requireOverall && !hasOverall) return null

    const { error: delError } = await supabase.from('review_evaluations').delete()
      .eq('participant_id', selected.id).eq('step_order', selected.current_step).eq('is_overall', true)
    if (delError) return delError

    const { error: insError } = await supabase.from('review_evaluations').insert({
      review_id: selected.review_id,
      participant_id: selected.id,
      evaluator_id: userProfile.id,
      is_overall: true,
      overall_score: Number(overallScore),
      overall_comment: overallComment,
      step_order: selected.current_step,
      updated_at: new Date().toISOString(),
    })
    return insError ?? null
  }

  async function handleSubmit() {
    for (const q of questions) {
      const v = evalResponses[q.id]
      if (v === undefined || v.answer === undefined || v.answer === '') {
        showToast(t('review_err_required_score', { q: q.question_text }), { tone: 'error' })
        return
      }
    }
    if (!overallScore) { showToast(t('review_err_overall_score'), { tone: 'error' }); return }
    if (!overallComment) { showToast(t('review_err_overall_comment'), { tone: 'error' }); return }

    setSubmitting(true)

    // 每一步都要檢查錯誤。這整段原本完全沒有檢查，只要有一步被資料庫的
    // 權限規則擋下（主管的 RLS policy 缺漏就是這樣），畫面照樣顯示「評分
    // 已送出」，但實際上什麼都沒存進去 —— 而且沒有任何線索可以查。
    const fail = (key, error) => {
      showToast(t(key, { msg: error.message }), { tone: 'error' })
      setSubmitting(false)
    }

    const writeError = await writeEvaluations({ requireOverall: true })
    if (writeError) return fail('review_err_score_save', writeError)

    // 推進流程狀態時額外檢查回傳的資料列數：被 RLS 擋下的 UPDATE 不會報錯，
    // 只會回 0 筆 —— 只看 error 的話會誤判成成功。
    const totalSteps = selected.flow?.steps?.length || 1
    const isFinal = selected.current_step >= totalSteps
    let patch
    if (isFinal) {
      const scoreQuestionIds = questions.filter(q => q.question_type === 'score').map(q => q.id)
      const finalScore = await computeFinalScore(selected.id, scoreQuestionIds)
      patch = { supervisor_submitted: true, supervisor_submitted_at: new Date().toISOString(), final_score: finalScore }
    } else {
      patch = { current_step: selected.current_step + 1 }
    }

    const { data: updated, error: stepError } = await supabase
      .from('annual_review_participants').update(patch).eq('id', selected.id).select()
    if (stepError) return fail('review_err_status', stepError)
    if (!updated || updated.length === 0) {
      showToast(t('review_err_status_rls'), { tone: 'error' })
      setSubmitting(false)
      return
    }

    showToast(isFinal ? t('review_submitted_final') : t('review_submitted_next'))

    setSubmitting(false)
    setSelected(null)
    fetchParticipants()
  }

  if (loading) return <div><PageHeader title={isBoss ? t('review_team_title') : t('review_team_title_long')} /><Skeleton height="80px" /></div>

  const totalCount = participants.length
  const notSelfSubmittedCount = participants.filter(p => !p.self_submitted).length
  const pendingMyTurnCount = participants.filter(p => p._myTurn).length

  return (
    <div>
      <PageHeader title={isBoss ? t('review_team_title') : t('review_team_title_long')} />

      <div className="dash-review-card__grid">
        <div className="dash-review-card__tile">
          <div className="dash-review-card__tile-label">{t('review_stat_total')}</div>
          <div className="dash-review-card__tile-value">{totalCount}</div>
        </div>
        <div className="dash-review-card__tile">
          <div className="dash-review-card__tile-label">{t('review_stat_not_self')}</div>
          <div className="dash-review-card__tile-value">{notSelfSubmittedCount}</div>
        </div>
        <div className="dash-review-card__tile">
          <div className="dash-review-card__tile-label">{t('review_stat_my_turn')}</div>
          <div className="dash-review-card__tile-value">{pendingMyTurnCount}</div>
        </div>
      </div>

      {participants.length === 0 ? (
        <Card><EmptyState title={t('review_team_empty')} description={isBoss ? undefined : t('review_team_empty_desc')} /></Card>
      ) : (
        <div className="review-list">
          {participants.map(p => (
            <Card key={p.id}>
              <div className="review-row">
                <div>
                  <div className="review-row__title">{p.user?.full_name}</div>
                  <div className="review-row__meta">{p.review?.title}{t('common_meta_separator')}{t('review_year_label', { y: p.review?.year })}{isBoss && p.user?.department ? `${t('common_meta_separator')}${p.user.department}` : ''}</div>
                  <div className="review-row__chips">
                    <Chip tone={p.self_submitted ? 'success' : 'warning'}>{p.self_submitted ? t('review_self_done') : t('review_self_pending')}</Chip>
                    {isBoss && p.final_score != null && <Chip tone="neutral">{t('review_final_chip', { n: p.final_score })}</Chip>}
                  </div>
                  <FlowSteps flow={p.flow} />
                </div>
                <div className="review-row__actions">
                  <Chip tone={p.supervisor_submitted ? 'success' : p._myTurn ? 'warning' : 'neutral'}>
                    {p.supervisor_submitted ? t('review_status_scored')
                      : !p.self_submitted ? t('review_status_wait_self')
                      : p._myTurn ? t('review_status_my_turn')
                      : !p.flow_id ? t('review_status_no_flow')
                      : t('review_status_wait_step', { n: p.current_step })}
                  </Chip>
                  {p.supervisor_submitted && (
                    <Button size="sm" variant="outlined" onClick={() => handleSelect(p, true)}>{t('review_view_result')}</Button>
                  )}
                  {!p.supervisor_submitted && p._myTurn && p.review?.status === 'active' && (
                    <Button size="sm" onClick={() => handleSelect(p, false)}>
                      {p._hasDraft ? t('review_continue_score') : t('review_start_score')}
                    </Button>
                  )}
                  {/* Without this, "self-assessment submitted but no 開始評分
                      button" looks like a broken screen rather than a setup
                      gap the user can actually go and fix. */}
                  {!p.supervisor_submitted && p.self_submitted && !p._myTurn && (
                    <div className="review-row__sub">
                      {!p.flow_id
                        ? t('review_hint_no_flow')
                        : p.review?.status !== 'active'
                          ? t('review_hint_closed')
                          : t('review_hint_not_your_turn', { n: p.current_step })}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {selected && (
        <Dialog
          size="lg"
          title={readOnly
            ? t('review_eval_title_read', { name: selected.user?.full_name })
            : t('review_eval_title_edit', { name: selected.user?.full_name })}
          onClose={() => setSelected(null)}
          labelledBy="team-eval-dialog-title"
          actions={readOnly
            ? <Button variant="text" onClick={() => setSelected(null)}>{t('common_close')}</Button>
            : (
              <>
                <Button variant="text" onClick={() => setSelected(null)}>{t('common_cancel')}</Button>
                <Button variant="outlined" disabled={submitting} onClick={handleSaveDraft}>{t('common_save')}</Button>
                <Button loading={submitting} onClick={handleSubmit}>{t('review_submit_score')}</Button>
              </>
            )}
        >
          {priorSteps.length > 0 && (
            <p className="review-hint">{t('review_prior_hint', { n: selected.flow?.steps?.length || 1 })}</p>
          )}
          {questions.map((q, i) => (
            <div key={q.id} className="review-question">
              <div className="review-question__title">{i + 1}. {q.question_text}</div>
              <div className="review-result-box">
                <div className="review-result-box__label">{t('review_self_employee')}</div>
                <div>{responses[q.id]?.answer ?? '—'}</div>
                {responses[q.id]?.example_note && <div className="review-result-box__note">{t('review_example_note', { text: responses[q.id].example_note })}</div>}
              </div>
              {priorSteps.map(step => step.answers[q.id] && (
                <div key={step.step_order} className="review-result-box review-result-box--eval">
                  <div className="review-result-box__label review-result-box__label--eval">{t('review_evaluator_score', { name: step.evaluator_name || t('adminflows_step', { n: step.step_order }) })}</div>
                  <div>{step.answers[q.id].answer ?? '—'}</div>
                  {step.answers[q.id].example_note && <div className="review-result-box__note">{t('review_example_note', { text: step.answers[q.id].example_note })}</div>}
                </div>
              ))}
              {readOnly ? null : (
                <>
                  <label className="review-question__label">{t('review_my_score')} <span className="review-required">*</span></label>
                  {q.question_type === 'text' ? (
                    <Textarea value={evalResponses[q.id]?.answer || ''} onChange={e => setEvalResponses(p => ({ ...p, [q.id]: { ...p[q.id], answer: e.target.value } }))} rows={3} placeholder={t('review_comment_placeholder')} />
                  ) : (
                    <>
                      <ScoreButtons min={q.score_min} max={q.score_max} value={evalResponses[q.id]?.answer} onChange={v => setEvalResponses(p => ({ ...p, [q.id]: { ...p[q.id], answer: v } }))} />
                      <Textarea value={evalResponses[q.id]?.example_note || ''} onChange={e => setEvalResponses(p => ({ ...p, [q.id]: { ...p[q.id], example_note: e.target.value } }))} rows={2} placeholder={t('review_example_placeholder')} />
                    </>
                  )}
                </>
              )}
            </div>
          ))}

          <div className="review-overall-form">
            <h5 className="review-overall-form__title">{t('review_overall')}</h5>
            {readOnly ? (
              priorSteps.filter(s => s.step_order === selected.current_step || s.overall_score != null).map(step => (
                <div key={step.step_order}>
                  <div className="review-overall__score">{t('review_overall_step_total', { name: step.evaluator_name || t('adminflows_step', { n: step.step_order }) })}<strong>{step.overall_score ?? '—'}</strong></div>
                  {step.overall_comment && <div className="review-overall__comment">{step.overall_comment}</div>}
                </div>
              ))
            ) : (
              <>
                <div className="review-question">
                  <label className="review-question__label">{t('review_overall_score_label')}<span className="review-required">*</span></label>
                  <ScoreButtons min={1} max={10} value={overallScore} onChange={setOverallScore} />
                </div>
                <Textarea label={t('review_overall_comment')} required value={overallComment} onChange={e => setOverallComment(e.target.value)} rows={4} placeholder={t('review_overall_comment_placeholder')} />
              </>
            )}
          </div>

          {readOnly && selected.final_score != null && (
            <div className="review-overall">
              <div className="review-overall__title">{t('review_final_rating')}</div>
              <div className="review-overall__score">
                {t('review_points', { n: selected.final_score })}
                {(() => { const r = ratingFor(selected.final_score); return r ? `${t('common_meta_separator')}${t(`rating_${r.key}`)}` : '' })()}
              </div>
            </div>
          )}
        </Dialog>
      )}
    </div>
  )
}

// ===== 團隊年度考核（老闆：全公司名冊） =====
function CompanyReviewRoster({ userProfile, isBoss }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [dept, setDept] = useState('all')
  const [year, setYear] = useState('all')
  const [detail, setDetail] = useState(null)
  const [detailData, setDetailData] = useState(null)
  const { showToast } = useToast()
  const { t } = useLanguage()

  useEffect(() => { fetchRows() }, [])

  async function fetchRows() {
    setLoading(true)

    // 老闆看全公司；主管只看自己是評核人的那些簽核鏈 —— 跟「團隊管理」
    // 判定「我的團隊」的方式一致，兩個畫面才不會各講各話。
    let flowIds = null
    if (!isBoss) {
      const { data: mySteps } = await supabase
        .from('review_flow_steps').select('flow_id').eq('evaluator_id', userProfile.id)
      flowIds = [...new Set((mySteps || []).map(s => s.flow_id))]
      if (flowIds.length === 0) { setRows([]); setLoading(false); return }
    }

    // 只列出「跑完整條簽核鏈」的紀錄 —— 這頁看的是歷年考核結果，
    // 評分還沒跑完的人屬於「團隊管理」那一頁的事。
    let query = supabase
      .from('annual_review_participants')
      .select(`
        *,
        review:annual_reviews(title, year),
        user:users!annual_review_participants_user_id_fkey(full_name, department, job_title)
      `)
      .eq('supervisor_submitted', true)
    if (flowIds) query = query.in('flow_id', flowIds)

    const { data, error } = await query
    if (error) {
      showToast(t('review_err_fetch_roster', { msg: error.message }), { tone: 'error' })
      setRows([]); setLoading(false); return
    }

    // 年度新到舊、同年度依姓名排序（前端排，理由同「團隊管理」）
    const list = data || []
    list.sort((a, b) =>
      (b.review?.year || 0) - (a.review?.year || 0) ||
      (a.user?.full_name || '').localeCompare(b.user?.full_name || '')
    )
    setRows(list)
    setLoading(false)
  }

  async function openDetail(row) {
    setDetail(row)
    setDetailData(null)
    const result = await fetchReviewResult(row, row.user?.department)
    setDetailData(result)
  }

  const departments = [...new Set(rows.map(r => r.user?.department).filter(Boolean))].sort()
  const years = [...new Set(rows.map(r => r.review?.year).filter(Boolean))].sort((a, b) => b - a)
  const visible = rows.filter(r =>
    (dept === 'all' || r.user?.department === dept) &&
    (year === 'all' || String(r.review?.year) === year)
  )

  if (loading) return <div><PageHeader title={t('review_roster_title')} /><Skeleton height="80px" /></div>

  return (
    <div>
      <PageHeader title={t('review_roster_title')} />

      <div className="review-filters">
        <Select value={dept} onChange={e => setDept(e.target.value)} style={{ maxWidth: '200px' }} aria-label={t('review_filter_dept')}>
          <option value="all">{t('common_all_departments')}</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </Select>
        <Select value={year} onChange={e => setYear(e.target.value)} style={{ maxWidth: '160px' }} aria-label={t('review_filter_year')}>
          <option value="all">{t('review_all_years')}</option>
          {years.map(y => <option key={y} value={String(y)}>{t('review_year_label', { y })}</option>)}
        </Select>
      </div>

      {visible.length === 0 ? (
        <Card><EmptyState
          title={rows.length === 0 ? t('review_roster_empty_none') : t('review_roster_empty_filter')}
          description={rows.length === 0
            ? (isBoss ? t('review_roster_empty_desc_boss') : t('review_roster_empty_desc_sup'))
            : undefined}
        /></Card>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr><th>{t('home_employee_name')}</th><th>{t('adminusers_col_department')}</th><th>{t('adminusers_col_title')}</th><th>{t('review_col_year')}</th><th>{t('review_col_final')}</th><th>{t('common_actions')}</th></tr>
            </thead>
            <tbody>
              {visible.map(r => {
                const rating = ratingFor(r.final_score)
                return (
                  <tr key={r.id}>
                    <td>{r.user?.full_name || '—'}</td>
                    <td>{r.user?.department || '—'}</td>
                    <td>{r.user?.job_title || '—'}</td>
                    <td>{r.review?.year ? t('review_year_label', { y: r.review.year }) : '—'}</td>
                    <td>
                      {r.final_score != null ? t('review_points', { n: r.final_score }) : '—'}
                      {rating && <Chip tone={rating.tone}>{t(`rating_${rating.key}`)}</Chip>}
                    </td>
                    <td><Button size="sm" variant="outlined" onClick={() => openDetail(r)}>{t('review_view_detail')}</Button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <Dialog
          size="lg"
          title={t('review_roster_result_title', { name: detail.user?.full_name, year: t('review_year_label', { y: detail.review?.year }) })}
          onClose={() => setDetail(null)}
          actions={<Button variant="text" onClick={() => setDetail(null)}>{t('common_close')}</Button>}
        >
          {!detailData ? <Skeleton height="200px" /> : (
            <ReviewResultBody
              questions={detailData.questions}
              responses={detailData.responses}
              steps={detailData.steps}
              finalScore={detail.final_score}
              selfLabel={t('review_self_employee')}
            />
          )}
        </Dialog>
      )}
    </div>
  )
}

// ===== 部門考核設定：考核週期／考核題目／考核流程／參與者（主管／老闆專用） =====
function ReviewCycles() {
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newReview, setNewReview] = useState({ title: '', year: new Date().getFullYear(), start_date: '', end_date: '', self_assessment_deadline: '', evaluation_deadline: '' })
  const [defaultTemplateId, setDefaultTemplateId] = useState('')
  const [templates, setTemplates] = useState([])
  const [editingReview, setEditingReview] = useState(null)
  const [confirmDeleteReview, setConfirmDeleteReview] = useState(null)
  const [saving, setSaving] = useState(false)
  const { showToast } = useToast()
  const { t } = useLanguage()

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    // Any existing template can serve as a cycle's fallback default (used
    // for whichever departments don't have their own dedicated template) --
    // it doesn't have to be a department-less one itself.
    const [r, t] = await Promise.all([
      supabase.from('annual_reviews').select('*').order('year', { ascending: false }),
      supabase.from('review_templates').select('*').order('created_at', { ascending: false }),
    ])
    setReviews(r.data || [])
    setTemplates(t.data || [])
    setLoading(false)
  }

  async function handleAddReview() {
    if (!newReview.title || !newReview.start_date || !newReview.end_date) {
      showToast(t('reviewcycle_err_required'), { tone: 'error' }); return
    }
    if (!defaultTemplateId) {
      showToast(t('reviewcycle_err_no_template'), { tone: 'error' }); return
    }
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('annual_reviews').insert({
      title: newReview.title,
      year: newReview.year,
      template_id: defaultTemplateId,
      start_date: newReview.start_date,
      end_date: newReview.end_date,
      self_assessment_deadline: newReview.self_assessment_deadline || null,
      evaluation_deadline: newReview.evaluation_deadline || null,
      created_by: user.id,
    })
    if (error) { showToast(t('reviewcycle_err_add', { msg: error.message }), { tone: 'error' }); return }
    setNewReview({ title: '', year: new Date().getFullYear(), start_date: '', end_date: '', self_assessment_deadline: '', evaluation_deadline: '' })
    setShowAdd(false)
    fetchAll()
    showToast(t('reviewcycle_added'))
  }

  async function handleToggleReviewStatus(review) {
    const { error } = await supabase.from('annual_reviews')
      .update({ status: review.status === 'active' ? 'closed' : 'active' })
      .eq('id', review.id)
    if (error) { showToast(t('reviewcycle_err_update', { msg: error.message }), { tone: 'error' }); return }
    fetchAll()
  }

  function openEdit(review) {
    setEditingReview({
      id: review.id,
      title: review.title,
      year: review.year,
      template_id: review.template_id || '',
      start_date: review.start_date || '',
      end_date: review.end_date || '',
      self_assessment_deadline: review.self_assessment_deadline || '',
      evaluation_deadline: review.evaluation_deadline || '',
    })
  }

  async function handleSaveEdit() {
    if (!editingReview.title || !editingReview.start_date || !editingReview.end_date || !editingReview.template_id) {
      showToast(t('reviewcycle_err_required'), { tone: 'error' }); return
    }
    setSaving(true)
    const { data: updated, error } = await supabase.from('annual_reviews').update({
      title: editingReview.title,
      year: editingReview.year,
      template_id: editingReview.template_id,
      start_date: editingReview.start_date,
      end_date: editingReview.end_date,
      self_assessment_deadline: editingReview.self_assessment_deadline || null,
      evaluation_deadline: editingReview.evaluation_deadline || null,
    }).eq('id', editingReview.id).select()
    setSaving(false)
    if (error || !updated?.length) {
      showToast(t('reviewcycle_err_save', { msg: error?.message || t('admin_no_write_permission') }), { tone: 'error' }); return
    }
    setEditingReview(null)
    showToast(t('reviewcycle_updated'))
    fetchAll()
  }

  async function handleDeleteReview() {
    setSaving(true)
    const { error } = await supabase.from('annual_reviews').delete().eq('id', confirmDeleteReview.id)
    setSaving(false)
    if (error) {
      showToast(t('reviewcycle_err_delete'), { tone: 'error' })
      setConfirmDeleteReview(null)
      return
    }
    showToast(t('reviewcycle_deleted'))
    setConfirmDeleteReview(null)
    fetchAll()
  }

  if (loading) return <Skeleton height="120px" />

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">{t('reviewcycle_title')}</h4>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>{t('reviewcycle_add')}</Button>
      </div>
      <p className="review-hint">{t('reviewcycle_hint')}</p>

      {showAdd && (
        <Card className="review-form-card">
          <div className="review-form-grid">
            <input className="ui-field__control" value={newReview.title} onChange={e => setNewReview(p => ({ ...p, title: e.target.value }))} placeholder={t('reviewcycle_name_placeholder')} />
            <input className="ui-field__control" type="number" value={newReview.year} onChange={e => setNewReview(p => ({ ...p, year: Number(e.target.value) }))} />
            <label className="review-inline-label">{t('reviewcycle_default_template')}
              <select className="ui-field__control" value={defaultTemplateId} onChange={e => setDefaultTemplateId(e.target.value)}>
                <option value="">{t('reviewcycle_select_template')}</option>
                {templates.map(tpl => <option key={tpl.id} value={tpl.id}>{t('reviewcycle_template_option', { name: tpl.name, dept: tpl.department || t('reviewcycle_company_default') })}</option>)}
              </select>
            </label>
            <div />
            <label className="review-inline-label">{t('reviewcycle_start')}<input className="ui-field__control" type="date" value={newReview.start_date} onChange={e => setNewReview(p => ({ ...p, start_date: e.target.value }))} /></label>
            <label className="review-inline-label">{t('reviewcycle_end')}<input className="ui-field__control" type="date" value={newReview.end_date} min={newReview.start_date} onChange={e => setNewReview(p => ({ ...p, end_date: e.target.value }))} /></label>
            <label className="review-inline-label">{t('reviewcycle_self_deadline')}<input className="ui-field__control" type="date" value={newReview.self_assessment_deadline} onChange={e => setNewReview(p => ({ ...p, self_assessment_deadline: e.target.value }))} /></label>
            <label className="review-inline-label">{t('reviewcycle_eval_deadline')}<input className="ui-field__control" type="date" value={newReview.evaluation_deadline} onChange={e => setNewReview(p => ({ ...p, evaluation_deadline: e.target.value }))} /></label>
          </div>
          <div className="review-form-actions">
            <Button size="sm" onClick={handleAddReview}>{t('common_add')}</Button>
            <Button size="sm" variant="text" onClick={() => setShowAdd(false)}>{t('common_cancel')}</Button>
          </div>
        </Card>
      )}

      <div className="review-list">
        {reviews.map(r => (
          <Card key={r.id}>
            <div className="review-row">
              <div>
                <div className="review-row__title">{r.title}</div>
                <div className="review-row__meta">{t('review_cycle_meta', { year: t('review_year_label', { y: r.year }), start: r.start_date, end: r.end_date })}</div>
                {(r.self_assessment_deadline || r.evaluation_deadline) && (
                  <div className="review-row__sub">
                    {r.self_assessment_deadline && t('review_self_deadline', { date: r.self_assessment_deadline })}
                    {r.self_assessment_deadline && r.evaluation_deadline && t('common_meta_separator')}
                    {r.evaluation_deadline && t('reviewcycle_eval_due', { date: r.evaluation_deadline })}
                  </div>
                )}
              </div>
              <div className="review-row__actions">
                <Chip tone={r.status === 'active' ? 'success' : 'neutral'}>{r.status === 'active' ? t('home_review_in_progress') : t('reviewcycle_closed')}</Chip>
                <Button size="sm" variant="outlined" onClick={() => handleToggleReviewStatus(r)}>
                  {r.status === 'active' ? t('reviewcycle_close') : t('reviewcycle_reopen')}
                </Button>
                <Button size="sm" variant="outlined" onClick={() => openEdit(r)}>{t('common_edit')}</Button>
                <Button size="sm" variant="danger-outlined" onClick={() => setConfirmDeleteReview(r)}>{t('common_delete')}</Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {editingReview && (
        <Dialog
          title={t('reviewcycle_edit_title')}
          labelledBy="edit-review-dialog-title"
          onClose={() => setEditingReview(null)}
          actions={(
            <>
              <Button variant="text" onClick={() => setEditingReview(null)}>{t('common_cancel')}</Button>
              <Button loading={saving} onClick={handleSaveEdit}>{t('common_save')}</Button>
            </>
          )}
        >
          <div className="review-form-grid">
            <input className="ui-field__control" value={editingReview.title} onChange={e => setEditingReview(p => ({ ...p, title: e.target.value }))} placeholder={t('reviewcycle_name_placeholder_short')} />
            <input className="ui-field__control" type="number" value={editingReview.year} onChange={e => setEditingReview(p => ({ ...p, year: Number(e.target.value) }))} />
            <label className="review-inline-label">{t('reviewcycle_default_template_short')}
              <select className="ui-field__control" value={editingReview.template_id} onChange={e => setEditingReview(p => ({ ...p, template_id: e.target.value }))}>
                <option value="">{t('reviewcycle_select_template')}</option>
                {templates.map(tpl => <option key={tpl.id} value={tpl.id}>{t('reviewcycle_template_option', { name: tpl.name, dept: tpl.department || t('reviewcycle_company_default') })}</option>)}
              </select>
            </label>
            <div />
            <label className="review-inline-label">{t('reviewcycle_start')}<input className="ui-field__control" type="date" value={editingReview.start_date} onChange={e => setEditingReview(p => ({ ...p, start_date: e.target.value }))} /></label>
            <label className="review-inline-label">{t('reviewcycle_end')}<input className="ui-field__control" type="date" value={editingReview.end_date} min={editingReview.start_date} onChange={e => setEditingReview(p => ({ ...p, end_date: e.target.value }))} /></label>
            <label className="review-inline-label">{t('reviewcycle_self_deadline')}<input className="ui-field__control" type="date" value={editingReview.self_assessment_deadline} onChange={e => setEditingReview(p => ({ ...p, self_assessment_deadline: e.target.value }))} /></label>
            <label className="review-inline-label">{t('reviewcycle_eval_deadline')}<input className="ui-field__control" type="date" value={editingReview.evaluation_deadline} onChange={e => setEditingReview(p => ({ ...p, evaluation_deadline: e.target.value }))} /></label>
          </div>
        </Dialog>
      )}

      {confirmDeleteReview && (
        <ConfirmDialog
          title={t('reviewcycle_delete_title')}
          description={t('reviewcycle_delete_desc', { title: confirmDeleteReview.title })}
          confirmLabel={t('common_delete')}
          danger
          loading={saving}
          onConfirm={handleDeleteReview}
          onCancel={() => setConfirmDeleteReview(null)}
        />
      )}
    </div>
  )
}

function ReviewQuestionSets({ userProfile, isBoss }) {
  const [templates, setTemplates] = useState([])
  const [departments, setDepartments] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newTemplate, setNewTemplate] = useState({ name: '', description: '', department: isBoss ? '' : (userProfile.department || '') })
  const [editTemplate, setEditTemplate] = useState(null)
  const [questions, setQuestions] = useState([])
  const [newQuestion, setNewQuestion] = useState({ question_text: '', question_type: 'score' })
  const [editingMeta, setEditingMeta] = useState(null)
  const [confirmDeleteTemplate, setConfirmDeleteTemplate] = useState(null)
  const [saving, setSaving] = useState(false)
  const { showToast } = useToast()
  const { t } = useLanguage()

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    const [t, u] = await Promise.all([
      supabase.from('review_templates').select('*').order('created_at', { ascending: false }),
      supabase.from('users').select('department').not('department', 'is', null),
    ])
    const scoped = isBoss
      ? (t.data || [])
      : (t.data || []).filter(x => x.department === userProfile.department)
    setTemplates(scoped)
    setDepartments([...new Set((u.data || []).map(x => x.department))].filter(Boolean).sort())
    setLoading(false)
  }

  async function handleAddTemplate() {
    if (!newTemplate.name) { showToast(t('reviewq_err_name'), { tone: 'error' }); return }
    if (!isBoss && !userProfile.department) {
      showToast(t('reviewq_err_no_dept'), { tone: 'error' }); return
    }
    const { data: { user } } = await supabase.auth.getUser()
    const { data: created, error } = await supabase.from('review_templates').insert({
      name: newTemplate.name,
      description: newTemplate.description,
      department: isBoss ? (newTemplate.department || null) : userProfile.department,
      created_by: user.id,
    }).select('id, name').single()
    if (error) { showToast(t('reviewq_err_add', { msg: error.message }), { tone: 'error' }); return }

    // 同時建立一個同名的考核週期。
    //
    // 原本要建考核週期就得先有模板（週期必須選一份預設模板），於是主管得先
    // 建模板、再到隔壁分頁把同樣的名稱重打一次 —— 兩邊各自都是必要設定，
    // 但「名稱」這件事重複輸入沒有意義。日期先給預設值（都是必填欄位，
    // 不能留空），細節到「考核週期」分頁再編輯。
    const cycleError = await createMatchingCycle(created)

    setNewTemplate({ name: '', description: '', department: isBoss ? '' : (userProfile.department || '') })
    setShowAdd(false)
    showToast(cycleError
      ? t('reviewq_created_cycle_failed', { msg: cycleError.message })
      : t('reviewq_created_with_cycle'),
      { tone: cycleError ? 'error' : undefined })
    fetchAll()
  }

  /**
   * 為新建立的模板開一個同名的考核週期，狀態直接是「進行中」。
   *
   * 週期建立失敗不該讓模板一起失敗 —— 模板本身已經寫進去了，這裡只回傳
   * 錯誤讓呼叫端在提示裡說明，主管可以自己到「考核週期」分頁補。
   */
  async function createMatchingCycle(template) {
    const today = new Date()
    const iso = d => d.toISOString().slice(0, 10)
    const plusDays = n => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d) }

    const { error } = await supabase.from('annual_reviews').insert({
      title: template.name,
      year: today.getFullYear(),
      start_date: iso(today),
      end_date: `${today.getFullYear()}-12-31`,
      self_assessment_deadline: plusDays(14),
      evaluation_deadline: plusDays(28),
      template_id: template.id,
      status: 'active',
    })
    return error
  }

  async function fetchTemplateQuestions(templateId) {
    const { data } = await supabase
      .from('review_template_questions')
      .select('*')
      .eq('template_id', templateId)
      .order('order_index')
    setQuestions(data || [])
  }

  async function handleAddQuestion() {
    if (!newQuestion.question_text) { showToast(t('reviewq_err_question_text'), { tone: 'error' }); return }
    const { error } = await supabase.from('review_template_questions').insert({
      question_text: newQuestion.question_text,
      question_type: newQuestion.question_type,
      score_min: newQuestion.question_type === 'score' ? 1 : null,
      score_max: newQuestion.question_type === 'score' ? 10 : null,
      template_id: editTemplate.id,
      order_index: questions.length,
    })
    if (error) { showToast(t('reviewq_err_add', { msg: error.message }), { tone: 'error' }); return }
    setNewQuestion({ question_text: '', question_type: 'score' })
    fetchTemplateQuestions(editTemplate.id)
  }

  async function handleDeleteQuestion(id) {
    const { error } = await supabase.from('review_template_questions').delete().eq('id', id)
    if (error) { showToast(t('reviewq_err_delete_question', { msg: error.message }), { tone: 'error' }); return }
    fetchTemplateQuestions(editTemplate.id)
  }

  // 參數刻意不叫 t —— 那會遮蔽翻譯用的 t()
  function openEditMeta(tpl) {
    setEditingMeta({ id: tpl.id, name: tpl.name, description: tpl.description || '', department: tpl.department || '' })
  }

  async function handleSaveMeta() {
    if (!editingMeta.name) { showToast(t('reviewq_err_name'), { tone: 'error' }); return }
    setSaving(true)
    const { data: updated, error } = await supabase.from('review_templates').update({
      name: editingMeta.name,
      description: editingMeta.description || null,
      department: isBoss ? (editingMeta.department || null) : userProfile.department,
    }).eq('id', editingMeta.id).select()
    setSaving(false)
    if (error || !updated?.length) {
      showToast(t('reviewq_err_save', { msg: error?.message || t('admin_no_write_permission') }), { tone: 'error' }); return
    }
    setEditingMeta(null)
    showToast(t('reviewq_updated'))
    fetchAll()
  }

  async function handleDeleteTemplate() {
    setSaving(true)
    // Defensive: delete this template's own questions first rather than
    // assuming the DB cascades, then the template itself. If some
    // annual_reviews cycle still points at this template as its default,
    // the second delete will fail and we surface that clearly.
    await supabase.from('review_template_questions').delete().eq('template_id', confirmDeleteTemplate.id)
    const { error } = await supabase.from('review_templates').delete().eq('id', confirmDeleteTemplate.id)
    setSaving(false)
    if (error) {
      showToast(t('reviewq_err_delete'), { tone: 'error' })
      setConfirmDeleteTemplate(null)
      return
    }
    showToast(t('reviewq_deleted'))
    setConfirmDeleteTemplate(null)
    fetchAll()
  }

  if (loading) return <Skeleton height="120px" />

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">
          {isBoss ? t('reviewq_title_boss') : t('reviewq_title_dept', { dept: userProfile.department || t('reviewq_my_dept') })}
        </h4>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>{t('reviewq_add')}</Button>
      </div>
      <p className="review-hint">
        {t('reviewq_hint_before')}<strong>{t('reviewq_hint_strong')}</strong>{t('reviewq_hint_after')}
      </p>

      {showAdd && (
        <Card className="review-form-card">
          <div className="review-form-grid review-form-grid--single">
            <input className="ui-field__control" value={newTemplate.name} onChange={e => setNewTemplate(p => ({ ...p, name: e.target.value }))} placeholder={t('reviewq_name_placeholder')} />
            <input className="ui-field__control" value={newTemplate.description} onChange={e => setNewTemplate(p => ({ ...p, description: e.target.value }))} placeholder={t('reviewq_desc_placeholder')} />
            {isBoss ? (
              <select className="ui-field__control" value={newTemplate.department} onChange={e => setNewTemplate(p => ({ ...p, department: e.target.value }))}>
                <option value="">{t('reviewq_dept_none')}</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            ) : (
              <div className="review-hint">{t('reviewq_will_create_in', { dept: userProfile.department || t('reviewq_dept_unset') })}</div>
            )}
          </div>
          <div className="review-form-actions">
            <Button size="sm" onClick={handleAddTemplate}>{t('common_add')}</Button>
            <Button size="sm" variant="text" onClick={() => setShowAdd(false)}>{t('common_cancel')}</Button>
          </div>
        </Card>
      )}

      {templates.length === 0 ? (
        <Card><EmptyState title={t('reviewq_empty')} description={isBoss ? t('reviewq_empty_desc_boss') : t('reviewq_empty_desc_dept')} /></Card>
      ) : (
        <div className="review-list">
          {templates.map(tpl => (
            <Card key={tpl.id}>
              <div className="review-row">
                <div>
                  <div className="review-row__title">{tpl.name}</div>
                  <div className="review-row__meta">{tpl.department || t('reviewcycle_company_default')}{tpl.description ? `${t('common_meta_separator')}${tpl.description}` : ''}</div>
                </div>
                <div className="review-row__actions">
                  <Button size="sm" variant="outlined" onClick={() => { setEditTemplate(tpl); fetchTemplateQuestions(tpl.id) }}>{t('reviewq_set_questions')}</Button>
                  <Button size="sm" variant="outlined" onClick={() => openEditMeta(tpl)}>{t('common_edit')}</Button>
                  <Button size="sm" variant="danger-outlined" onClick={() => setConfirmDeleteTemplate(tpl)}>{t('common_delete')}</Button>
                </div>
              </div>

              {editTemplate?.id === tpl.id && (
                <div className="review-questions-editor">
                  {questions.map((q, i) => (
                    <div key={q.id} className="review-questions-editor__row">
                      <span>{i + 1}. {q.question_text}</span>
                      <Chip tone={q.question_type === 'score' ? 'info' : 'neutral'}>
                        {q.question_type === 'score' ? t('reviewq_type_score', { min: q.score_min, max: q.score_max }) : t('reviewq_type_text')}
                      </Chip>
                      <Button size="sm" variant="danger-outlined" onClick={() => handleDeleteQuestion(q.id)}>{t('common_delete')}</Button>
                    </div>
                  ))}
                  <Card className="review-form-card">
                    <div className="review-form-grid review-form-grid--single">
                      <input className="ui-field__control" value={newQuestion.question_text} onChange={e => setNewQuestion(p => ({ ...p, question_text: e.target.value }))} placeholder={t('reviewq_text_placeholder')} />
                      <select className="ui-field__control" value={newQuestion.question_type} onChange={e => setNewQuestion(p => ({ ...p, question_type: e.target.value }))}>
                        <option value="score">{t('reviewq_opt_score')}</option>
                        <option value="text">{t('reviewq_opt_text')}</option>
                      </select>
                    </div>
                    <div className="review-form-actions">
                      <Button size="sm" onClick={handleAddQuestion}>{t('reviewq_add_question')}</Button>
                      <Button size="sm" variant="text" onClick={() => setEditTemplate(null)}>{t('reviewq_done')}</Button>
                    </div>
                  </Card>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {editingMeta && (
        <Dialog
          title={t('reviewq_edit_title')}
          labelledBy="edit-template-dialog-title"
          onClose={() => setEditingMeta(null)}
          actions={(
            <>
              <Button variant="text" onClick={() => setEditingMeta(null)}>{t('common_cancel')}</Button>
              <Button loading={saving} onClick={handleSaveMeta}>{t('common_save')}</Button>
            </>
          )}
        >
          <div className="review-form-grid review-form-grid--single">
            <input className="ui-field__control" value={editingMeta.name} onChange={e => setEditingMeta(p => ({ ...p, name: e.target.value }))} placeholder={t('reviewq_name_placeholder_short')} />
            <input className="ui-field__control" value={editingMeta.description} onChange={e => setEditingMeta(p => ({ ...p, description: e.target.value }))} placeholder={t('reviewq_desc_placeholder')} />
            {isBoss ? (
              <select className="ui-field__control" value={editingMeta.department} onChange={e => setEditingMeta(p => ({ ...p, department: e.target.value }))}>
                <option value="">{t('reviewq_dept_none')}</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            ) : (
              <div className="review-hint">{t('reviewq_dept_label', { dept: userProfile.department || t('reviewq_dept_unset') })}</div>
            )}
          </div>
        </Dialog>
      )}

      {confirmDeleteTemplate && (
        <ConfirmDialog
          title={t('reviewq_delete_title')}
          description={t('reviewq_delete_desc', { name: confirmDeleteTemplate.name })}
          confirmLabel={t('common_delete')}
          danger
          loading={saving}
          onConfirm={handleDeleteTemplate}
          onCancel={() => setConfirmDeleteTemplate(null)}
        />
      )}
    </div>
  )
}

function ReviewFlows({ userProfile, isBoss }) {
  const [flows, setFlows] = useState([])
  const [departments, setDepartments] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newFlow, setNewFlow] = useState({ name: '', department: isBoss ? '' : (userProfile.department || '') })
  const [editSteps, setEditSteps] = useState(null)
  const [steps, setSteps] = useState([])
  const { showToast } = useToast()
  const { t } = useLanguage()

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    const [f, u, dep] = await Promise.all([
      supabase.from('review_flows').select('*, steps:review_flow_steps(*, evaluator:users(full_name))').order('created_at', { ascending: false }),
      supabase.from('users').select('id, full_name').eq('is_active', true).order('full_name'),
      supabase.from('users').select('department').not('department', 'is', null),
    ])
    const scoped = isBoss ? (f.data || []) : (f.data || []).filter(x => x.department === userProfile.department)
    setFlows(scoped)
    setUsers(u.data || [])
    setDepartments([...new Set((dep.data || []).map(x => x.department))].filter(Boolean).sort())
    setLoading(false)
  }

  async function handleAddFlow() {
    if (!newFlow.name) { showToast(t('adminflows_err_name'), { tone: 'error' }); return }
    if (!isBoss && !userProfile.department) {
      showToast(t('reviewq_err_no_dept'), { tone: 'error' }); return
    }
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('review_flows').insert({
      name: newFlow.name,
      department: isBoss ? (newFlow.department || null) : userProfile.department,
      created_by: user.id,
    })
    if (error) { showToast(t('adminflows_err_add', { msg: error.message }), { tone: 'error' }); return }
    setNewFlow({ name: '', department: isBoss ? '' : (userProfile.department || '') })
    setShowAdd(false)
    fetchAll()
  }

  async function handleSaveSteps(flowId) {
    const validSteps = steps.filter(s => s.evaluator_id)
    if (validSteps.length === 0) { showToast(t('reviewflow_err_no_evaluator'), { tone: 'error' }); return }
    const { error: delError } = await supabase.from('review_flow_steps').delete().eq('flow_id', flowId)
    if (delError) { showToast(t('adminflows_err_save', { msg: delError.message }), { tone: 'error' }); return }
    const { error: insError } = await supabase.from('review_flow_steps').insert(
      validSteps.map((step, i) => ({ flow_id: flowId, step_order: i + 1, evaluator_id: step.evaluator_id }))
    )
    if (insError) { showToast(t('adminflows_err_save', { msg: insError.message }), { tone: 'error' }); return }
    setEditSteps(null)
    fetchAll()
  }

  async function handleDeleteFlow(flowId) {
    const { error } = await supabase.from('review_flows').delete().eq('id', flowId)
    if (error) { showToast(t('reviewflow_err_delete'), { tone: 'error' }); return }
    fetchAll()
  }

  if (loading) return <Skeleton height="120px" />

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">
          {isBoss ? t('reviewflow_title_boss') : t('reviewflow_title_dept', { dept: userProfile.department || t('reviewq_my_dept') })}
        </h4>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>{t('adminflows_add')}</Button>
      </div>
      <p className="review-hint">{t('reviewflow_hint')}</p>

      {showAdd && (
        <Card className="review-form-card">
          <div className="review-form-grid review-form-grid--single">
            <input className="ui-field__control" value={newFlow.name} onChange={e => setNewFlow(p => ({ ...p, name: e.target.value }))} placeholder={t('reviewflow_name_placeholder')} />
            {isBoss ? (
              <select className="ui-field__control" value={newFlow.department} onChange={e => setNewFlow(p => ({ ...p, department: e.target.value }))}>
                <option value="">{t('reviewq_dept_none')}</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            ) : (
              <div className="review-hint">{t('reviewq_will_create_in', { dept: userProfile.department || t('reviewq_dept_unset') })}</div>
            )}
          </div>
          <div className="review-form-actions">
            <Button size="sm" onClick={handleAddFlow}>{t('common_add')}</Button>
            <Button size="sm" variant="text" onClick={() => setShowAdd(false)}>{t('common_cancel')}</Button>
          </div>
        </Card>
      )}

      {flows.length === 0 ? (
        <Card><EmptyState title={t('reviewflow_empty')} description={isBoss ? t('reviewflow_empty_desc_boss') : t('reviewflow_empty_desc_dept')} /></Card>
      ) : (
        <div className="review-list">
          {flows.map(f => (
            <Card key={f.id}>
              <div className="review-row">
                <div>
                  <div className="review-row__title">{f.name}</div>
                  <div className="review-row__meta">{f.department || t('reviewcycle_company_default')}</div>
                  {editSteps !== f.id && <FlowSteps flow={f} />}
                </div>
                <div className="review-row__actions">
                  <Button size="sm" variant="outlined" onClick={() => {
                    setEditSteps(f.id)
                    setSteps(f.steps?.sort((a, b) => a.step_order - b.step_order).map(s => ({ evaluator_id: s.evaluator_id })) || [{ evaluator_id: '' }])
                  }}>{t('reviewflow_set_steps')}</Button>
                  <Button size="sm" variant="danger-outlined" onClick={() => handleDeleteFlow(f.id)}>{t('common_delete')}</Button>
                </div>
              </div>

              {editSteps === f.id && (
                <div className="review-questions-editor">
                  {steps.map((step, i) => (
                    <div key={i} className="review-questions-editor__row">
                      <span>{t('adminflows_step', { n: i + 1 })}</span>
                      <select className="ui-field__control" style={{ flex: 1 }} value={step.evaluator_id} onChange={e => {
                        const updated = [...steps]; updated[i] = { evaluator_id: e.target.value }; setSteps(updated)
                      }}>
                        <option value="">{t('reviewflow_select_evaluator')}</option>
                        {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                      </select>
                      <Button size="sm" variant="danger-outlined" onClick={() => setSteps(steps.filter((_, idx) => idx !== i))}>{t('common_delete')}</Button>
                    </div>
                  ))}
                  <div className="review-form-actions">
                    <Button size="sm" variant="outlined" onClick={() => setSteps([...steps, { evaluator_id: '' }])}>{t('adminflows_add_step')}</Button>
                    <Button size="sm" onClick={() => handleSaveSteps(f.id)}>{t('common_save')}</Button>
                    <Button size="sm" variant="text" onClick={() => setEditSteps(null)}>{t('common_cancel')}</Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function ReviewParticipants({ userProfile, isBoss }) {
  const [reviews, setReviews] = useState([])
  const [selectedReviewId, setSelectedReviewId] = useState('')
  const [users, setUsers] = useState([])
  const [participants, setParticipants] = useState([])
  const [loading, setLoading] = useState(true)
  const [manualSelection, setManualSelection] = useState([])
  const { showToast } = useToast()
  const { t } = useLanguage()

  useEffect(() => { fetchReviews() }, [])
  useEffect(() => { if (selectedReviewId) { fetchUsers(); fetchParticipants() } }, [selectedReviewId])

  async function fetchReviews() {
    const { data } = await supabase.from('annual_reviews').select('*').order('year', { ascending: false })
    setReviews(data || [])
    if (data?.length) setSelectedReviewId(data[0].id)
    setLoading(false)
  }

  async function fetchUsers() {
    let query = supabase.from('users').select('id, full_name, department, manager_id, is_active').eq('is_active', true).order('full_name')
    if (!isBoss) query = query.eq('department', userProfile.department)
    const { data } = await query
    setUsers(data || [])
  }

  async function fetchParticipants() {
    const { data } = await supabase
      .from('annual_review_participants')
      .select('*, user:users!annual_review_participants_user_id_fkey(full_name), supervisor:users!annual_review_participants_supervisor_id_fkey(full_name)')
      .eq('review_id', selectedReviewId)
    setParticipants(data || [])
  }

  const existingUserIds = new Set(participants.map(p => p.user_id))
  const candidates = users.filter(u => manualSelection.includes(u.id) && !existingUserIds.has(u.id))

  async function handleAdd() {
    if (candidates.length === 0) { showToast(t('reviewpart_err_select'), { tone: 'error' }); return }

    const rows = []
    const missingFlow = []
    for (const u of candidates) {
      const flowId = await resolveFlowId(u.department)
      if (!flowId) { missingFlow.push(u.full_name); continue }
      rows.push({
        review_id: selectedReviewId,
        user_id: u.id,
        supervisor_id: isBoss ? (u.manager_id || null) : userProfile.id,
        flow_id: flowId,
        current_step: 1,
      })
    }
    if (missingFlow.length > 0) {
      showToast(t('reviewpart_err_missing_flow', { names: missingFlow.join(t('common_list_separator')) }), { tone: 'error' })
    }
    if (rows.length === 0) return

    const { error } = await supabase.from('annual_review_participants').insert(rows)
    if (error) { showToast(t('reviewpart_err_add', { msg: error.message }), { tone: 'error' }); return }
    showToast(t('reviewpart_added', { n: rows.length }))
    setManualSelection([])
    fetchParticipants()
  }

  async function handleRemove(participantId) {
    await supabase.from('annual_review_participants').delete().eq('id', participantId)
    fetchParticipants()
  }

  // 直屬主管 comes from users.manager_id, set in 員工帳號管理 -- but that
  // wasn't wired up until now, so anyone added before it existed (or
  // added by 老闆 for someone whose manager_id was never set) is stuck
  // showing 未指定 forever unless it can be fixed here directly.
  async function handleChangeSupervisor(participantId, supervisorId) {
    const { error } = await supabase.from('annual_review_participants')
      .update({ supervisor_id: supervisorId || null }).eq('id', participantId)
    if (error) { showToast(t('reviewpart_err_set_supervisor', { msg: error.message }), { tone: 'error' }); return }
    fetchParticipants()
  }

  if (loading) return <Skeleton height="120px" />

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">{t('reviewpart_title')}</h4>
      </div>
      <p className="review-hint">
        {isBoss
          ? t('reviewpart_hint_boss')
          : t('reviewpart_hint_dept', { dept: userProfile.department || t('reviewpart_hint_dept_unset') })}
        {t('reviewpart_hint_rest')}
      </p>

      <Card className="review-form-card">
        <select className="ui-field__control" value={selectedReviewId} onChange={e => setSelectedReviewId(e.target.value)} style={{ marginBottom: 'var(--space-150)' }}>
          <option value="">{t('reviewpart_select_cycle')}</option>
          {reviews.map(r => <option key={r.id} value={r.id}>{t('reviewpart_cycle_option', { title: r.title, year: r.year })}</option>)}
        </select>

        {selectedReviewId && (
          <>
            {(() => {
              // 已經是參與者的人不會出現在清單上，所以「全選」只針對還可以
              // 加入的人 —— 全選狀態也要照這份清單算，不然清單變動後
              // 勾選框的狀態會跟實際勾到的人對不起來。
              const selectable = users.filter(u => !existingUserIds.has(u.id))
              const allSelected = selectable.length > 0 && selectable.every(u => manualSelection.includes(u.id))
              return (
                <div className="review-manual-picker">
                  {selectable.length > 0 && (
                    <label className="review-checkbox review-checkbox--all">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={e => setManualSelection(e.target.checked ? selectable.map(u => u.id) : [])}
                      />
                      <strong>{t('reviewpart_select_all', { n: selectable.length })}</strong>
                    </label>
                  )}
                  {selectable.map(u => (
                    <label key={u.id} className="review-checkbox">
                      <input
                        type="checkbox"
                        checked={manualSelection.includes(u.id)}
                        onChange={e => setManualSelection(prev => e.target.checked ? [...prev, u.id] : prev.filter(id => id !== u.id))}
                      />
                      {u.full_name}
                    </label>
                  ))}
                  {selectable.length === 0 && (
                    <p className="review-hint">{t('reviewpart_none_left')}</p>
                  )}
                </div>
              )
            })()}
            <Button onClick={handleAdd} disabled={candidates.length === 0}>
              {candidates.length > 0 ? t('reviewpart_add_n', { n: candidates.length }) : t('reviewpart_add')}
            </Button>
          </>
        )}
      </Card>

      {selectedReviewId && participants.length > 0 && (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr><th>{t('adminusers_col_name')}</th><th>{t('adminusers_col_manager')}</th><th>{t('common_actions')}</th></tr>
            </thead>
            <tbody>
              {participants.map(p => (
                <tr key={p.id}>
                  <td>{p.user?.full_name}</td>
                  <td>
                    <select className="ui-field__control" value={p.supervisor_id || ''} onChange={e => handleChangeSupervisor(p.id, e.target.value)}>
                      <option value="">{t('adminusers_unassigned')}</option>
                      {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                    </select>
                    {!p.supervisor_id && <div className="review-missing-manager">{t('reviewpart_missing_manager')}</div>}
                  </td>
                  <td><Button size="sm" variant="danger-outlined" onClick={() => handleRemove(p.id)}>{t('adminnotify_remove')}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function DepartmentReviewSetup({ userProfile, isBoss }) {
  const location = useLocation()
  const { t } = useLanguage()

  const tabs = [
    { key: 'cycles', label: t('reviewsetup_tab_cycles'), to: '/review/setup', active: location.pathname === '/review/setup' },
    { key: 'questions', label: t('reviewsetup_tab_questions'), to: '/review/setup/questions', active: location.pathname === '/review/setup/questions' },
    { key: 'flows', label: t('reviewsetup_tab_flows'), to: '/review/setup/flows', active: location.pathname === '/review/setup/flows' },
    { key: 'participants', label: t('reviewsetup_tab_participants'), to: '/review/setup/participants', active: location.pathname === '/review/setup/participants' },
  ]

  return (
    <div>
      <PageHeader title={t('reviewsetup_title')} />
      <Tabs tabs={tabs} />
      <Routes>
        <Route index element={<ReviewCycles />} />
        <Route path="questions" element={<ReviewQuestionSets userProfile={userProfile} isBoss={isBoss} />} />
        <Route path="flows" element={<ReviewFlows userProfile={userProfile} isBoss={isBoss} />} />
        <Route path="participants" element={<ReviewParticipants userProfile={userProfile} isBoss={isBoss} />} />
      </Routes>
    </div>
  )
}

// ===== Review 主元件 =====
function Review({ userProfile }) {
  const location = useLocation()
  const { t } = useLanguage()
  const isBoss = userProfile?.role === 'boss'
  const isTeamManager = EVALUATOR_ROLES.includes(userProfile?.role)
  const canSelfAssess = userProfile?.role !== 'boss'

  // 一般員工（不是主管／老闆）：不需要額外的「考核管理」外層分頁，
  // 員工資訊卡＋年度自評／過往考核紀錄本身就是整個頁面。
  if (canSelfAssess && !isTeamManager) {
    return <EmployeeReviewSection userProfile={userProfile} />
  }

  const tabs = []
  if (canSelfAssess) tabs.push({ key: 'mine', path: '/review', label: t('review_tab_self'), end: true })
  if (isTeamManager) {
    tabs.push({ key: 'setup', path: '/review/setup', label: t('reviewsetup_title') })
    // 主管以前沒有獨立的「團隊年度考核」分頁，所以標籤叫「團隊管理與年度考核」；
    // 現在兩個分頁都有了，再留著那個名字只會跟隔壁分頁混淆。
    tabs.push({ key: 'team', path: '/review/team', label: t('review_team_title') })
  }
  // Was "/review/team/annual" -- a sibling page nested under the same URL
  // segment as "/review/team" (團隊管理), so a plain startsWith() prefix
  // match marked BOTH tabs active whenever viewing 團隊年度考核 (its path
  // literally starts with the other tab's path). Hyphenated instead of
  // nested so the two can never collide as prefixes of each other.
  // 主管也看得到，只是範圍縮到自己擔任評核人的簽核鏈
  if (isTeamManager) tabs.push({ key: 'team-annual', path: '/review/team-annual', label: t('review_roster_title') })

  return (
    <div>
      <PageHeader title={t('nav_review')} />
      <Tabs tabs={tabs.map(t => ({
        ...t,
        to: t.path,
        active: t.end ? location.pathname === t.path : (location.pathname === t.path || location.pathname.startsWith(t.path + '/')),
      }))} />

      <Routes>
        <Route index element={
          canSelfAssess
            ? <EmployeeReviewSection userProfile={userProfile} />
            : <Navigate to="team" replace />
        } />
        {isTeamManager && <Route path="setup/*" element={<DepartmentReviewSetup userProfile={userProfile} isBoss={isBoss} />} />}
        {isTeamManager && <Route path="team" element={<TeamReviewManagement userProfile={userProfile} isBoss={isBoss} />} />}
        {isTeamManager && <Route path="team-annual" element={<CompanyReviewRoster userProfile={userProfile} isBoss={isBoss} />} />}
        <Route path="*" element={<Navigate to="/review" replace />} />
      </Routes>
    </div>
  )
}

export default Review
