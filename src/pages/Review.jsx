import { useState, useEffect } from 'react'
import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  Button, Card, Chip, EmptyState, PageHeader, Skeleton, Tabs, Textarea,
} from '../components/ui'
import { useToast } from '../context/ToastContext'
import './Review.css'

const EVALUATOR_ROLES = ['supervisor', 'deputy_supervisor', 'boss']

// Questions are scoped by department, not by role. A department without its
// own template falls back to the cycle's default template_id (used for the
// 全公司 default, department = NULL).
async function resolveTemplateId(review, department) {
  if (department) {
    const { data } = await supabase.from('review_templates').select('id').eq('department', department).limit(1)
    if (data && data.length > 0) return data[0].id
  }
  return review?.template_id ?? null
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
    responseMap[r.question_id] = r.question_type === 'score' ? r.score_answer : r.text_answer
  }
  return { questions: qs || [], responses: responseMap }
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

// ===== 年度自評 =====
function MyAssessment({ userProfile }) {
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [questions, setQuestions] = useState([])
  const [responses, setResponses] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const { showToast } = useToast()

  useEffect(() => { fetchMyReviews() }, [])

  async function fetchMyReviews() {
    const { data } = await supabase
      .from('annual_review_participants')
      .select(`*, review:annual_reviews(*)`)
      .eq('user_id', userProfile.id)
      .eq('supervisor_submitted', false)
      .order('id', { ascending: false })
    setReviews(data || [])
    setLoading(false)
  }

  async function handleSelectForAssessment(participant) {
    setSelected(participant)
    const templateId = await resolveTemplateId(participant.review, userProfile.department)
    const { questions: qs, responses: rs } = await fetchQuestionsAndResponses(templateId, participant.id)
    setQuestions(qs)
    setResponses(rs)
  }

  async function handleSaveDraft() {
    setSubmitting(true)
    for (const q of questions) {
      if (responses[q.id] === undefined || responses[q.id] === '') continue
      await supabase.from('review_responses').upsert({
        review_id: selected.review_id,
        participant_id: selected.id,
        question_id: q.id,
        text_answer: q.question_type === 'text' ? String(responses[q.id]) : null,
        score_answer: q.question_type === 'score' ? Number(responses[q.id]) : null,
        updated_at: new Date().toISOString()
      }, { onConflict: 'participant_id,question_id' })
    }
    setSubmitting(false)
    showToast('草稿已儲存')
  }

  async function handleSubmitSelfAssessment() {
    for (const q of questions) {
      if (!responses[q.id] && responses[q.id] !== 0) {
        showToast(`請填寫所有題目：「${q.question_text}」未填寫`, { tone: 'error' })
        return
      }
    }

    setSubmitting(true)

    for (const q of questions) {
      await supabase.from('review_responses').upsert({
        review_id: selected.review_id,
        participant_id: selected.id,
        question_id: q.id,
        text_answer: q.question_type === 'text' ? String(responses[q.id]) : null,
        score_answer: q.question_type === 'score' ? Number(responses[q.id]) : null,
        updated_at: new Date().toISOString()
      }, { onConflict: 'participant_id,question_id' })
    }

    await supabase.from('annual_review_participants')
      .update({ self_submitted: true, self_submitted_at: new Date().toISOString() })
      .eq('id', selected.id)

    setSubmitting(false)
    showToast('自評已送出！')
    setSelected(null)
    fetchMyReviews()
  }

  function statusFor(p) {
    if (!p.self_submitted) return { label: '待填寫自評', tone: 'warning' }
    return { label: '自評已完成，待主管評分', tone: 'warning' }
  }

  if (loading) return <div><PageHeader title="年度自評" /><Skeleton height="80px" /></div>

  const active = reviews.filter(p => p.review?.status === 'active')

  return (
    <div>
      <PageHeader title="年度自評" />

      {active.length === 0 ? (
        <Card><EmptyState title="非考核期間" description="目前沒有進行中的年度考核。" /></Card>
      ) : (
        <div className="review-list">
          {active.map(p => {
            const status = statusFor(p)
            return (
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
                    <Chip tone={status.tone}>{status.label}</Chip>
                    {!p.self_submitted && (
                      <Button size="sm" onClick={() => handleSelectForAssessment(p)}>開始自評</Button>
                    )}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {selected && !selected.self_submitted && (
        <Card className="review-panel">
          <div className="review-panel__header">
            <h4 className="review-panel__title">填寫自評 — {selected.review?.title}</h4>
            <Button variant="text" onClick={() => setSelected(null)}>取消</Button>
          </div>
          {questions.length === 0 ? (
            <p className="review-hint">這個部門目前沒有設定考核題目，請先請主管或老闆到「部門考核設定」新增題目。</p>
          ) : questions.map((q, i) => (
            <div key={q.id} className="review-question">
              <label className="review-question__label">{i + 1}. {q.question_text} <span className="review-required">*</span></label>
              {q.question_type === 'text' ? (
                <Textarea value={responses[q.id] || ''} onChange={e => setResponses(p => ({ ...p, [q.id]: e.target.value }))} rows={4} placeholder="請填寫..." />
              ) : (
                <ScoreButtons min={q.score_min} max={q.score_max} value={responses[q.id]} onChange={v => setResponses(p => ({ ...p, [q.id]: v }))} />
              )}
            </div>
          ))}
          {questions.length > 0 && (
            <div className="review-form-actions">
              <Button variant="outlined" loading={submitting} onClick={handleSaveDraft}>儲存草稿</Button>
              <Button loading={submitting} onClick={handleSubmitSelfAssessment}>提交自評</Button>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

// ===== 考核結果（過往已完成的考核） =====
function MyReviewResults({ userProfile }) {
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [questions, setQuestions] = useState([])
  const [responses, setResponses] = useState({})
  const [evaluations, setEvaluations] = useState([])

  useEffect(() => { fetchMyReviews() }, [])

  async function fetchMyReviews() {
    const { data } = await supabase
      .from('annual_review_participants')
      .select(`
        *,
        review:annual_reviews(*),
        supervisor:users!annual_review_participants_supervisor_id_fkey(full_name)
      `)
      .eq('user_id', userProfile.id)
      .eq('supervisor_submitted', true)
      .order('supervisor_submitted_at', { ascending: false })

    const rows = data || []
    if (rows.length > 0) {
      const { data: overalls } = await supabase
        .from('review_evaluations')
        .select('participant_id, overall_score')
        .in('participant_id', rows.map(p => p.id))
        .eq('is_overall', true)
      const scoreMap = {}
      for (const o of overalls || []) scoreMap[o.participant_id] = o.overall_score
      for (const p of rows) p._overallScore = scoreMap[p.id]
    }
    setReviews(rows)
    setLoading(false)
  }

  async function handleViewResult(participant) {
    setSelected(participant)
    const templateId = await resolveTemplateId(participant.review, userProfile.department)
    const { questions: qs, responses: rs } = await fetchQuestionsAndResponses(templateId, participant.id)
    setQuestions(qs)
    setResponses(rs)
    const { data } = await supabase
      .from('review_evaluations')
      .select('*, evaluator:users!review_evaluations_evaluator_id_fkey(full_name)')
      .eq('participant_id', participant.id)
    setEvaluations(data || [])
  }

  if (loading) return <div><PageHeader title="考核結果" /><Skeleton height="80px" /></div>

  return (
    <div>
      <PageHeader title="考核結果" />

      {reviews.length === 0 ? (
        <Card><EmptyState title="尚無過往考核結果" /></Card>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr><th>考核年度</th><th>總分</th><th>評核主管</th><th>操作</th></tr>
            </thead>
            <tbody>
              {reviews.map(p => (
                <tr key={p.id}>
                  <td>{p.review?.year} 年度｜{p.review?.title}</td>
                  <td>{p._overallScore ?? '—'}</td>
                  <td>{p.supervisor?.full_name || '未指定'}</td>
                  <td><Button size="sm" variant="outlined" onClick={() => handleViewResult(p)}>查看詳情</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <Card className="review-panel">
          <div className="review-panel__header">
            <h4 className="review-panel__title">考核結果 — {selected.review?.title}</h4>
            <Button variant="text" onClick={() => setSelected(null)}>關閉</Button>
          </div>
          {questions.map((q, i) => {
            const myResponse = responses[q.id]
            const evalResponse = evaluations.find(e => e.question_id === q.id && !e.is_overall)
            return (
              <div key={q.id} className="review-result-question">
                <div className="review-result-question__title">{i + 1}. {q.question_text}</div>
                <div className="review-result-box">
                  <div className="review-result-box__label">我的自評</div>
                  <div>{myResponse ?? '—'}</div>
                </div>
                {evalResponse && (
                  <div className="review-result-box review-result-box--eval">
                    <div className="review-result-box__label review-result-box__label--eval">{evalResponse.evaluator?.full_name} 的評分</div>
                    <div>{evalResponse.text_answer ?? evalResponse.score_answer ?? '—'}</div>
                  </div>
                )}
              </div>
            )
          })}
          {evaluations.filter(e => e.is_overall).map(e => (
            <div key={e.id} className="review-overall">
              <div className="review-overall__title">{e.evaluator?.full_name} 的總評</div>
              <div className="review-overall__score">總分：<strong>{e.overall_score}</strong> 分</div>
              {e.overall_comment && <div className="review-overall__comment">{e.overall_comment}</div>}
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

// ===== 團隊管理與年度考核（主管：自己部門／老闆：全公司） =====
function TeamReviewManagement({ userProfile, isBoss }) {
  const [participants, setParticipants] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [readOnly, setReadOnly] = useState(false)
  const [questions, setQuestions] = useState([])
  const [responses, setResponses] = useState({})
  const [evalResponses, setEvalResponses] = useState({})
  const [evaluatorNames, setEvaluatorNames] = useState({})
  const [overallScore, setOverallScore] = useState('')
  const [overallComment, setOverallComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { showToast } = useToast()

  useEffect(() => { fetchParticipants() }, [])

  async function fetchParticipants() {
    let query = supabase
      .from('annual_review_participants')
      .select(`
        *,
        review:annual_reviews(*),
        user:users!annual_review_participants_user_id_fkey(full_name, email, role, department)
      `)
      .order('created_at', { ascending: false })
    if (!isBoss) query = query.eq('supervisor_id', userProfile.id)
    const { data } = await query

    const rows = data || []
    if (rows.length > 0) {
      const { data: overalls } = await supabase
        .from('review_evaluations')
        .select('participant_id, overall_score')
        .in('participant_id', rows.map(p => p.id))
        .eq('is_overall', true)
      const scoreMap = {}
      for (const o of overalls || []) scoreMap[o.participant_id] = o.overall_score
      for (const p of rows) p._overallScore = scoreMap[p.id]
    }
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

    const { data: evals } = await supabase
      .from('review_evaluations')
      .select('*, evaluator:users!review_evaluations_evaluator_id_fkey(full_name)')
      .eq('participant_id', participant.id)
    setOverallScore('')
    setOverallComment('')
    const evalMap = {}
    const nameMap = {}
    for (const e of evals || []) {
      if (e.is_overall) {
        setOverallScore(e.overall_score || '')
        setOverallComment(e.overall_comment || '')
      } else if (e.question_id) {
        evalMap[e.question_id] = e.question_type === 'score' ? e.score_answer : e.text_answer
        nameMap[e.question_id] = e.evaluator?.full_name
      }
    }
    setEvalResponses(evalMap)
    setEvaluatorNames(nameMap)
  }

  async function handleSubmit() {
    for (const q of questions) {
      if (!evalResponses[q.id] && evalResponses[q.id] !== 0) {
        showToast(`請填寫所有評分題目：「${q.question_text}」未填寫`, { tone: 'error' })
        return
      }
    }
    if (!overallScore) { showToast('請填寫總評分數', { tone: 'error' }); return }
    if (!overallComment) { showToast('請填寫總評評語', { tone: 'error' }); return }

    setSubmitting(true)

    for (const q of questions) {
      await supabase.from('review_evaluations').upsert({
        review_id: selected.review_id,
        participant_id: selected.id,
        evaluator_id: userProfile.id,
        question_id: q.id,
        text_answer: q.question_type === 'text' ? String(evalResponses[q.id]) : null,
        score_answer: q.question_type === 'score' ? Number(evalResponses[q.id]) : null,
        is_overall: false,
        updated_at: new Date().toISOString()
      }, { onConflict: 'participant_id,question_id' })
    }

    await supabase.from('review_evaluations').upsert({
      review_id: selected.review_id,
      participant_id: selected.id,
      evaluator_id: userProfile.id,
      is_overall: true,
      overall_score: Number(overallScore),
      overall_comment: overallComment,
      updated_at: new Date().toISOString()
    })

    await supabase.from('annual_review_participants')
      .update({ supervisor_submitted: true, supervisor_submitted_at: new Date().toISOString() })
      .eq('id', selected.id)

    setSubmitting(false)
    showToast('評分已送出，員工現在可以查看結果')
    setSelected(null)
    fetchParticipants()
  }

  if (loading) return <div><PageHeader title={isBoss ? '團隊管理' : '團隊管理與年度考核'} /><Skeleton height="80px" /></div>

  const totalCount = participants.length
  const notSelfSubmittedCount = participants.filter(p => !p.self_submitted).length
  const pendingEvalCount = participants.filter(p => p.self_submitted && !p.supervisor_submitted).length

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
          <div className="dash-review-card__tile-label">待評分數量</div>
          <div className="dash-review-card__tile-value">{pendingEvalCount}</div>
        </div>
      </div>

      {participants.length === 0 ? (
        <Card><EmptyState title="目前沒有團隊成員的考核資料" /></Card>
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
                    {isBoss && <Chip tone="neutral">總分：{p._overallScore ?? '—'}</Chip>}
                  </div>
                </div>
                <div className="review-row__actions">
                  <Chip tone={p.supervisor_submitted ? 'success' : p.self_submitted ? 'warning' : 'neutral'}>
                    {p.supervisor_submitted ? '已完成評分' : p.self_submitted ? '待評分' : '待員工自評'}
                  </Chip>
                  {p.supervisor_submitted && (
                    <Button size="sm" variant="outlined" onClick={() => handleSelect(p, true)}>查看結果</Button>
                  )}
                  {!p.supervisor_submitted && p.self_submitted && p.review?.status === 'active' && (
                    <Button size="sm" onClick={() => handleSelect(p, false)}>開始評分</Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {selected && (
        <Card className="review-panel">
          <div className="review-panel__header">
            <h4 className="review-panel__title">{readOnly ? '考核結果' : '評分'} — {selected.user?.full_name}</h4>
            <Button variant="text" onClick={() => setSelected(null)}>{readOnly ? '關閉' : '取消'}</Button>
          </div>

          <fieldset className="review-fieldset" disabled={readOnly}>
            {questions.map((q, i) => (
              <div key={q.id} className="review-question">
                <div className="review-question__title">{i + 1}. {q.question_text}</div>
                <div className="review-result-box">
                  <div className="review-result-box__label">員工自評</div>
                  <div>{responses[q.id] ?? '—'}</div>
                </div>
                {readOnly ? (
                  <div className="review-result-box review-result-box--eval">
                    <div className="review-result-box__label review-result-box__label--eval">{evaluatorNames[q.id] || '評核人'} 的評分</div>
                    <div>{evalResponses[q.id] ?? '—'}</div>
                  </div>
                ) : (
                  <>
                    <label className="review-question__label">我的評分 <span className="review-required">*</span></label>
                    {q.question_type === 'text' ? (
                      <Textarea value={evalResponses[q.id] || ''} onChange={e => setEvalResponses(p => ({ ...p, [q.id]: e.target.value }))} rows={3} placeholder="請填寫評語..." />
                    ) : (
                      <ScoreButtons min={q.score_min} max={q.score_max} value={evalResponses[q.id]} onChange={v => setEvalResponses(p => ({ ...p, [q.id]: v }))} />
                    )}
                  </>
                )}
              </div>
            ))}

            <div className="review-overall-form">
              <h5 className="review-overall-form__title">總評</h5>
              {readOnly ? (
                <>
                  <div className="review-overall__score">總分：<strong>{overallScore || '—'}</strong> 分</div>
                  {overallComment && <div className="review-overall__comment">{overallComment}</div>}
                </>
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

            {!readOnly && (
              <Button block loading={submitting} onClick={handleSubmit}>送出評分</Button>
            )}
          </fieldset>
        </Card>
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

// ===== 部門考核設定：考核週期／考核題目／參與者（主管／老闆專用） =====
function ReviewCycles() {
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newReview, setNewReview] = useState({ title: '', year: new Date().getFullYear(), start_date: '', end_date: '', self_assessment_deadline: '', evaluation_deadline: '' })
  const [defaultTemplateId, setDefaultTemplateId] = useState('')
  const [templates, setTemplates] = useState([])
  const { showToast } = useToast()

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    const [r, t] = await Promise.all([
      supabase.from('annual_reviews').select('*').order('year', { ascending: false }),
      supabase.from('review_templates').select('*').is('department', null).order('created_at', { ascending: false }),
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
      showToast('請先在「考核題目」分頁建立至少一份全公司預設模板', { tone: 'error' }); return
    }
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('annual_reviews').insert({
      title: newReview.title,
      year: newReview.year,
      template_id: defaultTemplateId,
      start_date: newReview.start_date,
      end_date: newReview.end_date,
      self_assessment_deadline: newReview.self_assessment_deadline || null,
      evaluation_deadline: newReview.evaluation_deadline || null,
      created_by: user.id,
    })
    setNewReview({ title: '', year: new Date().getFullYear(), start_date: '', end_date: '', self_assessment_deadline: '', evaluation_deadline: '' })
    setShowAdd(false)
    fetchAll()
    showToast('已新增考核週期')
  }

  async function handleToggleReviewStatus(review) {
    await supabase.from('annual_reviews')
      .update({ status: review.status === 'active' ? 'closed' : 'active' })
      .eq('id', review.id)
    fetchAll()
  }

  if (loading) return <Skeleton height="120px" />

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">年度考核週期</h4>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>+ 新增週期</Button>
      </div>
      <p className="review-hint">考核週期是全公司共用的期間設定，任何主管或老闆都可以新增／調整。各部門的題目請到「考核題目」分頁設定。</p>

      {showAdd && (
        <Card className="review-form-card">
          <div className="review-form-grid">
            <input className="ui-field__control" value={newReview.title} onChange={e => setNewReview(p => ({ ...p, title: e.target.value }))} placeholder="週期名稱，例：2026 年度考核" />
            <input className="ui-field__control" type="number" value={newReview.year} onChange={e => setNewReview(p => ({ ...p, year: Number(e.target.value) }))} />
            <label className="review-inline-label">全公司預設模板
              <select className="ui-field__control" value={defaultTemplateId} onChange={e => setDefaultTemplateId(e.target.value)}>
                <option value="">請選擇模板</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
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
              </div>
            </div>
          </Card>
        ))}
      </div>
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
  const [newQuestion, setNewQuestion] = useState({ question_text: '', question_type: 'score', score_min: 1, score_max: 10 })
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
    await supabase.from('review_templates').insert({
      name: newTemplate.name,
      description: newTemplate.description,
      department: isBoss ? (newTemplate.department || null) : userProfile.department,
      created_by: user.id,
    })
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
    await supabase.from('review_template_questions').insert({
      question_text: newQuestion.question_text,
      question_type: newQuestion.question_type,
      score_min: newQuestion.question_type === 'score' ? 1 : null,
      score_max: newQuestion.question_type === 'score' ? 10 : null,
      template_id: editTemplate.id,
      order_index: questions.length
    })
    setNewQuestion({ question_text: '', question_type: 'score', score_min: 1, score_max: 10 })
    fetchTemplateQuestions(editTemplate.id)
  }

  async function handleDeleteQuestion(id) {
    await supabase.from('review_template_questions').delete().eq('id', id)
    fetchTemplateQuestions(editTemplate.id)
  }

  if (loading) return <Skeleton height="120px" />

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">{isBoss ? '各部門考核題目' : `${userProfile.department || '我的部門'} 考核題目`}</h4>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>+ 新增模板</Button>
      </div>
      <p className="review-hint">
        每個模板對應一個部門；分數題固定 1-10 分，詳答題沒有字數限制。department 留空＝全公司預設，找不到部門專屬模板的人會使用這份。
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
                <Button size="sm" variant="outlined" onClick={() => { setEditTemplate(t); fetchTemplateQuestions(t.id) }}>設定題目</Button>
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
    const rows = candidates.map(u => ({
      review_id: selectedReviewId,
      user_id: u.id,
      supervisor_id: isBoss ? (u.manager_id || null) : userProfile.id,
    }))
    const { error } = await supabase.from('annual_review_participants').insert(rows)
    if (error) { showToast('加入失敗：' + error.message, { tone: 'error' }); return }
    showToast(`已加入 ${candidates.length} 位參與者`)
    setManualSelection([])
    fetchParticipants()
  }

  async function handleRemove(participantId) {
    await supabase.from('annual_review_participants').delete().eq('id', participantId)
    fetchParticipants()
  }

  if (loading) return <Skeleton height="120px" />

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">加入考核參與者</h4>
      </div>
      <p className="review-hint">{isBoss ? '可加入全公司任何人員。' : `只能加入您部門（${userProfile.department || '尚未設定部門'}）的員工，評核人會自動設為您本人。`}</p>

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
              <tr><th>姓名</th><th>評核人</th><th>操作</th></tr>
            </thead>
            <tbody>
              {participants.map(p => (
                <tr key={p.id}>
                  <td>{p.user?.full_name}</td>
                  <td>{p.supervisor?.full_name || <span className="review-missing-manager">⚠ 未指定</span>}</td>
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
    { key: 'participants', label: '參與者', to: '/review/setup/participants', active: location.pathname === '/review/setup/participants' },
  ]

  return (
    <div>
      <PageHeader title="部門考核設定" />
      <Tabs tabs={tabs} />
      <Routes>
        <Route index element={<ReviewCycles />} />
        <Route path="questions" element={<ReviewQuestionSets userProfile={userProfile} isBoss={isBoss} />} />
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

  const tabs = []
  if (canSelfAssess) {
    tabs.push({ key: 'mine', path: '/review', label: '年度自評', end: true })
    tabs.push({ key: 'results', path: '/review/results', label: '考核結果' })
  }
  if (isTeamManager) {
    tabs.push({ key: 'setup', path: '/review/setup', label: '部門考核設定' })
    tabs.push({ key: 'team', path: '/review/team', label: isBoss ? '團隊管理' : '團隊管理與年度考核' })
  }
  if (isBoss) {
    tabs.push({ key: 'team-annual', path: '/review/team/annual', label: '團隊年度考核' })
  }

  return (
    <div>
      <PageHeader title="考核管理" />
      <Tabs tabs={tabs.map(t => ({
        ...t,
        to: t.path,
        active: t.end ? location.pathname === t.path : location.pathname.startsWith(t.path),
      }))} />

      <Routes>
        <Route index element={
          canSelfAssess
            ? <MyAssessment userProfile={userProfile} />
            : <Navigate to="team" replace />
        } />
        {canSelfAssess && <Route path="results" element={<MyReviewResults userProfile={userProfile} />} />}
        {isTeamManager && <Route path="setup/*" element={<DepartmentReviewSetup userProfile={userProfile} isBoss={isBoss} />} />}
        {isTeamManager && <Route path="team" element={<TeamReviewManagement userProfile={userProfile} isBoss={isBoss} />} />}
        {isBoss && <Route path="team/annual" element={<CompanyReviewRoster />} />}
        <Route path="*" element={<Navigate to="/review" replace />} />
      </Routes>
    </div>
  )
}

export default Review
