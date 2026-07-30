import { useState, useEffect } from 'react'
import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  Button, Card, Chip, ConfirmDialog, EmptyState, PageHeader, Skeleton, Tabs, Textarea,
} from '../components/ui'
import { useToast } from '../context/ToastContext'
import './Review.css'

const EVALUATOR_ROLES = ['supervisor', 'deputy_supervisor', 'admin', 'boss']

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

// ===== B18: 我的考核（自評／查看結果） =====
function MyReview({ userProfile }) {
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [questions, setQuestions] = useState([])
  const [responses, setResponses] = useState({})
  const [evaluations, setEvaluations] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [disputeOpen, setDisputeOpen] = useState(false)
  const [disputeText, setDisputeText] = useState('')
  const { showToast } = useToast()

  useEffect(() => { fetchMyReviews() }, [])

  async function fetchMyReviews() {
    const { data } = await supabase
      .from('annual_review_participants')
      .select(`
        *,
        review:annual_reviews(*, template:review_templates(name)),
        supervisor:users!annual_review_participants_supervisor_id_fkey(full_name)
      `)
      .eq('user_id', userProfile.id)
      .order('id', { ascending: false })
    setReviews(data || [])
    setLoading(false)
  }

  async function fetchQuestions(templateId, participantId) {
    const { data: qs } = await supabase
      .from('review_template_questions')
      .select('*')
      .eq('template_id', templateId)
      .order('order_index')

    const { data: rs } = await supabase
      .from('review_responses')
      .select('*')
      .eq('participant_id', participantId)

    setQuestions(qs || [])
    const responseMap = {}
    for (const r of rs || []) {
      responseMap[r.question_id] = r.question_type === 'score' ? r.score_answer : r.text_answer
    }
    setResponses(responseMap)
  }

  async function handleSelectForAssessment(participant) {
    setSelected(participant)
    await fetchQuestions(participant.review.template_id, participant.id)
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

  async function handleViewResult(participant) {
    setSelected(participant)
    await fetchQuestions(participant.review.template_id, participant.id)
    const { data } = await supabase
      .from('review_evaluations')
      .select('*, evaluator:users!review_evaluations_evaluator_id_fkey(full_name, role)')
      .eq('participant_id', participant.id)
    setEvaluations(data || [])
  }

  async function handleAcknowledge() {
    await supabase.from('annual_review_participants')
      .update({ acknowledged_at: new Date().toISOString() })
      .eq('id', selected.id)
    showToast('已確認閱讀')
    setSelected(p => ({ ...p, acknowledged_at: new Date().toISOString() }))
    fetchMyReviews()
  }

  async function handleSubmitDispute() {
    if (!disputeText.trim()) { showToast('請填寫疑義說明', { tone: 'error' }); return }
    await supabase.from('annual_review_participants')
      .update({ has_dispute: true, dispute_comment: disputeText.trim() })
      .eq('id', selected.id)
    showToast('已標記疑義並通知 HR')
    setDisputeOpen(false)
    setDisputeText('')
    setSelected(p => ({ ...p, has_dispute: true, dispute_comment: disputeText.trim() }))
    fetchMyReviews()
  }

  function statusFor(p) {
    if (!p.self_submitted) return { label: '待填寫自評', tone: 'warning' }
    if (!p.supervisor_submitted) return { label: '自評已完成，待主管評核', tone: 'warning' }
    if (!p.published_at) return { label: '評核中，待人資校準', tone: 'warning' }
    if (!p.acknowledged_at) return { label: '結果已發佈，待確認閱讀', tone: 'info' }
    return { label: '已完成', tone: 'success' }
  }

  if (loading) return <div><PageHeader title="我的考核" /><Skeleton height="80px" /></div>

  return (
    <div>
      <PageHeader title="我的考核" />

      {reviews.length === 0 ? (
        <Card><EmptyState title="目前沒有考核任務" /></Card>
      ) : (
        <div className="review-list">
          {reviews.map(p => {
            const status = statusFor(p)
            return (
              <Card key={p.id}>
                <div className="review-row">
                  <div>
                    <div className="review-row__title">{p.review?.title}</div>
                    <div className="review-row__meta">{p.review?.year} 年度｜{p.review?.start_date} ～ {p.review?.end_date}</div>
                    <div className="review-row__sub">主管：{p.supervisor?.full_name || '未指定'}</div>
                  </div>
                  <div className="review-row__actions">
                    <Chip tone={status.tone}>{status.label}</Chip>
                    {!p.self_submitted && p.review?.status === 'active' && (
                      <Button size="sm" onClick={() => handleSelectForAssessment(p)}>填寫自評</Button>
                    )}
                    {p.published_at && (
                      <Button size="sm" variant="outlined" onClick={() => handleViewResult(p)}>查看結果</Button>
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
          {questions.map((q, i) => (
            <div key={q.id} className="review-question">
              <label className="review-question__label">{i + 1}. {q.question_text} <span className="review-required">*</span></label>
              {q.question_type === 'text' ? (
                <Textarea value={responses[q.id] || ''} onChange={e => setResponses(p => ({ ...p, [q.id]: e.target.value }))} rows={4} placeholder="請填寫..." />
              ) : (
                <ScoreButtons min={q.score_min} max={q.score_max} value={responses[q.id]} onChange={v => setResponses(p => ({ ...p, [q.id]: v }))} />
              )}
            </div>
          ))}
          <Button block loading={submitting} onClick={handleSubmitSelfAssessment}>送出自評</Button>
        </Card>
      )}

      {selected && selected.published_at && (
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
                    <div className="review-result-box__label review-result-box__label--eval">{evalResponse.evaluator?.full_name} 的評量</div>
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

          <div className="review-ack-row">
            {selected.acknowledged_at ? (
              <Chip tone="success">已於 {new Date(selected.acknowledged_at).toLocaleString('zh-TW')} 確認</Chip>
            ) : (
              <Button onClick={handleAcknowledge}>確認已閱讀</Button>
            )}
            {selected.has_dispute ? (
              <Chip tone="error">已標記疑義，處理中</Chip>
            ) : (
              <Button variant="text" onClick={() => setDisputeOpen(true)}>對此結果有疑義</Button>
            )}
          </div>
        </Card>
      )}

      {disputeOpen && (
        <ConfirmDialog
          title="標記疑義"
          description={(
            <Textarea
              label="請說明疑義內容"
              value={disputeText}
              onChange={e => setDisputeText(e.target.value)}
              rows={3}
              placeholder="請描述您對考核結果的疑義"
            />
          )}
          confirmLabel="送出"
          onConfirm={handleSubmitDispute}
          onCancel={() => { setDisputeOpen(false); setDisputeText('') }}
        />
      )}
    </div>
  )
}

// ===== B19: 評核填寫（主管／老闆） =====
function SupervisorEvaluation({ userProfile }) {
  const [participants, setParticipants] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [questions, setQuestions] = useState([])
  const [responses, setResponses] = useState({})
  const [evalResponses, setEvalResponses] = useState({})
  const [overallScore, setOverallScore] = useState('')
  const [overallComment, setOverallComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { showToast } = useToast()

  useEffect(() => { fetchParticipants() }, [])

  async function fetchParticipants() {
    const { data } = await supabase
      .from('annual_review_participants')
      .select(`
        *,
        review:annual_reviews(*, template:review_templates(name, id)),
        user:users!annual_review_participants_user_id_fkey(full_name, email)
      `)
      .eq('supervisor_id', userProfile.id)
      .order('created_at', { ascending: false })
    setParticipants(data || [])
    setLoading(false)
  }

  async function handleSelect(participant) {
    setSelected(participant)
    const { data: qs } = await supabase
      .from('review_template_questions')
      .select('*')
      .eq('template_id', participant.review.template.id)
      .order('order_index')
    setQuestions(qs || [])

    const { data: rs } = await supabase
      .from('review_responses')
      .select('*')
      .eq('participant_id', participant.id)
    const responseMap = {}
    for (const r of rs || []) {
      responseMap[r.question_id] = r.question_type === 'score' ? r.score_answer : r.text_answer
    }
    setResponses(responseMap)

    const { data: evals } = await supabase
      .from('review_evaluations')
      .select('*')
      .eq('participant_id', participant.id)
      .eq('evaluator_id', userProfile.id)
    setOverallScore('')
    setOverallComment('')
    const evalMap = {}
    for (const e of evals || []) {
      if (e.is_overall) {
        setOverallScore(e.overall_score || '')
        setOverallComment(e.overall_comment || '')
      } else if (e.question_id) {
        evalMap[e.question_id] = e.question_type === 'score' ? e.score_answer : e.text_answer
      }
    }
    setEvalResponses(evalMap)
  }

  async function handleSubmit() {
    for (const q of questions) {
      if (!evalResponses[q.id] && evalResponses[q.id] !== 0) {
        showToast(`請填寫所有評量題目：「${q.question_text}」未填寫`, { tone: 'error' })
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
      .update({ supervisor_submitted: true, supervisor_submitted_at: new Date().toISOString(), calibration_status: 'pending' })
      .eq('id', selected.id)

    setSubmitting(false)
    showToast('評量已送出，待 HR 校準後正式發佈')
    setSelected(null)
    fetchParticipants()
  }

  if (loading) return <div><PageHeader title="員工考核評量" /><Skeleton height="80px" /></div>

  return (
    <div>
      <PageHeader title="員工考核評量" />

      {participants.length === 0 ? (
        <Card><EmptyState title="目前沒有需要評量的員工" /></Card>
      ) : (
        <div className="review-list">
          {participants.map(p => {
            const isReturned = p.calibration_status === 'returned'
            const isLocked = p.supervisor_submitted && !isReturned
            return (
              <Card key={p.id}>
                <div className="review-row">
                  <div>
                    <div className="review-row__title">{p.user?.full_name}</div>
                    <div className="review-row__meta">{p.review?.title}｜{p.review?.year} 年度</div>
                    <div className="review-row__chips">
                      <Chip tone={p.self_submitted ? 'success' : 'warning'}>{p.self_submitted ? '自評已完成' : '待完成自評'}</Chip>
                      {isReturned && <Chip tone="error">HR 已退回，請重新評核</Chip>}
                    </div>
                  </div>
                  <div className="review-row__actions">
                    <Chip tone={isLocked ? 'info' : p.supervisor_submitted ? 'error' : 'warning'}>
                      {isLocked ? '已送出，待 HR 校準' : p.supervisor_submitted ? '待重新送出' : '待評量'}
                    </Chip>
                    {p.self_submitted && p.review?.status === 'active' && (
                      <Button size="sm" variant={isLocked ? 'outlined' : 'filled'} onClick={() => handleSelect(p)}>
                        {isLocked ? '查看評量' : p.supervisor_submitted ? '修改評量' : '填寫評量'}
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {selected && (
        <Card className="review-panel">
          <div className="review-panel__header">
            <h4 className="review-panel__title">評量 — {selected.user?.full_name}</h4>
            <Button variant="text" onClick={() => setSelected(null)}>取消</Button>
          </div>

          {selected.calibration_status === 'returned' && selected.calibration_note && (
            <div className="review-returned-banner">HR 退回原因：{selected.calibration_note}</div>
          )}

          {selected.supervisor_submitted && selected.calibration_status !== 'returned' ? (
            <div className="review-readonly-note">此評量已送出，正在等待 HR 校準，暫時無法修改。</div>
          ) : null}

          <fieldset className="review-fieldset" disabled={selected.supervisor_submitted && selected.calibration_status !== 'returned'}>
            {questions.map((q, i) => (
              <div key={q.id} className="review-question">
                <div className="review-question__title">{i + 1}. {q.question_text}</div>
                <div className="review-result-box">
                  <div className="review-result-box__label">員工自評</div>
                  <div>{responses[q.id] ?? '—'}</div>
                </div>
                <label className="review-question__label">我的評量 <span className="review-required">*</span></label>
                {q.question_type === 'text' ? (
                  <Textarea value={evalResponses[q.id] || ''} onChange={e => setEvalResponses(p => ({ ...p, [q.id]: e.target.value }))} rows={3} placeholder="請填寫評量..." />
                ) : (
                  <ScoreButtons min={q.score_min} max={q.score_max} value={evalResponses[q.id]} onChange={v => setEvalResponses(p => ({ ...p, [q.id]: v }))} />
                )}
              </div>
            ))}

            <div className="review-overall-form">
              <h5 className="review-overall-form__title">總評</h5>
              <div className="review-question">
                <label className="review-question__label">總評分數（1-10）<span className="review-required">*</span></label>
                <ScoreButtons min={1} max={10} value={overallScore} onChange={setOverallScore} />
              </div>
              <Textarea label="總評評語" required value={overallComment} onChange={e => setOverallComment(e.target.value)} rows={4} placeholder="請填寫總評評語..." />
            </div>

            {(!selected.supervisor_submitted || selected.calibration_status === 'returned') && (
              <Button block loading={submitting} onClick={handleSubmit}>送出評量</Button>
            )}
          </fieldset>
        </Card>
      )}
    </div>
  )
}

// ===== B20: HR 治理 — 週期與模板 =====
function CycleAndTemplates({ onSelectReviewForParticipants }) {
  const [templates, setTemplates] = useState([])
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('reviews')
  const [showAddTemplate, setShowAddTemplate] = useState(false)
  const [showAddReview, setShowAddReview] = useState(false)
  const [editTemplate, setEditTemplate] = useState(null)
  const [newTemplate, setNewTemplate] = useState({ name: '', description: '' })
  const [newReview, setNewReview] = useState({ title: '', year: new Date().getFullYear(), template_id: '', start_date: '', end_date: '', self_assessment_deadline: '', evaluation_deadline: '' })
  const [questions, setQuestions] = useState([])
  const [newQuestion, setNewQuestion] = useState({ question_text: '', question_type: 'text', score_min: 1, score_max: 5 })
  const { showToast } = useToast()

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    const [t, r] = await Promise.all([
      supabase.from('review_templates').select('*').order('created_at', { ascending: false }),
      supabase.from('annual_reviews').select('*, template:review_templates(name)').order('year', { ascending: false }),
    ])
    setTemplates(t.data || [])
    setReviews(r.data || [])
    setLoading(false)
  }

  async function handleAddTemplate() {
    if (!newTemplate.name) { showToast('請填寫模板名稱', { tone: 'error' }); return }
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('review_templates').insert({ ...newTemplate, created_by: user.id })
    setNewTemplate({ name: '', description: '' })
    setShowAddTemplate(false)
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
      ...newQuestion,
      template_id: editTemplate.id,
      order_index: questions.length
    })
    setNewQuestion({ question_text: '', question_type: 'text', score_min: 1, score_max: 5 })
    fetchTemplateQuestions(editTemplate.id)
  }

  async function handleDeleteQuestion(id) {
    await supabase.from('review_template_questions').delete().eq('id', id)
    fetchTemplateQuestions(editTemplate.id)
  }

  async function handleAddReview() {
    if (!newReview.title || !newReview.template_id || !newReview.start_date || !newReview.end_date) {
      showToast('請填寫所有必填欄位', { tone: 'error' }); return
    }
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('annual_reviews').insert({
      title: newReview.title,
      year: newReview.year,
      template_id: newReview.template_id,
      start_date: newReview.start_date,
      end_date: newReview.end_date,
      self_assessment_deadline: newReview.self_assessment_deadline || null,
      evaluation_deadline: newReview.evaluation_deadline || null,
      created_by: user.id,
    })
    setNewReview({ title: '', year: new Date().getFullYear(), template_id: '', start_date: '', end_date: '', self_assessment_deadline: '', evaluation_deadline: '' })
    setShowAddReview(false)
    fetchAll()
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
      <Tabs tabs={[
        { key: 'reviews', label: '年度考核週期', active: tab === 'reviews', onClick: () => setTab('reviews') },
        { key: 'templates', label: '考核模板管理', active: tab === 'templates', onClick: () => setTab('templates') },
      ]} />

      {tab === 'templates' && (
        <div>
          <div className="review-subheader">
            <h4 className="review-subheader__title">考核模板</h4>
            <Button size="sm" onClick={() => setShowAddTemplate(!showAddTemplate)}>+ 新增模板</Button>
          </div>

          {showAddTemplate && (
            <Card className="review-form-card">
              <div className="review-form-grid review-form-grid--single">
                <input className="ui-field__control" style={{ marginBottom: 'var(--space-100)' }} value={newTemplate.name} onChange={e => setNewTemplate(p => ({ ...p, name: e.target.value }))} placeholder="模板名稱，例：一般員工考核模板" />
                <input className="ui-field__control" value={newTemplate.description} onChange={e => setNewTemplate(p => ({ ...p, description: e.target.value }))} placeholder="說明（選填）" />
              </div>
              <div className="review-form-actions">
                <Button size="sm" onClick={handleAddTemplate}>新增</Button>
                <Button size="sm" variant="text" onClick={() => setShowAddTemplate(false)}>取消</Button>
              </div>
            </Card>
          )}

          <div className="review-list">
            {templates.map(t => (
              <Card key={t.id}>
                <div className="review-row">
                  <div>
                    <div className="review-row__title">{t.name}</div>
                    {t.description && <div className="review-row__meta">{t.description}</div>}
                  </div>
                  <Button size="sm" variant="outlined" onClick={() => { setEditTemplate(t); fetchTemplateQuestions(t.id) }}>設定題目</Button>
                </div>

                {editTemplate?.id === t.id && (
                  <div className="review-questions-editor">
                    {questions.map((q, i) => (
                      <div key={q.id} className="review-questions-editor__row">
                        <span>{i + 1}. {q.question_text}</span>
                        <Chip tone={q.question_type === 'score' ? 'info' : 'neutral'}>
                          {q.question_type === 'score' ? `評分 ${q.score_min}-${q.score_max}` : '文字'}
                        </Chip>
                        <Button size="sm" variant="danger-outlined" onClick={() => handleDeleteQuestion(q.id)}>刪除</Button>
                      </div>
                    ))}
                    <Card className="review-form-card">
                      <div className="review-form-grid review-form-grid--single">
                        <input className="ui-field__control" value={newQuestion.question_text} onChange={e => setNewQuestion(p => ({ ...p, question_text: e.target.value }))} placeholder="題目內容" />
                        <select className="ui-field__control" value={newQuestion.question_type} onChange={e => setNewQuestion(p => ({ ...p, question_type: e.target.value }))}>
                          <option value="text">文字題</option>
                          <option value="score">評分題</option>
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
        </div>
      )}

      {tab === 'reviews' && (
        <div>
          <div className="review-subheader">
            <h4 className="review-subheader__title">年度考核週期</h4>
            <Button size="sm" onClick={() => setShowAddReview(!showAddReview)}>+ 新增週期</Button>
          </div>

          {showAddReview && (
            <Card className="review-form-card">
              <div className="review-form-grid">
                <input className="ui-field__control" value={newReview.title} onChange={e => setNewReview(p => ({ ...p, title: e.target.value }))} placeholder="週期名稱，例：2026 年度考核（H2）" />
                <input className="ui-field__control" type="number" value={newReview.year} onChange={e => setNewReview(p => ({ ...p, year: Number(e.target.value) }))} />
                <select className="ui-field__control" value={newReview.template_id} onChange={e => setNewReview(p => ({ ...p, template_id: e.target.value }))}>
                  <option value="">請選擇模板</option>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <div />
                <label className="review-inline-label">自評期間開始<input className="ui-field__control" type="date" value={newReview.start_date} onChange={e => setNewReview(p => ({ ...p, start_date: e.target.value }))} /></label>
                <label className="review-inline-label">整體結束日<input className="ui-field__control" type="date" value={newReview.end_date} min={newReview.start_date} onChange={e => setNewReview(p => ({ ...p, end_date: e.target.value }))} /></label>
                <label className="review-inline-label">自評截止日<input className="ui-field__control" type="date" value={newReview.self_assessment_deadline} onChange={e => setNewReview(p => ({ ...p, self_assessment_deadline: e.target.value }))} /></label>
                <label className="review-inline-label">評核截止日<input className="ui-field__control" type="date" value={newReview.evaluation_deadline} onChange={e => setNewReview(p => ({ ...p, evaluation_deadline: e.target.value }))} /></label>
              </div>
              <div className="review-form-actions">
                <Button size="sm" onClick={handleAddReview}>新增</Button>
                <Button size="sm" variant="text" onClick={() => setShowAddReview(false)}>取消</Button>
              </div>
            </Card>
          )}

          <div className="review-list">
            {reviews.map(r => (
              <Card key={r.id}>
                <div className="review-row">
                  <div>
                    <div className="review-row__title">{r.title}</div>
                    <div className="review-row__meta">{r.year} 年度｜{r.start_date} ～ {r.end_date}｜模板：{r.template?.name}</div>
                    {(r.self_assessment_deadline || r.evaluation_deadline) && (
                      <div className="review-row__sub">
                        {r.self_assessment_deadline && `自評截止：${r.self_assessment_deadline}`}
                        {r.self_assessment_deadline && r.evaluation_deadline && '｜'}
                        {r.evaluation_deadline && `評核截止：${r.evaluation_deadline}`}
                      </div>
                    )}
                  </div>
                  <div className="review-row__actions">
                    <Chip tone={r.status === 'active' ? 'success' : 'neutral'}>{r.status === 'active' ? '進行中' : '已結束'}</Chip>
                    <Button size="sm" variant="outlined" onClick={() => onSelectReviewForParticipants(r)}>加入參與者</Button>
                    <Button size="sm" variant="outlined" onClick={() => handleToggleReviewStatus(r)}>
                      {r.status === 'active' ? '結束週期' : '重新開放'}
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ===== B20: HR 治理 — 批次加入參與者 =====
function ParticipantSetup({ initialReview }) {
  const [reviews, setReviews] = useState([])
  const [selectedReviewId, setSelectedReviewId] = useState(initialReview?.id || '')
  const [users, setUsers] = useState([])
  const [participants, setParticipants] = useState([])
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState('company')
  const [manualSelection, setManualSelection] = useState([])
  const { showToast } = useToast()

  useEffect(() => { fetchReviews() }, [])
  useEffect(() => { if (selectedReviewId) { fetchUsers(); fetchParticipants() } }, [selectedReviewId])

  async function fetchReviews() {
    const { data } = await supabase.from('annual_reviews').select('*').order('year', { ascending: false })
    setReviews(data || [])
    setLoading(false)
  }

  async function fetchUsers() {
    const { data } = await supabase.from('users').select('id, full_name, role, manager_id, is_active').eq('is_active', true).order('full_name')
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
  const managerById = Object.fromEntries(users.map(u => [u.id, u]))

  function candidateUsers() {
    if (scope === 'manual') return users.filter(u => manualSelection.includes(u.id))
    return users
  }

  function resolvedManagerFor(user) {
    if (!user.manager_id) return null
    return managerById[user.manager_id] || null
  }

  async function handleBulkAdd() {
    const candidates = candidateUsers().filter(u => !existingUserIds.has(u.id))
    if (candidates.length === 0) { showToast('沒有可加入的新參與者', { tone: 'error' }); return }

    const rows = candidates.map(u => ({
      review_id: selectedReviewId,
      user_id: u.id,
      supervisor_id: u.manager_id || null,
    }))

    const { error } = await supabase.from('annual_review_participants').insert(rows)
    if (error) { showToast('加入失敗：' + error.message, { tone: 'error' }); return }
    showToast(`已加入 ${candidates.length} 位參與者`)
    setManualSelection([])
    fetchParticipants()
  }

  async function handleChangeSupervisor(participantId, supervisorId) {
    await supabase.from('annual_review_participants').update({ supervisor_id: supervisorId || null }).eq('id', participantId)
    fetchParticipants()
  }

  async function handleRemove(participantId) {
    await supabase.from('annual_review_participants').delete().eq('id', participantId)
    fetchParticipants()
  }

  if (loading) return <Skeleton height="120px" />

  const candidates = candidateUsers()
  const newCandidates = candidates.filter(u => !existingUserIds.has(u.id))
  const missingManagerCount = newCandidates.filter(u => !resolvedManagerFor(u)).length

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">批次加入參與者</h4>
      </div>

      <Card className="review-form-card">
        <select className="ui-field__control" value={selectedReviewId} onChange={e => setSelectedReviewId(e.target.value)} style={{ marginBottom: 'var(--space-150)' }}>
          <option value="">請選擇考核週期</option>
          {reviews.map(r => <option key={r.id} value={r.id}>{r.title}（{r.year}）</option>)}
        </select>

        {selectedReviewId && (
          <>
            <div className="review-scope-row">
              <label className="review-radio">
                <input type="radio" checked={scope === 'company'} onChange={() => setScope('company')} /> 全公司
              </label>
              <label className="review-radio">
                <input type="radio" checked={scope === 'manual'} onChange={() => setScope('manual')} /> 手動選取名單
              </label>
            </div>

            {scope === 'manual' && (
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
              </div>
            )}

            <div className="review-summary-banner">
              已選 {newCandidates.length} 人，已自動帶入直屬主管作為評核人：{newCandidates.length - missingManagerCount} 人
              {missingManagerCount > 0 && (
                <div className="review-summary-banner__warning">⚠ {missingManagerCount} 人查無直屬主管資料，無法自動配對，需手動指定（見下方清單）</div>
              )}
            </div>

            <Button onClick={handleBulkAdd} disabled={newCandidates.length === 0}>加入參與者</Button>
          </>
        )}
      </Card>

      {selectedReviewId && (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr><th>姓名</th><th>目前評核人</th><th>操作</th></tr>
            </thead>
            <tbody>
              {participants.map(p => (
                <tr key={p.id}>
                  <td>{p.user?.full_name}</td>
                  <td>{p.supervisor?.full_name || <span className="review-missing-manager">⚠ 未指定</span>}</td>
                  <td>
                    <div className="review-table-actions">
                      <select className="ui-field__control" defaultValue={p.supervisor_id || ''} onChange={e => handleChangeSupervisor(p.id, e.target.value)}>
                        <option value="">未指定</option>
                        {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                      </select>
                      <Button size="sm" variant="danger-outlined" onClick={() => handleRemove(p.id)}>移除</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ===== B21: HR 校準儀表板 =====
function Calibration() {
  const [reviews, setReviews] = useState([])
  const [selectedReviewId, setSelectedReviewId] = useState('')
  const [participants, setParticipants] = useState([])
  const [loading, setLoading] = useState(true)
  const [returnTarget, setReturnTarget] = useState(null)
  const [returnReason, setReturnReason] = useState('')
  const { showToast } = useToast()

  useEffect(() => { fetchReviews() }, [])
  useEffect(() => { if (selectedReviewId) fetchParticipants() }, [selectedReviewId])

  async function fetchReviews() {
    const { data } = await supabase.from('annual_reviews').select('*').order('year', { ascending: false })
    setReviews(data || [])
    if (data?.length) setSelectedReviewId(data[0].id)
    setLoading(false)
  }

  async function fetchParticipants() {
    const { data } = await supabase
      .from('annual_review_participants')
      .select(`
        *,
        user:users!annual_review_participants_user_id_fkey(full_name),
        supervisor:users!annual_review_participants_supervisor_id_fkey(full_name),
        evaluations:review_evaluations(overall_score, is_overall)
      `)
      .eq('review_id', selectedReviewId)
      .eq('self_submitted', true)
      .eq('supervisor_submitted', true)
    setParticipants(data || [])
  }

  async function handleMarkCalibrated(id) {
    await supabase.from('annual_review_participants').update({ calibration_status: 'calibrated', calibration_note: null }).eq('id', id)
    showToast('已標記為已校準')
    fetchParticipants()
  }

  async function handleReturn() {
    if (!returnReason.trim()) { showToast('請填寫退回原因', { tone: 'error' }); return }
    await supabase.from('annual_review_participants').update({
      calibration_status: 'returned',
      calibration_note: returnReason.trim(),
      supervisor_submitted: false,
    }).eq('id', returnTarget.id)
    showToast(`已退回 ${returnTarget.supervisor?.full_name || '評核人'} 重新評核`)
    setReturnTarget(null)
    setReturnReason('')
    fetchParticipants()
  }

  if (loading) return <Skeleton height="120px" />

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">跨主管校準</h4>
        <select className="ui-field__control" value={selectedReviewId} onChange={e => setSelectedReviewId(e.target.value)} style={{ maxWidth: '260px' }}>
          {reviews.map(r => <option key={r.id} value={r.id}>{r.title}（{r.year}）</option>)}
        </select>
      </div>

      {participants.length === 0 ? (
        <Card><EmptyState title="目前沒有待校準項目" description="評核人送出評量後，項目會出現在這裡" /></Card>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr><th>員工</th><th>評核人</th><th>總分</th><th>狀態</th><th>操作</th></tr>
            </thead>
            <tbody>
              {participants.map(p => {
                const overall = p.evaluations?.find(e => e.is_overall)
                return (
                  <tr key={p.id}>
                    <td>{p.user?.full_name}</td>
                    <td>{p.supervisor?.full_name}</td>
                    <td>{overall?.overall_score ?? '—'}</td>
                    <td><Chip tone={p.calibration_status === 'calibrated' ? 'success' : p.calibration_status === 'returned' ? 'error' : 'warning'}>
                      {p.calibration_status === 'calibrated' ? '已校準' : p.calibration_status === 'returned' ? '已退回' : '待校準'}
                    </Chip></td>
                    <td>
                      <div className="review-table-actions">
                        {p.calibration_status !== 'calibrated' && (
                          <Button size="sm" onClick={() => handleMarkCalibrated(p.id)}>標記已校準</Button>
                        )}
                        <Button size="sm" variant="danger-outlined" onClick={() => setReturnTarget(p)}>退回主管</Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {returnTarget && (
        <ConfirmDialog
          title={`退回 ${returnTarget.supervisor?.full_name || ''} 的評核`}
          description={(
            <Textarea label="退回原因" required value={returnReason} onChange={e => setReturnReason(e.target.value)} rows={3} placeholder="請說明需要修改的地方" />
          )}
          confirmLabel="退回"
          danger
          onConfirm={handleReturn}
          onCancel={() => { setReturnTarget(null); setReturnReason('') }}
        />
      )}
    </div>
  )
}

// ===== B22: 發佈與總覽 =====
function PublishOverview({ readOnly = false }) {
  const [reviews, setReviews] = useState([])
  const [selectedReviewId, setSelectedReviewId] = useState('')
  const [participants, setParticipants] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedIds, setSelectedIds] = useState([])
  const [confirmBatch, setConfirmBatch] = useState(false)
  const { showToast } = useToast()

  useEffect(() => { fetchReviews() }, [])
  useEffect(() => { if (selectedReviewId) fetchParticipants() }, [selectedReviewId])

  async function fetchReviews() {
    const { data } = await supabase.from('annual_reviews').select('*').order('year', { ascending: false })
    setReviews(data || [])
    if (data?.length) setSelectedReviewId(data[0].id)
    setLoading(false)
  }

  async function fetchParticipants() {
    const { data } = await supabase
      .from('annual_review_participants')
      .select('*, user:users!annual_review_participants_user_id_fkey(full_name)')
      .eq('review_id', selectedReviewId)
    setParticipants(data || [])
    setSelectedIds([])
  }

  const total = participants.length
  const selfDone = participants.filter(p => p.self_submitted).length
  const evalDone = participants.filter(p => p.supervisor_submitted).length
  const calibrated = participants.filter(p => p.calibration_status === 'calibrated' && !p.published_at).length
  const published = participants.filter(p => p.published_at).length

  async function publishOne(id) {
    await supabase.from('annual_review_participants').update({ published_at: new Date().toISOString() }).eq('id', id)
    showToast('已發佈 1 筆')
    fetchParticipants()
  }

  async function publishBatch() {
    for (const id of selectedIds) {
      await supabase.from('annual_review_participants').update({ published_at: new Date().toISOString() }).eq('id', id)
    }
    showToast(`已批次發佈 ${selectedIds.length} 筆`)
    setConfirmBatch(false)
    fetchParticipants()
  }

  if (loading) return <Skeleton height="120px" />

  const eligible = participants.filter(p => p.calibration_status === 'calibrated' && !p.published_at)

  return (
    <div>
      <div className="review-subheader">
        <h4 className="review-subheader__title">{readOnly ? '年度考核總覽' : '發佈與總覽'}</h4>
        <select className="ui-field__control" value={selectedReviewId} onChange={e => setSelectedReviewId(e.target.value)} style={{ maxWidth: '260px' }}>
          {reviews.map(r => <option key={r.id} value={r.id}>{r.title}（{r.year}）</option>)}
        </select>
      </div>

      <Card className="review-overview-stats">
        <div>自評完成 {selfDone}/{total}</div>
        <div>評核完成 {evalDone}/{total}</div>
        <div>已校準可發佈 {calibrated}／已發佈 {published}</div>
      </Card>

      {!readOnly && (
        <div className="review-batch-bar">
          <Button size="sm" disabled={selectedIds.length === 0} onClick={() => setConfirmBatch(true)}>批次發佈已選項目（{selectedIds.length}）</Button>
        </div>
      )}

      {participants.length === 0 ? (
        <Card><EmptyState title="尚無參與者資料" /></Card>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr>
                {!readOnly && <th></th>}
                <th>姓名</th><th>狀態</th>{!readOnly && <th>操作</th>}
              </tr>
            </thead>
            <tbody>
              {participants.map(p => (
                <tr key={p.id}>
                  {!readOnly && (
                    <td>
                      <input
                        type="checkbox"
                        disabled={!(p.calibration_status === 'calibrated' && !p.published_at)}
                        checked={selectedIds.includes(p.id)}
                        onChange={e => setSelectedIds(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))}
                      />
                    </td>
                  )}
                  <td>{p.user?.full_name}</td>
                  <td>
                    <Chip tone={p.published_at ? 'success' : p.calibration_status === 'calibrated' ? 'info' : 'warning'}>
                      {p.published_at ? '已發佈' : p.calibration_status === 'calibrated' ? '已校準' : '未校準'}
                    </Chip>
                  </td>
                  {!readOnly && (
                    <td>
                      {!p.published_at && (
                        <Button size="sm" variant="outlined" disabled={p.calibration_status !== 'calibrated'} onClick={() => publishOne(p.id)}>發佈</Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmBatch && (
        <ConfirmDialog
          title="批次發佈"
          description={`發佈後 ${selectedIds.length} 位員工將立即收到通知並可查看結果，且無法撤回，是否繼續？`}
          confirmLabel="發佈"
          onConfirm={publishBatch}
          onCancel={() => setConfirmBatch(false)}
        />
      )}

      {eligible.length === 0 && participants.length > 0 && !readOnly && (
        <p className="review-hint">目前沒有可發佈的項目，請先於「校準」分頁完成校準。</p>
      )}
    </div>
  )
}

// ===== HR 治理殼層：週期/模板、參與者、校準、發佈 =====
function Governance() {
  const location = useLocation()
  const [participantsReview, setParticipantsReview] = useState(null)

  const tabs = [
    { key: 'cycles', label: '週期與模板', to: '/review/admin', active: location.pathname === '/review/admin' },
    { key: 'participants', label: '參與者', to: '/review/admin/participants', active: location.pathname === '/review/admin/participants' },
    { key: 'calibration', label: '校準', to: '/review/admin/calibration', active: location.pathname === '/review/admin/calibration' },
    { key: 'publish', label: '發佈總覽', to: '/review/admin/publish', active: location.pathname === '/review/admin/publish' },
  ]

  return (
    <div>
      <Tabs tabs={tabs} />
      <Routes>
        <Route index element={<CycleAndTemplates onSelectReviewForParticipants={(r) => setParticipantsReview(r)} />} />
        <Route path="participants" element={<ParticipantSetup initialReview={participantsReview} />} />
        <Route path="calibration" element={<Calibration />} />
        <Route path="publish" element={<PublishOverview />} />
      </Routes>
    </div>
  )
}

// ===== Review 主元件 =====
function Review({ userProfile }) {
  const location = useLocation()
  const isAdmin = userProfile?.role === 'admin'
  const isBoss = userProfile?.role === 'boss'
  const isEvaluator = EVALUATOR_ROLES.includes(userProfile?.role)

  const tabs = [{ key: 'mine', path: '/review', label: '我的考核', end: true }]
  if (isEvaluator) tabs.push({ key: 'evaluate', path: '/review/evaluate', label: '員工評量' })
  if (isAdmin) tabs.push({ key: 'admin', path: '/review/admin', label: '考核治理' })
  if (isBoss) tabs.push({ key: 'overview', path: '/review/overview', label: '全公司總覽' })

  return (
    <div>
      <PageHeader title="年度考核" />
      <Tabs tabs={tabs.map(t => ({
        ...t,
        to: t.path,
        active: t.end ? location.pathname === t.path : location.pathname.startsWith(t.path),
      }))} />

      <Routes>
        <Route index element={<MyReview userProfile={userProfile} />} />
        {isEvaluator && <Route path="evaluate" element={<SupervisorEvaluation userProfile={userProfile} />} />}
        {isAdmin && <Route path="admin/*" element={<Governance />} />}
        {isBoss && <Route path="overview" element={<PublishOverview readOnly />} />}
        <Route path="*" element={<Navigate to="/review" replace />} />
      </Routes>
    </div>
  )
}

export default Review
