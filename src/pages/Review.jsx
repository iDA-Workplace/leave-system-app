import { useState, useEffect } from 'react'
import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  Button, Card, Chip, ConfirmDialog, Dialog, EmptyState, PageHeader, Skeleton, Tabs, Textarea,
} from '../components/ui'
import { useToast } from '../context/ToastContext'
import './Review.css'

const EVALUATOR_ROLES = ['supervisor', 'deputy_supervisor', 'boss']
const PAGE_SIZE = 5

// 分數區間對照表 (from iDA's own past annual-evaluation spreadsheet).
const RATING_BANDS = [
  { min: 90, max: 100, label: '卓越表現', tone: 'success' },
  { min: 80, max: 89, label: '優秀表現', tone: 'success' },
  { min: 70, max: 79, label: '符合預期', tone: 'info' },
  { min: 61, max: 69, label: '有待加強', tone: 'warning' },
  { min: 0, max: 60, label: '難以勝任', tone: 'error' },
]
function ratingFor(score) {
  if (score === null || score === undefined) return null
  return RATING_BANDS.find(b => score >= b.min && score <= b.max) || null
}

function formatTenure(hireDate) {
  if (!hireDate) return null
  const start = new Date(hireDate)
  const now = new Date()
  let years = now.getFullYear() - start.getFullYear()
  let months = now.getMonth() - start.getMonth()
  if (now.getDate() < start.getDate()) months -= 1
  if (months < 0) { years -= 1; months += 12 }
  if (years < 0) return '0年0個月'
  return `${years}年${months}個月`
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

  const responseMap = {}
  for (const r of rs || []) {
    responseMap[r.question_id] = {
      answer: r.question_type === 'score' ? r.score_answer : r.text_answer,
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
  if (!flow?.steps?.length) return null
  const sorted = [...flow.steps].sort((a, b) => a.step_order - b.step_order)
  return (
    <div className="review-flow-steps">
      {sorted.map((s, i) => (
        <span key={i}>
          {i > 0 && <span className="review-flow-arrow">→</span>}
          <Chip tone="neutral">第{s.step_order}關：{s.evaluator?.full_name || '未指定'}</Chip>
        </span>
      ))}
    </div>
  )
}

// ===== 員工資訊 =====
function EmployeeInfoHeader({ userProfile, year }) {
  const tenure = formatTenure(userProfile.hire_date)
  const name = userProfile.full_name
    ? `${userProfile.full_name}${userProfile.english_name ? ` (${userProfile.english_name})` : ''}`
    : userProfile.english_name
  const items = [
    ['姓名', name],
    ['部門', userProfile.department],
    ['職稱', userProfile.job_title],
    ['入職年月日', userProfile.hire_date],
    ['年資', tenure],
    ['評核年度', year ? `${year} 年度` : null],
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
  const [tab, setTab] = useState('self')
  const [activeParticipants, setActiveParticipants] = useState([])
  const [pastParticipants, setPastParticipants] = useState([])
  const [headerYear, setHeaderYear] = useState(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const { showToast } = useToast()

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
          showToast(`請填寫所有題目：「${q.question_text}」未填寫`, { tone: 'error' })
          return
        }
      }
    }
    setAssessSaving(true)
    for (const q of assessQuestions) {
      const v = assessResponses[q.id]
      if (v === undefined || v.answer === undefined || v.answer === '') continue
      await supabase.from('review_responses').upsert({
        review_id: assessModal.review_id,
        participant_id: assessModal.id,
        question_id: q.id,
        text_answer: q.question_type === 'text' ? String(v.answer) : null,
        score_answer: q.question_type === 'score' ? Number(v.answer) : null,
        example_note: q.question_type === 'score' ? (v.example_note || null) : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'participant_id,question_id' })
    }
    if (submit) {
      await supabase.from('annual_review_participants')
        .update({ self_submitted: true, self_submitted_at: new Date().toISOString() })
        .eq('id', assessModal.id)
    }
    setAssessSaving(false)
    showToast(submit ? '自評已送出！' : '已儲存')
    setAssessModal(null)
    fetchAll()
  }

  async function openDetailModal(participant) {
    const templateId = await resolveTemplateId(participant.review, userProfile.department)
    const { questions, responses } = await fetchQuestionsAndResponses(templateId, participant.id)
    setDetailQuestions(questions)
    setDetailResponses(responses)

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
        stepsMap[key].answers[e.question_id] = { answer: e.question_type === 'score' ? e.score_answer : e.text_answer, example_note: e.example_note || '' }
      }
    }
    setDetailSteps(Object.values(stepsMap).sort((a, b) => a.step_order - b.step_order))
    setDetailModal(participant)
  }

  if (loading) return <div><Skeleton height="120px" /></div>

  const totalPages = Math.max(1, Math.ceil(pastParticipants.length / PAGE_SIZE))
  const pageItems = pastParticipants.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div>
      <EmployeeInfoHeader userProfile={userProfile} year={headerYear} />

      <Tabs tabs={[
        { key: 'self', label: '年度自評', active: tab === 'self', onClick: () => setTab('self') },
        { key: 'past', label: '過往考核紀錄', active: tab === 'past', onClick: () => setTab('past') },
      ]} />

      {tab === 'self' && (
        activeParticipants.length === 0 ? (
          <Card><EmptyState title="非考核期間" description="目前沒有進行中的年度考核。" /></Card>
        ) : (
          <div className="review-list">
            {activeParticipants.map(p => (
              <Card key={p.id}>
                <div className="review-row">
                  <div>
                    <div className="review-row__title">{p.review?.title}</div>
                    <div className="review-row__meta">{p.review?.year} 年度｜{p.review?.start_date} ～ {p.review?.end_date}</div>
                    {p.review?.self_assessment_deadline && (
                      <div className="review-row__sub">自評截止：{p.review.self_assessment_deadline}</div>
                    )}
                  </div>
                  <div className="review-row__actions">
                    {p.self_submitted ? (
                      <Chip tone="warning">自評已完成，待評分</Chip>
                    ) : (
                      <Button size="sm" onClick={() => openAssessModal(p)}>{p._hasDraft ? '繼續自評' : '開始自評'}</Button>
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
          <Card><EmptyState title="尚無過往考核紀錄" /></Card>
        ) : (
          <>
            <div className="ui-table-wrap">
              <table className="ui-table">
                <thead><tr><th>考核年度</th><th>最終等級</th><th>評核流程</th><th>操作</th></tr></thead>
                <tbody>
                  {pageItems.map(p => {
                    const rating = ratingFor(p.final_score)
                    return (
                      <tr key={p.id}>
                        <td>{p.review?.year} 年度｜{p.review?.title}</td>
                        <td>
                          {p.final_score != null ? `${p.final_score} 分` : '—'}
                          {rating && <> <Chip tone={rating.tone}>{rating.label}</Chip></>}
                        </td>
                        <td>
                          {p.flow?.name || '—'}
                          <FlowSteps flow={p.flow} />
                        </td>
                        <td><Button size="sm" variant="outlined" onClick={() => openDetailModal(p)}>查看詳情</Button></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="review-pagination">
                <Button size="sm" variant="outlined" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一頁</Button>
                <span className="review-pagination__label">第 {page} / {totalPages} 頁</span>
                <Button size="sm" variant="outlined" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>下一頁</Button>
              </div>
            )}
          </>
        )
      )}

      {assessModal && (
        <Dialog
          size="lg"
          title={`填寫自評 — ${assessModal.review?.title}`}
          onClose={() => setAssessModal(null)}
          labelledBy="assess-dialog-title"
          actions={(
            <>
              <Button variant="text" onClick={() => setAssessModal(null)}>取消</Button>
              <Button variant="outlined" loading={assessSaving} onClick={() => handleSaveAssess(false)}>儲存</Button>
              <Button loading={assessSaving} onClick={() => handleSaveAssess(true)}>送出</Button>
            </>
          )}
        >
          {assessQuestions.length === 0 ? (
            <p className="review-hint">這個部門目前沒有設定考核題目，請先請主管或老闆到「部門考核設定」新增題目。</p>
          ) : assessQuestions.map((q, i) => (
            <div key={q.id} className="review-question">
              <label className="review-question__label">{i + 1}. {q.question_text} <span className="review-required">*</span></label>
              {q.question_type === 'text' ? (
                <Textarea
                  value={assessResponses[q.id]?.answer || ''}
                  onChange={e => setAssessResponses(p => ({ ...p, [q.id]: { ...p[q.id], answer: e.target.value } }))}
                  rows={4} placeholder="請填寫..."
                />
              ) : (
                <>
                  <ScoreButtons min={q.score_min} max={q.score_max} value={assessResponses[q.id]?.answer} onChange={v => setAssessResponses(p => ({ ...p, [q.id]: { ...p[q.id], answer: v } }))} />
                  <Textarea
                    value={assessResponses[q.id]?.example_note || ''}
                    onChange={e => setAssessResponses(p => ({ ...p, [q.id]: { ...p[q.id], example_note: e.target.value } }))}
                    rows={2} placeholder="請說明打這個分數的相關事例／理由"
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
          title={`考核結果 — ${detailModal.review?.title}`}
          onClose={() => setDetailModal(null)}
          labelledBy="detail-dialog-title"
          actions={<Button variant="text" onClick={() => setDetailModal(null)}>關閉</Button>}
        >
          {detailQuestions.map((q, i) => (
            <div key={q.id} className="review-result-question">
              <div className="review-result-question__title">{i + 1}. {q.question_text}</div>
              <div className="review-result-box">
                <div className="review-result-box__label">我的自評</div>
                <div>{detailResponses[q.id]?.answer ?? '—'}</div>
                {detailResponses[q.id]?.example_note && <div className="review-result-box__note">相關事例：{detailResponses[q.id].example_note}</div>}
              </div>
              {detailSteps.map(step => step.answers[q.id] && (
                <div key={step.step_order} className="review-result-box review-result-box--eval">
                  <div className="review-result-box__label review-result-box__label--eval">{step.evaluator_name || `第${step.step_order}關`} 的評分</div>
                  <div>{step.answers[q.id].answer ?? '—'}</div>
                  {step.answers[q.id].example_note && <div className="review-result-box__note">相關事例：{step.answers[q.id].example_note}</div>}
                </div>
              ))}
            </div>
          ))}
          {detailSteps.map(step => (
            <div key={step.step_order} className="review-overall">
              <div className="review-overall__title">{step.evaluator_name || `第${step.step_order}關`} 的總評</div>
              <div className="review-overall__score">總評分數：<strong>{step.overall_score ?? '—'}</strong> 分</div>
              {step.overall_comment && <div className="review-overall__comment">{step.overall_comment}</div>}
            </div>
          ))}
          {detailModal.final_score != null && (
            <div className="review-overall">
              <div className="review-overall__title">最終等級</div>
              <div className="review-overall__score">
                {detailModal.final_score} 分
                {(() => { const r = ratingFor(detailModal.final_score); return r ? `｜${r.label}` : '' })()}
              </div>
            </div>
          )}
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
      showToast('讀取團隊考核資料失敗：' + error.message, { tone: 'error' })
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
    for (const e of evals || []) {
      const key = e.step_order ?? 0
      if (key === participant.current_step && !viewOnly) continue // this is my step being filled in now, not "prior"
      if (!stepsMap[key]) stepsMap[key] = { step_order: key, evaluator_name: e.evaluator?.full_name, answers: {}, overall_score: null, overall_comment: null }
      if (e.is_overall) { stepsMap[key].overall_score = e.overall_score; stepsMap[key].overall_comment = e.overall_comment }
      else if (e.question_id) stepsMap[key].answers[e.question_id] = { answer: e.question_type === 'score' ? e.score_answer : e.text_answer, example_note: e.example_note || '' }
    }
    setPriorSteps(Object.values(stepsMap).sort((a, b) => a.step_order - b.step_order))
  }

  async function handleSubmit() {
    for (const q of questions) {
      const v = evalResponses[q.id]
      if (v === undefined || v.answer === undefined || v.answer === '') {
        showToast(`請填寫所有評分題目：「${q.question_text}」未填寫`, { tone: 'error' })
        return
      }
    }
    if (!overallScore) { showToast('請填寫總評分數', { tone: 'error' }); return }
    if (!overallComment) { showToast('請填寫總評評語', { tone: 'error' }); return }

    setSubmitting(true)

    for (const q of questions) {
      const v = evalResponses[q.id]
      await supabase.from('review_evaluations').upsert({
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
    }

    // Overall row has question_id = NULL, which a plain unique constraint
    // can't dedupe -- delete-then-insert instead of upsert.
    await supabase.from('review_evaluations').delete()
      .eq('participant_id', selected.id).eq('step_order', selected.current_step).eq('is_overall', true)
    await supabase.from('review_evaluations').insert({
      review_id: selected.review_id,
      participant_id: selected.id,
      evaluator_id: userProfile.id,
      is_overall: true,
      overall_score: Number(overallScore),
      overall_comment: overallComment,
      step_order: selected.current_step,
      updated_at: new Date().toISOString(),
    })

    const totalSteps = selected.flow?.steps?.length || 1
    if (selected.current_step >= totalSteps) {
      const scoreQuestionIds = questions.filter(q => q.question_type === 'score').map(q => q.id)
      const finalScore = await computeFinalScore(selected.id, scoreQuestionIds)
      await supabase.from('annual_review_participants')
        .update({ supervisor_submitted: true, supervisor_submitted_at: new Date().toISOString(), final_score: finalScore })
        .eq('id', selected.id)
      showToast('評分已送出，考核流程已完成，員工現在可以查看結果')
    } else {
      await supabase.from('annual_review_participants')
        .update({ current_step: selected.current_step + 1 })
        .eq('id', selected.id)
      showToast('評分已送出，已轉交下一關評核人')
    }

    setSubmitting(false)
    setSelected(null)
    fetchParticipants()
  }

  if (loading) return <div><PageHeader title={isBoss ? '團隊管理' : '團隊管理與年度考核'} /><Skeleton height="80px" /></div>

  const totalCount = participants.length
  const notSelfSubmittedCount = participants.filter(p => !p.self_submitted).length
  const pendingMyTurnCount = participants.filter(p => p._myTurn).length

  return (
    <div>
      <PageHeader title={isBoss ? '團隊管理' : '團隊管理與年度考核'} />

      <div className="dash-review-card__grid">
        <div className="dash-review-card__tile">
          <div className="dash-review-card__tile-label">團隊總人數</div>
          <div className="dash-review-card__tile-value">{totalCount}</div>
        </div>
        <div className="dash-review-card__tile">
          <div className="dash-review-card__tile-label">未提交自評人數</div>
          <div className="dash-review-card__tile-value">{notSelfSubmittedCount}</div>
        </div>
        <div className="dash-review-card__tile">
          <div className="dash-review-card__tile-label">待我評分數量</div>
          <div className="dash-review-card__tile-value">{pendingMyTurnCount}</div>
        </div>
      </div>

      {participants.length === 0 ? (
        <Card><EmptyState title="目前沒有團隊成員的考核資料" description={isBoss ? undefined : '請先到「部門考核設定」建立考核流程並加入參與者。'} /></Card>
      ) : (
        <div className="review-list">
          {participants.map(p => (
            <Card key={p.id}>
              <div className="review-row">
                <div>
                  <div className="review-row__title">{p.user?.full_name}</div>
                  <div className="review-row__meta">{p.review?.title}｜{p.review?.year} 年度{isBoss && p.user?.department ? `｜${p.user.department}` : ''}</div>
                  <div className="review-row__chips">
                    <Chip tone={p.self_submitted ? 'success' : 'warning'}>{p.self_submitted ? '自評已完成' : '待完成自評'}</Chip>
                    {isBoss && p.final_score != null && <Chip tone="neutral">最終等級：{p.final_score} 分</Chip>}
                  </div>
                  <FlowSteps flow={p.flow} />
                </div>
                <div className="review-row__actions">
                  <Chip tone={p.supervisor_submitted ? 'success' : p._myTurn ? 'warning' : 'neutral'}>
                    {p.supervisor_submitted ? '已完成評分'
                      : !p.self_submitted ? '待員工自評'
                      : p._myTurn ? '待我評分'
                      : !p.flow_id ? '尚未設定考核流程'
                      : `待第${p.current_step}關評分`}
                  </Chip>
                  {p.supervisor_submitted && (
                    <Button size="sm" variant="outlined" onClick={() => handleSelect(p, true)}>查看結果</Button>
                  )}
                  {!p.supervisor_submitted && p._myTurn && p.review?.status === 'active' && (
                    <Button size="sm" onClick={() => handleSelect(p, false)}>開始評分</Button>
                  )}
                  {/* Without this, "self-assessment submitted but no 開始評分
                      button" looks like a broken screen rather than a setup
                      gap the user can actually go and fix. */}
                  {!p.supervisor_submitted && p.self_submitted && !p._myTurn && (
                    <div className="review-row__sub">
                      {!p.flow_id
                        ? '此員工沒有考核流程，請到「部門考核設定 → 考核流程」建立後，移除再重新加入參與者'
                        : p.review?.status !== 'active'
                          ? '此考核週期已結束，請到「考核週期」重新開放'
                          : `目前輪到第 ${p.current_step} 關的評核人，不是您`}
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
          title={`${readOnly ? '考核結果' : '評分'} — ${selected.user?.full_name}`}
          onClose={() => setSelected(null)}
          labelledBy="team-eval-dialog-title"
          actions={readOnly
            ? <Button variant="text" onClick={() => setSelected(null)}>關閉</Button>
            : (
              <>
                <Button variant="text" onClick={() => setSelected(null)}>取消</Button>
                <Button loading={submitting} onClick={handleSubmit}>送出評分</Button>
              </>
            )}
        >
          {priorSteps.length > 0 && (
            <p className="review-hint">此員工的考核流程共 {selected.flow?.steps?.length || 1} 關，以下先顯示前面關卡已完成的評分作為參考。</p>
          )}
          {questions.map((q, i) => (
            <div key={q.id} className="review-question">
              <div className="review-question__title">{i + 1}. {q.question_text}</div>
              <div className="review-result-box">
                <div className="review-result-box__label">員工自評</div>
                <div>{responses[q.id]?.answer ?? '—'}</div>
                {responses[q.id]?.example_note && <div className="review-result-box__note">相關事例：{responses[q.id].example_note}</div>}
              </div>
              {priorSteps.map(step => step.answers[q.id] && (
                <div key={step.step_order} className="review-result-box review-result-box--eval">
                  <div className="review-result-box__label review-result-box__label--eval">{step.evaluator_name || `第${step.step_order}關`} 的評分</div>
                  <div>{step.answers[q.id].answer ?? '—'}</div>
                  {step.answers[q.id].example_note && <div className="review-result-box__note">相關事例：{step.answers[q.id].example_note}</div>}
                </div>
              ))}
              {readOnly ? null : (
                <>
                  <label className="review-question__label">我的評分 <span className="review-required">*</span></label>
                  {q.question_type === 'text' ? (
                    <Textarea value={evalResponses[q.id]?.answer || ''} onChange={e => setEvalResponses(p => ({ ...p, [q.id]: { ...p[q.id], answer: e.target.value } }))} rows={3} placeholder="請填寫評語..." />
                  ) : (
                    <>
                      <ScoreButtons min={q.score_min} max={q.score_max} value={evalResponses[q.id]?.answer} onChange={v => setEvalResponses(p => ({ ...p, [q.id]: { ...p[q.id], answer: v } }))} />
                      <Textarea value={evalResponses[q.id]?.example_note || ''} onChange={e => setEvalResponses(p => ({ ...p, [q.id]: { ...p[q.id], example_note: e.target.value } }))} rows={2} placeholder="請說明打這個分數的相關事例／理由" />
                    </>
                  )}
                </>
              )}
            </div>
          ))}

          <div className="review-overall-form">
            <h5 className="review-overall-form__title">總評</h5>
            {readOnly ? (
              priorSteps.filter(s => s.step_order === selected.current_step || s.overall_score != null).map(step => (
                <div key={step.step_order}>
                  <div className="review-overall__score">{step.evaluator_name || `第${step.step_order}關`} 總分：<strong>{step.overall_score ?? '—'}</strong> 分</div>
                  {step.overall_comment && <div className="review-overall__comment">{step.overall_comment}</div>}
                </div>
              ))
            ) : (
              <>
                <div className="review-question">
                  <label className="review-question__label">總評分數（1-10）<span className="review-required">*</span></label>
                  <ScoreButtons min={1} max={10} value={overallScore} onChange={setOverallScore} />
                </div>
                <Textarea label="總評評語" required value={overallComment} onChange={e => setOverallComment(e.target.value)} rows={4} placeholder="請填寫總評評語..." />
              </>
            )}
          </div>

          {readOnly && selected.final_score != null && (
            <div className="review-overall">
              <div className="review-overall__title">最終等級</div>
              <div className="review-overall__score">
                {selected.final_score} 分
                {(() => { const r = ratingFor(selected.final_score); return r ? `｜${r.label}` : '' })()}
              </div>
            </div>
          )}
        </Dialog>
      )}
    </div>
  )
}

// ===== 團隊年度考核（老闆：全公司名冊） =====
function CompanyReviewRoster() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetchRows() }, [])

  async function fetchRows() {
    const { data } = await supabase
      .from('users')
      .select('id, full_name, department, job_title')
      .eq('is_active', true)
      .order('full_name')
    setRows(data || [])
    setLoading(false)
  }

  if (loading) return <div><PageHeader title="團隊年度考核" /><Skeleton height="80px" /></div>

  return (
    <div>
      <PageHeader title="團隊年度考核" />
      {rows.length === 0 ? (
        <Card><EmptyState title="尚無員工資料" /></Card>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead><tr><th>員工姓名</th><th>部門</th><th>職稱</th></tr></thead>
            <tbody>
              {rows.map(u => (
                <tr key={u.id}>
                  <td>{u.full_name}</td>
                  <td>{u.department || '—'}</td>
                  <td>{u.job_title || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      showToast('請填寫所有必填欄位', { tone: 'error' }); return
    }
    if (!defaultTemplateId) {
      showToast('請先在「考核題目」分頁建立至少一份考核模板', { tone: 'error' }); return
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
    if (error) { showToast('新增失敗：' + error.message, { tone: 'error' }); return }
    setNewReview({ title: '', year: new Date().getFullYear(), start_date: '', end_date: '', self_assessment_deadline: '', evaluation_deadline: '' })
    setShowAdd(false)
    fetchAll()
    showToast('已新增考核週期')
  }

  async function handleToggleReviewStatus(review) {
    const { error } = await supabase.from('annual_reviews')
      .update({ status: review.status === 'active' ? 'closed' : 'active' })
      .eq('id', review.id)
    if (error) { showToast('更新失敗：' + error.message, { tone: 'error' }); return }
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
      showToast('請填寫所有必填欄位', { tone: 'error' }); return
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
      showToast('儲存失敗：' + (error?.message || '沒有權限寫入'), { tone: 'error' }); return
    }
    setEditingReview(null)
    showToast('已更新考核週期')
    fetchAll()
  }

  async function handleDeleteReview() {
    setSaving(true)
    const { error } = await supabase.from('annual_reviews').delete().eq('id', confirmDeleteReview.id)
    setSaving(false)
    if (error) {
      showToast('刪除失敗：這個週期已經有員工參與考核，無法刪除，請改用「結束週期」。', { tone: 'error' })
      setConfirmDeleteReview(null)
      return
    }
    showToast('已刪除考核週期')
    setConfirmDeleteReview(null)
    fetchAll()
  }

  if (loading) return <Skeleton height="120px" />

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">年度考核週期</h4>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>+ 新增週期</Button>
      </div>
      <p className="review-hint">考核週期是全公司共用的期間設定，任何主管或老闆都可以新增／調整。各部門的題目請到「考核題目」分頁設定，簽核鏈請到「考核流程」分頁設定。</p>

      {showAdd && (
        <Card className="review-form-card">
          <div className="review-form-grid">
            <input className="ui-field__control" value={newReview.title} onChange={e => setNewReview(p => ({ ...p, title: e.target.value }))} placeholder="週期名稱，例：2026 年度考核" />
            <input className="ui-field__control" type="number" value={newReview.year} onChange={e => setNewReview(p => ({ ...p, year: Number(e.target.value) }))} />
            <label className="review-inline-label">預設模板（找不到部門專屬模板的人會用這份）
              <select className="ui-field__control" value={defaultTemplateId} onChange={e => setDefaultTemplateId(e.target.value)}>
                <option value="">請選擇模板</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}（{t.department || '全公司預設'}）</option>)}
              </select>
            </label>
            <div />
            <label className="review-inline-label">自評期間開始<input className="ui-field__control" type="date" value={newReview.start_date} onChange={e => setNewReview(p => ({ ...p, start_date: e.target.value }))} /></label>
            <label className="review-inline-label">整體結束日<input className="ui-field__control" type="date" value={newReview.end_date} min={newReview.start_date} onChange={e => setNewReview(p => ({ ...p, end_date: e.target.value }))} /></label>
            <label className="review-inline-label">自評截止日<input className="ui-field__control" type="date" value={newReview.self_assessment_deadline} onChange={e => setNewReview(p => ({ ...p, self_assessment_deadline: e.target.value }))} /></label>
            <label className="review-inline-label">評分截止日<input className="ui-field__control" type="date" value={newReview.evaluation_deadline} onChange={e => setNewReview(p => ({ ...p, evaluation_deadline: e.target.value }))} /></label>
          </div>
          <div className="review-form-actions">
            <Button size="sm" onClick={handleAddReview}>新增</Button>
            <Button size="sm" variant="text" onClick={() => setShowAdd(false)}>取消</Button>
          </div>
        </Card>
      )}

      <div className="review-list">
        {reviews.map(r => (
          <Card key={r.id}>
            <div className="review-row">
              <div>
                <div className="review-row__title">{r.title}</div>
                <div className="review-row__meta">{r.year} 年度｜{r.start_date} ～ {r.end_date}</div>
                {(r.self_assessment_deadline || r.evaluation_deadline) && (
                  <div className="review-row__sub">
                    {r.self_assessment_deadline && `自評截止：${r.self_assessment_deadline}`}
                    {r.self_assessment_deadline && r.evaluation_deadline && '｜'}
                    {r.evaluation_deadline && `評分截止：${r.evaluation_deadline}`}
                  </div>
                )}
              </div>
              <div className="review-row__actions">
                <Chip tone={r.status === 'active' ? 'success' : 'neutral'}>{r.status === 'active' ? '進行中' : '已結束'}</Chip>
                <Button size="sm" variant="outlined" onClick={() => handleToggleReviewStatus(r)}>
                  {r.status === 'active' ? '結束週期' : '重新開放'}
                </Button>
                <Button size="sm" variant="outlined" onClick={() => openEdit(r)}>編輯</Button>
                <Button size="sm" variant="danger-outlined" onClick={() => setConfirmDeleteReview(r)}>刪除</Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {editingReview && (
        <Dialog
          title="編輯考核週期"
          labelledBy="edit-review-dialog-title"
          onClose={() => setEditingReview(null)}
          actions={(
            <>
              <Button variant="text" onClick={() => setEditingReview(null)}>取消</Button>
              <Button loading={saving} onClick={handleSaveEdit}>儲存</Button>
            </>
          )}
        >
          <div className="review-form-grid">
            <input className="ui-field__control" value={editingReview.title} onChange={e => setEditingReview(p => ({ ...p, title: e.target.value }))} placeholder="週期名稱" />
            <input className="ui-field__control" type="number" value={editingReview.year} onChange={e => setEditingReview(p => ({ ...p, year: Number(e.target.value) }))} />
            <label className="review-inline-label">預設模板
              <select className="ui-field__control" value={editingReview.template_id} onChange={e => setEditingReview(p => ({ ...p, template_id: e.target.value }))}>
                <option value="">請選擇模板</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}（{t.department || '全公司預設'}）</option>)}
              </select>
            </label>
            <div />
            <label className="review-inline-label">自評期間開始<input className="ui-field__control" type="date" value={editingReview.start_date} onChange={e => setEditingReview(p => ({ ...p, start_date: e.target.value }))} /></label>
            <label className="review-inline-label">整體結束日<input className="ui-field__control" type="date" value={editingReview.end_date} min={editingReview.start_date} onChange={e => setEditingReview(p => ({ ...p, end_date: e.target.value }))} /></label>
            <label className="review-inline-label">自評截止日<input className="ui-field__control" type="date" value={editingReview.self_assessment_deadline} onChange={e => setEditingReview(p => ({ ...p, self_assessment_deadline: e.target.value }))} /></label>
            <label className="review-inline-label">評分截止日<input className="ui-field__control" type="date" value={editingReview.evaluation_deadline} onChange={e => setEditingReview(p => ({ ...p, evaluation_deadline: e.target.value }))} /></label>
          </div>
        </Dialog>
      )}

      {confirmDeleteReview && (
        <ConfirmDialog
          title="刪除考核週期"
          description={`確定要刪除「${confirmDeleteReview.title}」嗎？如果已經有員工被加入這個週期的考核，會刪除失敗，請改用「結束週期」。此操作無法復原。`}
          confirmLabel="刪除"
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
    if (!newTemplate.name) { showToast('請填寫模板名稱', { tone: 'error' }); return }
    if (!isBoss && !userProfile.department) {
      showToast('您的帳號尚未設定部門，請聯繫管理員在「員工帳號管理」補上部門資料', { tone: 'error' }); return
    }
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('review_templates').insert({
      name: newTemplate.name,
      description: newTemplate.description,
      department: isBoss ? (newTemplate.department || null) : userProfile.department,
      created_by: user.id,
    })
    if (error) { showToast('新增失敗：' + error.message, { tone: 'error' }); return }
    setNewTemplate({ name: '', description: '', department: isBoss ? '' : (userProfile.department || '') })
    setShowAdd(false)
    fetchAll()
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
    if (!newQuestion.question_text) { showToast('請填寫題目內容', { tone: 'error' }); return }
    const { error } = await supabase.from('review_template_questions').insert({
      question_text: newQuestion.question_text,
      question_type: newQuestion.question_type,
      score_min: newQuestion.question_type === 'score' ? 1 : null,
      score_max: newQuestion.question_type === 'score' ? 10 : null,
      template_id: editTemplate.id,
      order_index: questions.length,
    })
    if (error) { showToast('新增失敗：' + error.message, { tone: 'error' }); return }
    setNewQuestion({ question_text: '', question_type: 'score' })
    fetchTemplateQuestions(editTemplate.id)
  }

  async function handleDeleteQuestion(id) {
    const { error } = await supabase.from('review_template_questions').delete().eq('id', id)
    if (error) { showToast('刪除失敗：' + error.message, { tone: 'error' }); return }
    fetchTemplateQuestions(editTemplate.id)
  }

  function openEditMeta(t) {
    setEditingMeta({ id: t.id, name: t.name, description: t.description || '', department: t.department || '' })
  }

  async function handleSaveMeta() {
    if (!editingMeta.name) { showToast('請填寫模板名稱', { tone: 'error' }); return }
    setSaving(true)
    const { data: updated, error } = await supabase.from('review_templates').update({
      name: editingMeta.name,
      description: editingMeta.description || null,
      department: isBoss ? (editingMeta.department || null) : userProfile.department,
    }).eq('id', editingMeta.id).select()
    setSaving(false)
    if (error || !updated?.length) {
      showToast('儲存失敗：' + (error?.message || '沒有權限寫入'), { tone: 'error' }); return
    }
    setEditingMeta(null)
    showToast('已更新模板')
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
      showToast('刪除失敗：這個模板還被某個考核週期設為預設模板，請先到「考核週期」更換預設模板再刪除。', { tone: 'error' })
      setConfirmDeleteTemplate(null)
      return
    }
    showToast('已刪除模板')
    setConfirmDeleteTemplate(null)
    fetchAll()
  }

  if (loading) return <Skeleton height="120px" />

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">{isBoss ? '各部門考核題目' : `${userProfile.department || '我的部門'} 考核題目`}</h4>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>+ 新增模板</Button>
      </div>
      <p className="review-hint">
        每個模板對應一個部門；分數題固定 1-10 分（作答時可額外寫下打分的相關事例／理由），詳答題沒有字數限制。department 留空＝全公司預設，找不到部門專屬模板的人會使用這份。
      </p>

      {showAdd && (
        <Card className="review-form-card">
          <div className="review-form-grid review-form-grid--single">
            <input className="ui-field__control" value={newTemplate.name} onChange={e => setNewTemplate(p => ({ ...p, name: e.target.value }))} placeholder="模板名稱，例：業務部 2026 考核" />
            <input className="ui-field__control" value={newTemplate.description} onChange={e => setNewTemplate(p => ({ ...p, description: e.target.value }))} placeholder="說明（選填）" />
            {isBoss ? (
              <select className="ui-field__control" value={newTemplate.department} onChange={e => setNewTemplate(p => ({ ...p, department: e.target.value }))}>
                <option value="">全公司預設（無特定部門）</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            ) : (
              <div className="review-hint">將建立在您的部門：{userProfile.department || '（尚未設定，請聯繫管理員）'}</div>
            )}
          </div>
          <div className="review-form-actions">
            <Button size="sm" onClick={handleAddTemplate}>新增</Button>
            <Button size="sm" variant="text" onClick={() => setShowAdd(false)}>取消</Button>
          </div>
        </Card>
      )}

      {templates.length === 0 ? (
        <Card><EmptyState title="尚無考核模板" description={isBoss ? '請先新增模板' : '請先新增您部門的考核模板'} /></Card>
      ) : (
        <div className="review-list">
          {templates.map(t => (
            <Card key={t.id}>
              <div className="review-row">
                <div>
                  <div className="review-row__title">{t.name}</div>
                  <div className="review-row__meta">{t.department || '全公司預設'}{t.description ? `｜${t.description}` : ''}</div>
                </div>
                <div className="review-row__actions">
                  <Button size="sm" variant="outlined" onClick={() => { setEditTemplate(t); fetchTemplateQuestions(t.id) }}>設定題目</Button>
                  <Button size="sm" variant="outlined" onClick={() => openEditMeta(t)}>編輯</Button>
                  <Button size="sm" variant="danger-outlined" onClick={() => setConfirmDeleteTemplate(t)}>刪除</Button>
                </div>
              </div>

              {editTemplate?.id === t.id && (
                <div className="review-questions-editor">
                  {questions.map((q, i) => (
                    <div key={q.id} className="review-questions-editor__row">
                      <span>{i + 1}. {q.question_text}</span>
                      <Chip tone={q.question_type === 'score' ? 'info' : 'neutral'}>
                        {q.question_type === 'score' ? `分數題 ${q.score_min}-${q.score_max}` : '詳答題'}
                      </Chip>
                      <Button size="sm" variant="danger-outlined" onClick={() => handleDeleteQuestion(q.id)}>刪除</Button>
                    </div>
                  ))}
                  <Card className="review-form-card">
                    <div className="review-form-grid review-form-grid--single">
                      <input className="ui-field__control" value={newQuestion.question_text} onChange={e => setNewQuestion(p => ({ ...p, question_text: e.target.value }))} placeholder="題目內容" />
                      <select className="ui-field__control" value={newQuestion.question_type} onChange={e => setNewQuestion(p => ({ ...p, question_type: e.target.value }))}>
                        <option value="score">分數題（1-10 分）</option>
                        <option value="text">詳答題（無字數限制）</option>
                      </select>
                    </div>
                    <div className="review-form-actions">
                      <Button size="sm" onClick={handleAddQuestion}>新增題目</Button>
                      <Button size="sm" variant="text" onClick={() => setEditTemplate(null)}>完成</Button>
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
          title="編輯模板"
          labelledBy="edit-template-dialog-title"
          onClose={() => setEditingMeta(null)}
          actions={(
            <>
              <Button variant="text" onClick={() => setEditingMeta(null)}>取消</Button>
              <Button loading={saving} onClick={handleSaveMeta}>儲存</Button>
            </>
          )}
        >
          <div className="review-form-grid review-form-grid--single">
            <input className="ui-field__control" value={editingMeta.name} onChange={e => setEditingMeta(p => ({ ...p, name: e.target.value }))} placeholder="模板名稱" />
            <input className="ui-field__control" value={editingMeta.description} onChange={e => setEditingMeta(p => ({ ...p, description: e.target.value }))} placeholder="說明（選填）" />
            {isBoss ? (
              <select className="ui-field__control" value={editingMeta.department} onChange={e => setEditingMeta(p => ({ ...p, department: e.target.value }))}>
                <option value="">全公司預設（無特定部門）</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            ) : (
              <div className="review-hint">部門：{userProfile.department || '（尚未設定，請聯繫管理員）'}</div>
            )}
          </div>
        </Dialog>
      )}

      {confirmDeleteTemplate && (
        <ConfirmDialog
          title="刪除模板"
          description={`確定要刪除「${confirmDeleteTemplate.name}」嗎？裡面的所有題目也會一起刪除。如果這個模板還被某個考核週期設為預設模板，會刪除失敗。此操作無法復原。`}
          confirmLabel="刪除"
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
    if (!newFlow.name) { showToast('請填寫流程名稱', { tone: 'error' }); return }
    if (!isBoss && !userProfile.department) {
      showToast('您的帳號尚未設定部門，請聯繫管理員在「員工帳號管理」補上部門資料', { tone: 'error' }); return
    }
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('review_flows').insert({
      name: newFlow.name,
      department: isBoss ? (newFlow.department || null) : userProfile.department,
      created_by: user.id,
    })
    if (error) { showToast('新增失敗：' + error.message, { tone: 'error' }); return }
    setNewFlow({ name: '', department: isBoss ? '' : (userProfile.department || '') })
    setShowAdd(false)
    fetchAll()
  }

  async function handleSaveSteps(flowId) {
    const validSteps = steps.filter(s => s.evaluator_id)
    if (validSteps.length === 0) { showToast('請至少指定一位評核人', { tone: 'error' }); return }
    const { error: delError } = await supabase.from('review_flow_steps').delete().eq('flow_id', flowId)
    if (delError) { showToast('儲存失敗：' + delError.message, { tone: 'error' }); return }
    const { error: insError } = await supabase.from('review_flow_steps').insert(
      validSteps.map((step, i) => ({ flow_id: flowId, step_order: i + 1, evaluator_id: step.evaluator_id }))
    )
    if (insError) { showToast('儲存失敗：' + insError.message, { tone: 'error' }); return }
    setEditSteps(null)
    fetchAll()
  }

  async function handleDeleteFlow(flowId) {
    const { error } = await supabase.from('review_flows').delete().eq('id', flowId)
    if (error) { showToast('此流程已有考核參與者使用，無法刪除。', { tone: 'error' }); return }
    fetchAll()
  }

  if (loading) return <Skeleton height="120px" />

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">{isBoss ? '各部門考核流程' : `${userProfile.department || '我的部門'} 考核流程`}</h4>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>+ 新增流程</Button>
      </div>
      <p className="review-hint">
        考核流程是這個部門的員工送出自評後，會依序經過的評分關卡，可以指定任何一位員工（不限主管／老闆），跟請假的審核流程一樣可以自訂關卡數量與順序。department 留空＝全公司預設。
      </p>

      {showAdd && (
        <Card className="review-form-card">
          <div className="review-form-grid review-form-grid--single">
            <input className="ui-field__control" value={newFlow.name} onChange={e => setNewFlow(p => ({ ...p, name: e.target.value }))} placeholder="流程名稱，例：業務部考核流程" />
            {isBoss ? (
              <select className="ui-field__control" value={newFlow.department} onChange={e => setNewFlow(p => ({ ...p, department: e.target.value }))}>
                <option value="">全公司預設（無特定部門）</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            ) : (
              <div className="review-hint">將建立在您的部門：{userProfile.department || '（尚未設定，請聯繫管理員）'}</div>
            )}
          </div>
          <div className="review-form-actions">
            <Button size="sm" onClick={handleAddFlow}>新增</Button>
            <Button size="sm" variant="text" onClick={() => setShowAdd(false)}>取消</Button>
          </div>
        </Card>
      )}

      {flows.length === 0 ? (
        <Card><EmptyState title="尚無考核流程" description={isBoss ? '請先新增流程' : '請先新增您部門的考核流程'} /></Card>
      ) : (
        <div className="review-list">
          {flows.map(f => (
            <Card key={f.id}>
              <div className="review-row">
                <div>
                  <div className="review-row__title">{f.name}</div>
                  <div className="review-row__meta">{f.department || '全公司預設'}</div>
                  {editSteps !== f.id && <FlowSteps flow={f} />}
                </div>
                <div className="review-row__actions">
                  <Button size="sm" variant="outlined" onClick={() => {
                    setEditSteps(f.id)
                    setSteps(f.steps?.sort((a, b) => a.step_order - b.step_order).map(s => ({ evaluator_id: s.evaluator_id })) || [{ evaluator_id: '' }])
                  }}>設定關卡</Button>
                  <Button size="sm" variant="danger-outlined" onClick={() => handleDeleteFlow(f.id)}>刪除</Button>
                </div>
              </div>

              {editSteps === f.id && (
                <div className="review-questions-editor">
                  {steps.map((step, i) => (
                    <div key={i} className="review-questions-editor__row">
                      <span>第 {i + 1} 關</span>
                      <select className="ui-field__control" style={{ flex: 1 }} value={step.evaluator_id} onChange={e => {
                        const updated = [...steps]; updated[i] = { evaluator_id: e.target.value }; setSteps(updated)
                      }}>
                        <option value="">請選擇評核人</option>
                        {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                      </select>
                      <Button size="sm" variant="danger-outlined" onClick={() => setSteps(steps.filter((_, idx) => idx !== i))}>刪除</Button>
                    </div>
                  ))}
                  <div className="review-form-actions">
                    <Button size="sm" variant="outlined" onClick={() => setSteps([...steps, { evaluator_id: '' }])}>+ 新增關卡</Button>
                    <Button size="sm" onClick={() => handleSaveSteps(f.id)}>儲存</Button>
                    <Button size="sm" variant="text" onClick={() => setEditSteps(null)}>取消</Button>
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
    if (candidates.length === 0) { showToast('請先勾選要加入的人員', { tone: 'error' }); return }

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
      showToast(`${missingFlow.join('、')} 所屬部門尚未設定考核流程，請先到「考核流程」分頁建立，這些人先不會加入`, { tone: 'error' })
    }
    if (rows.length === 0) return

    const { error } = await supabase.from('annual_review_participants').insert(rows)
    if (error) { showToast('加入失敗：' + error.message, { tone: 'error' }); return }
    showToast(`已加入 ${rows.length} 位參與者`)
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
    if (error) { showToast('設定失敗：' + error.message, { tone: 'error' }); return }
    fetchParticipants()
  }

  if (loading) return <Skeleton height="120px" />

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">加入考核參與者</h4>
      </div>
      <p className="review-hint">{isBoss ? '可加入全公司任何人員。' : `只能加入您部門（${userProfile.department || '尚未設定部門'}）的員工。`}加入時會自動套用該員工部門設定好的考核流程；若部門尚未設定流程，需先到「考核流程」分頁建立。</p>

      <Card className="review-form-card">
        <select className="ui-field__control" value={selectedReviewId} onChange={e => setSelectedReviewId(e.target.value)} style={{ marginBottom: 'var(--space-150)' }}>
          <option value="">請選擇考核週期</option>
          {reviews.map(r => <option key={r.id} value={r.id}>{r.title}（{r.year}）</option>)}
        </select>

        {selectedReviewId && (
          <>
            <div className="review-manual-picker">
              {users.filter(u => !existingUserIds.has(u.id)).map(u => (
                <label key={u.id} className="review-checkbox">
                  <input
                    type="checkbox"
                    checked={manualSelection.includes(u.id)}
                    onChange={e => setManualSelection(prev => e.target.checked ? [...prev, u.id] : prev.filter(id => id !== u.id))}
                  />
                  {u.full_name}
                </label>
              ))}
              {users.filter(u => !existingUserIds.has(u.id)).length === 0 && (
                <p className="review-hint">沒有可加入的人員了。</p>
              )}
            </div>
            <Button onClick={handleAdd} disabled={candidates.length === 0}>加入 {candidates.length > 0 ? `（${candidates.length} 人）` : ''}</Button>
          </>
        )}
      </Card>

      {selectedReviewId && participants.length > 0 && (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr><th>姓名</th><th>直屬主管</th><th>操作</th></tr>
            </thead>
            <tbody>
              {participants.map(p => (
                <tr key={p.id}>
                  <td>{p.user?.full_name}</td>
                  <td>
                    <select className="ui-field__control" value={p.supervisor_id || ''} onChange={e => handleChangeSupervisor(p.id, e.target.value)}>
                      <option value="">未指定</option>
                      {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                    </select>
                    {!p.supervisor_id && <div className="review-missing-manager">⚠ 未指定，也可以到「員工帳號管理」設定這個人的直屬主管</div>}
                  </td>
                  <td><Button size="sm" variant="danger-outlined" onClick={() => handleRemove(p.id)}>移除</Button></td>
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

  const tabs = [
    { key: 'cycles', label: '考核週期', to: '/review/setup', active: location.pathname === '/review/setup' },
    { key: 'questions', label: '考核題目', to: '/review/setup/questions', active: location.pathname === '/review/setup/questions' },
    { key: 'flows', label: '考核流程', to: '/review/setup/flows', active: location.pathname === '/review/setup/flows' },
    { key: 'participants', label: '參與者', to: '/review/setup/participants', active: location.pathname === '/review/setup/participants' },
  ]

  return (
    <div>
      <PageHeader title="部門考核設定" />
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
  const isBoss = userProfile?.role === 'boss'
  const isTeamManager = EVALUATOR_ROLES.includes(userProfile?.role)
  const canSelfAssess = userProfile?.role !== 'boss'

  // 一般員工（不是主管／老闆）：不需要額外的「考核管理」外層分頁，
  // 員工資訊卡＋年度自評／過往考核紀錄本身就是整個頁面。
  if (canSelfAssess && !isTeamManager) {
    return <EmployeeReviewSection userProfile={userProfile} />
  }

  const tabs = []
  if (canSelfAssess) tabs.push({ key: 'mine', path: '/review', label: '年度自評', end: true })
  if (isTeamManager) {
    tabs.push({ key: 'setup', path: '/review/setup', label: '部門考核設定' })
    tabs.push({ key: 'team', path: '/review/team', label: isBoss ? '團隊管理' : '團隊管理與年度考核' })
  }
  // Was "/review/team/annual" -- a sibling page nested under the same URL
  // segment as "/review/team" (團隊管理), so a plain startsWith() prefix
  // match marked BOTH tabs active whenever viewing 團隊年度考核 (its path
  // literally starts with the other tab's path). Hyphenated instead of
  // nested so the two can never collide as prefixes of each other.
  if (isBoss) tabs.push({ key: 'team-annual', path: '/review/team-annual', label: '團隊年度考核' })

  return (
    <div>
      <PageHeader title="考核管理" />
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
        {isBoss && <Route path="team-annual" element={<CompanyReviewRoster />} />}
        <Route path="*" element={<Navigate to="/review" replace />} />
      </Routes>
    </div>
  )
}

export default Review
