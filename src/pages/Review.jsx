import { useState, useEffect } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ===== 我的考核 =====
function MyReview({ userProfile }) {
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [questions, setQuestions] = useState([])
  const [responses, setResponses] = useState({})
  const [submitting, setSubmitting] = useState(false)

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
    console.log('my reviews:', data)
    setReviews(data || [])
    setLoading(false)
  }

  async function fetchQuestions(templateId, participantId) {
    const { data: qs } = await supabase
      .from('review_template_questions')
      .select('*')
      .eq('template_id', templateId)
      .order('order_index')
    console.log('templateId:', templateId, 'questions:', qs)

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

  async function handleSelect(participant) {
    setSelected(participant)
    await fetchQuestions(participant.review.template_id, participant.id)
  }

  async function handleSubmit() {
    // 檢查是否所有題目都有填
    for (const q of questions) {
      if (!responses[q.id] && responses[q.id] !== 0) {
        alert(`請填寫所有題目：「${q.question_text}」未填寫`)
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
    fetchMyReviews()
    setSelected(null)
    alert('自評已送出！')
  }

  async function fetchEvaluations(participantId) {
    const { data } = await supabase
      .from('review_evaluations')
      .select('*, evaluator:users!review_evaluations_evaluator_id_fkey(full_name, role)')
      .eq('participant_id', participantId)
    return data || []
  }

  const [evaluations, setEvaluations] = useState([])

  async function handleViewResult(participant) {
    setSelected(participant)
    await fetchQuestions(participant.review.template_id, participant.id)
    const evals = await fetchEvaluations(participant.id)
    setEvaluations(evals)
  }

  if (loading) return <p style={{ color: '#6b7280' }}>載入中...</p>

  return (
    <div>
      <h3 style={{ marginBottom: '20px', color: '#1f2937' }}>我的考核</h3>

      {reviews.length === 0 ? (
        <div style={{ ...cardStyle, textAlign: 'center', color: '#6b7280', padding: '48px' }}>
          目前沒有考核任務
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '12px' }}>
          {reviews.map(p => (
            <div key={p.id} style={{ ...cardStyle, padding: '16px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: '600', color: '#1f2937', marginBottom: '4px' }}>
                    {p.review?.title}
                  </div>
                  <div style={{ fontSize: '13px', color: '#6b7280' }}>
                    {p.review?.year} 年度｜{p.review?.start_date} ～ {p.review?.end_date}
                  </div>
                  <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
                    主管：{p.supervisor?.full_name || '未指定'}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end' }}>
                  <span style={{
                    backgroundColor: p.self_submitted ? '#D1FAE5' : '#FEF3C7',
                    color: p.self_submitted ? '#10B981' : '#D97706',
                    padding: '4px 12px', borderRadius: '20px', fontSize: '12px'
                  }}>
                    {p.self_submitted ? '自評已完成' : '待填寫自評'}
                  </span>
                  {!p.self_submitted && p.review?.status === 'active' && (
                    <button onClick={() => handleSelect(p)} style={btnPrimary}>填寫自評</button>
                  )}
                  {p.self_submitted && p.supervisor_submitted && (
                    <button onClick={() => handleViewResult(p)} style={btnSecondary}>查看結果</button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 填寫自評 */}
      {selected && !selected.self_submitted && (
        <div style={{ marginTop: '24px', ...cardStyle }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h4 style={{ margin: 0, color: '#1f2937' }}>填寫自評 — {selected.review?.title}</h4>
            <button onClick={() => setSelected(null)} style={btnSecondary}>取消</button>
          </div>
          {questions.map((q, i) => (
            <div key={q.id} style={{ marginBottom: '20px' }}>
              <label style={{ ...labelStyle, fontSize: '15px' }}>
                {i + 1}. {q.question_text} <span style={{ color: '#EF4444' }}>*</span>
              </label>
              {q.question_type === 'text' ? (
                <textarea
                  value={responses[q.id] || ''}
                  onChange={e => setResponses(p => ({ ...p, [q.id]: e.target.value }))}
                  rows={4}
                  style={{ ...inputStyle, resize: 'vertical' }}
                  placeholder="請填寫..."
                />
              ) : (
                <div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {Array.from({ length: q.score_max - q.score_min + 1 }, (_, i) => i + q.score_min).map(score => (
                      <button
                        key={score}
                        onClick={() => setResponses(p => ({ ...p, [q.id]: score }))}
                        style={{
                          width: '44px', height: '44px',
                          borderRadius: '8px', border: '2px solid',
                          borderColor: responses[q.id] === score ? '#4F46E5' : '#e5e7eb',
                          backgroundColor: responses[q.id] === score ? '#4F46E5' : 'white',
                          color: responses[q.id] === score ? 'white' : '#374151',
                          fontWeight: '600', cursor: 'pointer', fontSize: '16px'
                        }}
                      >
                        {score}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                    <span style={{ fontSize: '12px', color: '#9ca3af' }}>最低 {q.score_min}</span>
                    <span style={{ fontSize: '12px', color: '#9ca3af' }}>最高 {q.score_max}</span>
                  </div>
                </div>
              )}
            </div>
          ))}
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{ ...btnPrimary, width: '100%', padding: '12px', fontSize: '16px' }}
          >
            {submitting ? '送出中...' : '送出自評'}
          </button>
        </div>
      )}

      {/* 查看結果 */}
      {selected && selected.self_submitted && (
        <div style={{ marginTop: '24px', ...cardStyle }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h4 style={{ margin: 0, color: '#1f2937' }}>考核結果 — {selected.review?.title}</h4>
            <button onClick={() => setSelected(null)} style={btnSecondary}>關閉</button>
          </div>
          {questions.map((q, i) => {
            const myResponse = responses[q.id]
            const evalResponse = evaluations.find(e => e.question_id === q.id && !e.is_overall)
            return (
              <div key={q.id} style={{ marginBottom: '20px', paddingBottom: '20px', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ fontWeight: '500', color: '#374151', marginBottom: '8px' }}>
                  {i + 1}. {q.question_text}
                </div>
                <div style={{ backgroundColor: '#f9fafb', borderRadius: '8px', padding: '12px', marginBottom: '8px' }}>
                  <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '4px' }}>我的自評</div>
                  <div style={{ color: '#374151' }}>{myResponse || '—'}</div>
                </div>
                {evalResponse && (
                  <div style={{ backgroundColor: '#EEF2FF', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '12px', color: '#4F46E5', marginBottom: '4px' }}>
                      {evalResponse.evaluator?.full_name} 的評量
                    </div>
                    <div style={{ color: '#374151' }}>
                      {evalResponse.text_answer || evalResponse.score_answer || '—'}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* 總評 */}
          {evaluations.filter(e => e.is_overall).map(e => (
            <div key={e.id} style={{ backgroundColor: '#EEF2FF', borderRadius: '8px', padding: '16px', marginTop: '12px' }}>
              <div style={{ fontWeight: '600', color: '#4F46E5', marginBottom: '8px' }}>
                {e.evaluator?.full_name} 的總評
              </div>
              <div style={{ display: 'flex', gap: '16px', marginBottom: '8px' }}>
                <div style={{ fontSize: '13px', color: '#6b7280' }}>
                  總分：<strong style={{ color: '#4F46E5', fontSize: '18px' }}>{e.overall_score}</strong> 分
                </div>
              </div>
              {e.overall_comment && (
                <div style={{ fontSize: '14px', color: '#374151' }}>{e.overall_comment}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 主管評量 =====
function SupervisorReview({ userProfile }) {
  const [participants, setParticipants] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [questions, setQuestions] = useState([])
  const [responses, setResponses] = useState({})
  const [evalResponses, setEvalResponses] = useState({})
  const [overallScore, setOverallScore] = useState('')
  const [overallComment, setOverallComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

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
        alert(`請填寫所有評量題目：「${q.question_text}」未填寫`)
        return
      }
    }
    if (!overallScore) { alert('請填寫總評分數'); return }
    if (!overallComment) { alert('請填寫總評評語'); return }

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
    fetchParticipants()
    setSelected(null)
    alert('評量已送出！')
  }

  if (loading) return <p style={{ color: '#6b7280' }}>載入中...</p>

  return (
    <div>
      <h3 style={{ marginBottom: '20px', color: '#1f2937' }}>員工考核評量</h3>

      {participants.length === 0 ? (
        <div style={{ ...cardStyle, textAlign: 'center', color: '#6b7280', padding: '48px' }}>
          目前沒有需要評量的員工
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '12px' }}>
          {participants.map(p => (
            <div key={p.id} style={{ ...cardStyle, padding: '16px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: '600', color: '#1f2937', marginBottom: '4px' }}>
                    {p.user?.full_name}
                  </div>
                  <div style={{ fontSize: '13px', color: '#6b7280' }}>
                    {p.review?.title}｜{p.review?.year} 年度
                  </div>
                  <div style={{ fontSize: '12px', marginTop: '4px' }}>
                    <span style={{
                      backgroundColor: p.self_submitted ? '#D1FAE5' : '#FEF3C7',
                      color: p.self_submitted ? '#10B981' : '#D97706',
                      padding: '2px 8px', borderRadius: '4px', fontSize: '11px'
                    }}>
                      {p.self_submitted ? '自評已完成' : '待完成自評'}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end' }}>
                  <span style={{
                    backgroundColor: p.supervisor_submitted ? '#D1FAE5' : '#FEF3C7',
                    color: p.supervisor_submitted ? '#10B981' : '#D97706',
                    padding: '4px 12px', borderRadius: '20px', fontSize: '12px'
                  }}>
                    {p.supervisor_submitted ? '評量已完成' : '待評量'}
                  </span>
                  {p.self_submitted && p.review?.status === 'active' && (
                    <button onClick={() => handleSelect(p)} style={btnPrimary}>
                      {p.supervisor_submitted ? '查看/修改評量' : '填寫評量'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div style={{ marginTop: '24px', ...cardStyle }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h4 style={{ margin: 0, color: '#1f2937' }}>評量 — {selected.user?.full_name}</h4>
            <button onClick={() => setSelected(null)} style={btnSecondary}>取消</button>
          </div>

          {questions.map((q, i) => (
            <div key={q.id} style={{ marginBottom: '24px' }}>
              <div style={{ fontWeight: '500', color: '#374151', marginBottom: '8px' }}>
                {i + 1}. {q.question_text}
              </div>
              <div style={{ backgroundColor: '#f9fafb', borderRadius: '8px', padding: '12px', marginBottom: '8px' }}>
                <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '4px' }}>員工自評</div>
                <div style={{ color: '#374151' }}>{responses[q.id] || '—'}</div>
              </div>
              <label style={labelStyle}>
                我的評量 <span style={{ color: '#EF4444' }}>*</span>
              </label>
              {q.question_type === 'text' ? (
                <textarea
                  value={evalResponses[q.id] || ''}
                  onChange={e => setEvalResponses(p => ({ ...p, [q.id]: e.target.value }))}
                  rows={3}
                  style={{ ...inputStyle, resize: 'vertical' }}
                  placeholder="請填寫評量..."
                />
              ) : (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {Array.from({ length: q.score_max - q.score_min + 1 }, (_, i) => i + q.score_min).map(score => (
                    <button
                      key={score}
                      onClick={() => setEvalResponses(p => ({ ...p, [q.id]: score }))}
                      style={{
                        width: '44px', height: '44px', borderRadius: '8px',
                        border: '2px solid',
                        borderColor: evalResponses[q.id] === score ? '#4F46E5' : '#e5e7eb',
                        backgroundColor: evalResponses[q.id] === score ? '#4F46E5' : 'white',
                        color: evalResponses[q.id] === score ? 'white' : '#374151',
                        fontWeight: '600', cursor: 'pointer', fontSize: '16px'
                      }}
                    >
                      {score}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div style={{ borderTop: '2px solid #EEF2FF', paddingTop: '20px', marginTop: '8px' }}>
            <h5 style={{ color: '#4F46E5', marginBottom: '16px' }}>總評</h5>
            <div style={{ marginBottom: '16px' }}>
              <label style={labelStyle}>總評分數（1-10）<span style={{ color: '#EF4444' }}>*</span></label>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map(score => (
                  <button
                    key={score}
                    onClick={() => setOverallScore(score)}
                    style={{
                      width: '44px', height: '44px', borderRadius: '8px',
                      border: '2px solid',
                      borderColor: overallScore === score ? '#4F46E5' : '#e5e7eb',
                      backgroundColor: overallScore === score ? '#4F46E5' : 'white',
                      color: overallScore === score ? 'white' : '#374151',
                      fontWeight: '600', cursor: 'pointer', fontSize: '16px'
                    }}
                  >
                    {score}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ marginBottom: '20px' }}>
              <label style={labelStyle}>總評評語 <span style={{ color: '#EF4444' }}>*</span></label>
              <textarea
                value={overallComment}
                onChange={e => setOverallComment(e.target.value)}
                rows={4}
                style={{ ...inputStyle, resize: 'vertical' }}
                placeholder="請填寫總評評語..."
              />
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{ ...btnPrimary, width: '100%', padding: '12px', fontSize: '16px' }}
          >
            {submitting ? '送出中...' : '送出評量'}
          </button>
        </div>
      )}
    </div>
  )
}

// ===== 考核管理（老闆看所有人）=====
function ReviewOverview({ userProfile }) {
  const [reviews, setReviews] = useState([])
  const [participants, setParticipants] = useState([])
  const [selectedReview, setSelectedReview] = useState(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [questions, setQuestions] = useState([])
  const [responses, setResponses] = useState({})
  const [evaluations, setEvaluations] = useState([])

  useEffect(() => { fetchReviews() }, [])

  async function fetchReviews() {
    const { data } = await supabase
      .from('annual_reviews')
      .select('*, template:review_templates(name)')
      .order('year', { ascending: false })
    setReviews(data || [])
    setLoading(false)
  }

  async function fetchParticipants(reviewId) {
    const { data } = await supabase
      .from('annual_review_participants')
      .select(`
        *,
        user:users!annual_review_participants_user_id_fkey(full_name),
        supervisor:users!annual_review_participants_supervisor_id_fkey(full_name)
      `)
      .eq('review_id', reviewId)
    setParticipants(data || [])
  }

  async function handleSelectReview(review) {
    setSelectedReview(review)
    await fetchParticipants(review.id)
  }

  async function handleViewDetail(participant) {
    setSelected(participant)
    const { data: qs } = await supabase
      .from('review_template_questions')
      .select('*')
      .eq('template_id', selectedReview.template_id)
      .order('order_index')
    setQuestions(qs || [])

    const { data: rs } = await supabase
      .from('review_responses')
      .select('*')
      .eq('participant_id', participant.id)
    const responseMap = {}
    for (const r of rs || []) {
      responseMap[r.question_id] = r.score_answer ?? r.text_answer
    }
    setResponses(responseMap)

    const { data: evals } = await supabase
      .from('review_evaluations')
      .select('*, evaluator:users!review_evaluations_evaluator_id_fkey(full_name)')
      .eq('participant_id', participant.id)
    setEvaluations(evals || [])
  }

  if (loading) return <p style={{ color: '#6b7280' }}>載入中...</p>

  return (
    <div>
      <h3 style={{ marginBottom: '20px', color: '#1f2937' }}>考核總覽</h3>

      {!selectedReview ? (
        <div style={{ display: 'grid', gap: '12px' }}>
          {reviews.map(r => (
            <div key={r.id} style={{ ...cardStyle, padding: '16px 20px', cursor: 'pointer' }} onClick={() => handleSelectReview(r)}>
              <div style={{ fontWeight: '600', color: '#1f2937', marginBottom: '4px' }}>{r.title}</div>
              <div style={{ fontSize: '13px', color: '#6b7280' }}>
                {r.year} 年度｜{r.start_date} ～ {r.end_date}｜模板：{r.template?.name}
              </div>
              <span style={{
                marginTop: '8px', display: 'inline-block',
                backgroundColor: r.status === 'active' ? '#D1FAE5' : '#F3F4F6',
                color: r.status === 'active' ? '#10B981' : '#6B7280',
                padding: '2px 10px', borderRadius: '20px', fontSize: '12px'
              }}>
                {r.status === 'active' ? '進行中' : '已結束'}
              </span>
            </div>
          ))}
        </div>
      ) : !selected ? (
        <div>
          <button onClick={() => setSelectedReview(null)} style={{ ...btnSecondary, marginBottom: '16px' }}>← 返回</button>
          <h4 style={{ color: '#1f2937', marginBottom: '16px' }}>{selectedReview.title} — 參與人員</h4>
          <div style={{ display: 'grid', gap: '8px' }}>
            {participants.map(p => (
              <div key={p.id} style={{ ...cardStyle, padding: '14px 20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: '600', color: '#1f2937', marginBottom: '4px' }}>{p.user?.full_name}</div>
                    <div style={{ fontSize: '13px', color: '#6b7280' }}>主管：{p.supervisor?.full_name || '未指定'}</div>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                      <span style={{
                        backgroundColor: p.self_submitted ? '#D1FAE5' : '#FEF3C7',
                        color: p.self_submitted ? '#10B981' : '#D97706',
                        padding: '2px 8px', borderRadius: '4px', fontSize: '11px'
                      }}>
                        {p.self_submitted ? '自評完成' : '待自評'}
                      </span>
                      <span style={{
                        backgroundColor: p.supervisor_submitted ? '#D1FAE5' : '#FEF3C7',
                        color: p.supervisor_submitted ? '#10B981' : '#D97706',
                        padding: '2px 8px', borderRadius: '4px', fontSize: '11px'
                      }}>
                        {p.supervisor_submitted ? '評量完成' : '待評量'}
                      </span>
                    </div>
                  </div>
                  {p.self_submitted && p.supervisor_submitted && (
                    <button onClick={() => handleViewDetail(p)} style={btnSecondary}>查看詳情</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <button onClick={() => setSelected(null)} style={{ ...btnSecondary, marginBottom: '16px' }}>← 返回</button>
          <h4 style={{ color: '#1f2937', marginBottom: '16px' }}>{selected.user?.full_name} 的考核結果</h4>
          {questions.map((q, i) => {
            const myResponse = responses[q.id]
            const evalResponses = evaluations.filter(e => e.question_id === q.id && !e.is_overall)
            return (
              <div key={q.id} style={{ marginBottom: '20px', paddingBottom: '20px', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ fontWeight: '500', color: '#374151', marginBottom: '8px' }}>{i + 1}. {q.question_text}</div>
                <div style={{ backgroundColor: '#f9fafb', borderRadius: '8px', padding: '12px', marginBottom: '8px' }}>
                  <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '4px' }}>員工自評</div>
                  <div style={{ color: '#374151' }}>{myResponse ?? '—'}</div>
                </div>
                {evalResponses.map(e => (
                  <div key={e.id} style={{ backgroundColor: '#EEF2FF', borderRadius: '8px', padding: '12px', marginBottom: '4px' }}>
                    <div style={{ fontSize: '12px', color: '#4F46E5', marginBottom: '4px' }}>{e.evaluator?.full_name} 的評量</div>
                    <div style={{ color: '#374151' }}>{e.text_answer ?? e.score_answer ?? '—'}</div>
                  </div>
                ))}
              </div>
            )
          })}
          {evaluations.filter(e => e.is_overall).map(e => (
            <div key={e.id} style={{ backgroundColor: '#EEF2FF', borderRadius: '8px', padding: '16px', marginTop: '12px' }}>
              <div style={{ fontWeight: '600', color: '#4F46E5', marginBottom: '8px' }}>{e.evaluator?.full_name} 的總評</div>
              <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '8px' }}>
                總分：<strong style={{ color: '#4F46E5', fontSize: '18px' }}>{e.overall_score}</strong> 分
              </div>
              {e.overall_comment && <div style={{ fontSize: '14px', color: '#374151' }}>{e.overall_comment}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 考核設定（管理後台用）=====
function ReviewAdmin() {
  const [templates, setTemplates] = useState([])
  const [reviews, setReviews] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('reviews')
  const [showAddTemplate, setShowAddTemplate] = useState(false)
  const [showAddReview, setShowAddReview] = useState(false)
  const [editTemplate, setEditTemplate] = useState(null)
  const [newTemplate, setNewTemplate] = useState({ name: '', description: '' })
  const [newReview, setNewReview] = useState({ title: '', year: new Date().getFullYear(), template_id: '', start_date: '', end_date: '' })
  const [selectedReview, setSelectedReview] = useState(null)
  const [newParticipant, setNewParticipant] = useState({ user_id: '', supervisor_id: '' })
  const [participants, setParticipants] = useState([])
  const [questions, setQuestions] = useState([])
  const [newQuestion, setNewQuestion] = useState({ question_text: '', question_type: 'text', score_min: 1, score_max: 5 })

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    const [t, r, u] = await Promise.all([
      supabase.from('review_templates').select('*').order('created_at', { ascending: false }),
      supabase.from('annual_reviews').select('*, template:review_templates(name)').order('year', { ascending: false }),
      supabase.from('users').select('id, full_name, role').eq('is_active', true).order('full_name')
    ])
    setTemplates(t.data || [])
    setReviews(r.data || [])
    setUsers(u.data || [])
    setLoading(false)
  }

  async function handleAddTemplate() {
    if (!newTemplate.name) { alert('請填寫模板名稱'); return }
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('review_templates').insert({ ...newTemplate, created_by: user.id })
    setNewTemplate({ name: '', description: '' })
    setShowAddTemplate(false)
    fetchAll()
  }

  async function handleAddReview() {
    if (!newReview.title || !newReview.template_id || !newReview.start_date || !newReview.end_date) {
      alert('請填寫所有欄位'); return
    }
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('annual_reviews').insert({ ...newReview, created_by: user.id })
    setNewReview({ title: '', year: new Date().getFullYear(), template_id: '', start_date: '', end_date: '' })
    setShowAddReview(false)
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
    if (!newQuestion.question_text) { alert('請填寫題目內容'); return }
    await supabase.from('review_template_questions').insert({
      ...newQuestion,
      template_id: editTemplate.id,
      order_index: questions.length
    })
    setNewQuestion({ question_text: '', question_type: 'text', score_min: 1, score_max: 5 })
    fetchTemplateQuestions(editTemplate.id)
  }

  async function handleDeleteQuestion(id) {
    if (!window.confirm('確定要刪除這題嗎？')) return
    await supabase.from('review_template_questions').delete().eq('id', id)
    fetchTemplateQuestions(editTemplate.id)
  }

  async function fetchReviewParticipants(reviewId) {
    const { data } = await supabase
      .from('annual_review_participants')
      .select(`
        *,
        user:users!annual_review_participants_user_id_fkey(full_name),
        supervisor:users!annual_review_participants_supervisor_id_fkey(full_name)
      `)
      .eq('review_id', reviewId)
    setParticipants(data || [])
  }

  async function handleAddParticipant() {
    if (!newParticipant.user_id) { alert('請選擇員工'); return }
    await supabase.from('annual_review_participants').insert({
      review_id: selectedReview.id,
      user_id: newParticipant.user_id,
      supervisor_id: newParticipant.supervisor_id || null
    })
    setNewParticipant({ user_id: '', supervisor_id: '' })
    fetchReviewParticipants(selectedReview.id)
  }

  async function handleRemoveParticipant(id) {
    if (!window.confirm('確定要移除這位參與者嗎？')) return
    await supabase.from('annual_review_participants').delete().eq('id', id)
    fetchReviewParticipants(selectedReview.id)
  }

  async function handleToggleReviewStatus(review) {
    await supabase.from('annual_reviews')
      .update({ status: review.status === 'active' ? 'closed' : 'active' })
      .eq('id', review.id)
    fetchAll()
  }

  if (loading) return <p style={{ color: '#6b7280' }}>載入中...</p>

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
        <button onClick={() => setTab('reviews')} style={{ ...tab === 'reviews' ? btnPrimary : btnSecondary }}>年度考核管理</button>
        <button onClick={() => setTab('templates')} style={{ ...tab === 'templates' ? btnPrimary : btnSecondary }}>考核模板管理</button>
      </div>

      {tab === 'templates' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h4 style={{ margin: 0, color: '#1f2937' }}>考核模板</h4>
            <button onClick={() => setShowAddTemplate(!showAddTemplate)} style={btnPrimary}>+ 新增模板</button>
          </div>

          {showAddTemplate && (
            <div style={{ ...cardStyle, marginBottom: '16px' }}>
              <div style={{ display: 'grid', gap: '12px', marginBottom: '12px' }}>
                <div>
                  <label style={labelStyle}>模板名稱 *</label>
                  <input value={newTemplate.name} onChange={e => setNewTemplate(p => ({ ...p, name: e.target.value }))} style={inputStyle} placeholder="例：一般員工考核模板" />
                </div>
                <div>
                  <label style={labelStyle}>說明</label>
                  <input value={newTemplate.description} onChange={e => setNewTemplate(p => ({ ...p, description: e.target.value }))} style={inputStyle} placeholder="選填" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={handleAddTemplate} style={btnPrimary}>新增</button>
                <button onClick={() => setShowAddTemplate(false)} style={btnSecondary}>取消</button>
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gap: '12px' }}>
            {templates.map(t => (
              <div key={t.id} style={cardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: editTemplate?.id === t.id ? '16px' : '0' }}>
                  <div>
                    <div style={{ fontWeight: '600', color: '#1f2937' }}>{t.name}</div>
                    {t.description && <div style={{ fontSize: '13px', color: '#6b7280' }}>{t.description}</div>}
                  </div>
                  <button onClick={() => {
                    setEditTemplate(t)
                    fetchTemplateQuestions(t.id)
                  }} style={btnSecondary}>設定題目</button>
                </div>

                {editTemplate?.id === t.id && (
                  <div>
                    <div style={{ marginBottom: '16px' }}>
                      {questions.map((q, i) => (
                        <div key={q.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', backgroundColor: '#f9fafb', borderRadius: '8px', marginBottom: '8px' }}>
                          <div>
                            <span style={{ fontSize: '13px', color: '#6b7280', marginRight: '8px' }}>{i + 1}.</span>
                            <span style={{ fontSize: '14px', color: '#374151' }}>{q.question_text}</span>
                            <span style={{ marginLeft: '8px', backgroundColor: q.question_type === 'score' ? '#EEF2FF' : '#F3F4F6', color: q.question_type === 'score' ? '#4F46E5' : '#6B7280', padding: '2px 8px', borderRadius: '4px', fontSize: '11px' }}>
                              {q.question_type === 'score' ? `評分 ${q.score_min}-${q.score_max}` : '文字'}
                            </span>
                          </div>
                          <button onClick={() => handleDeleteQuestion(q.id)} style={{ ...btnSecondary, color: '#EF4444', padding: '4px 10px', fontSize: '12px' }}>刪除</button>
                        </div>
                      ))}
                    </div>

                    <div style={{ backgroundColor: '#f9fafb', borderRadius: '8px', padding: '16px', marginBottom: '12px' }}>
                      <h5 style={{ margin: '0 0 12px', color: '#374151' }}>新增題目</h5>
                      <div style={{ display: 'grid', gap: '10px' }}>
                        <div>
                          <label style={labelStyle}>題目內容 *</label>
                          <input value={newQuestion.question_text} onChange={e => setNewQuestion(p => ({ ...p, question_text: e.target.value }))} style={inputStyle} placeholder="請輸入題目" />
                        </div>
                        <div>
                          <label style={labelStyle}>題目類型</label>
                          <select value={newQuestion.question_type} onChange={e => setNewQuestion(p => ({ ...p, question_type: e.target.value }))} style={inputStyle}>
                            <option value="text">文字題</option>
                            <option value="score">評分題</option>
                          </select>
                        </div>
                        {newQuestion.question_type === 'score' && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>最低分</label>
                              <input type="number" value={newQuestion.score_min} onChange={e => setNewQuestion(p => ({ ...p, score_min: Number(e.target.value) }))} style={inputStyle} />
                            </div>
                            <div>
                              <label style={labelStyle}>最高分</label>
                              <input type="number" value={newQuestion.score_max} onChange={e => setNewQuestion(p => ({ ...p, score_max: Number(e.target.value) }))} style={inputStyle} />
                            </div>
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                        <button onClick={handleAddQuestion} style={btnPrimary}>新增題目</button>
                        <button onClick={() => setEditTemplate(null)} style={btnSecondary}>完成</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'reviews' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h4 style={{ margin: 0, color: '#1f2937' }}>年度考核</h4>
            <button onClick={() => setShowAddReview(!showAddReview)} style={btnPrimary}>+ 新增考核</button>
          </div>

          {showAddReview && (
            <div style={{ ...cardStyle, marginBottom: '16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                <div>
                  <label style={labelStyle}>考核名稱 *</label>
                  <input value={newReview.title} onChange={e => setNewReview(p => ({ ...p, title: e.target.value }))} style={inputStyle} placeholder="例：2026 年度考核" />
                </div>
                <div>
                  <label style={labelStyle}>年度 *</label>
                  <input type="number" value={newReview.year} onChange={e => setNewReview(p => ({ ...p, year: Number(e.target.value) }))} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>考核模板 *</label>
                  <select value={newReview.template_id} onChange={e => setNewReview(p => ({ ...p, template_id: e.target.value }))} style={inputStyle}>
                    <option value="">請選擇模板</option>
                    {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>開始日期 *</label>
                  <input type="date" value={newReview.start_date} onChange={e => setNewReview(p => ({ ...p, start_date: e.target.value }))} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>結束日期 *</label>
                  <input type="date" value={newReview.end_date} onChange={e => setNewReview(p => ({ ...p, end_date: e.target.value }))} style={inputStyle} min={newReview.start_date} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={handleAddReview} style={btnPrimary}>新增</button>
                <button onClick={() => setShowAddReview(false)} style={btnSecondary}>取消</button>
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gap: '12px' }}>
            {reviews.map(r => (
              <div key={r.id} style={cardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: selectedReview?.id === r.id ? '16px' : '0' }}>
                  <div>
                    <div style={{ fontWeight: '600', color: '#1f2937', marginBottom: '4px' }}>{r.title}</div>
                    <div style={{ fontSize: '13px', color: '#6b7280' }}>
                      {r.year} 年度｜{r.start_date} ～ {r.end_date}｜模板：{r.template?.name}
                    </div>
                    <span style={{
                      marginTop: '6px', display: 'inline-block',
                      backgroundColor: r.status === 'active' ? '#D1FAE5' : '#F3F4F6',
                      color: r.status === 'active' ? '#10B981' : '#6B7280',
                      padding: '2px 10px', borderRadius: '20px', fontSize: '12px'
                    }}>
                      {r.status === 'active' ? '進行中' : '已結束'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => {
                      setSelectedReview(r)
                      fetchReviewParticipants(r.id)
                    }} style={btnSecondary}>管理人員</button>
                    <button onClick={() => handleToggleReviewStatus(r)} style={{ ...btnSecondary, color: r.status === 'active' ? '#EF4444' : '#10B981' }}>
                      {r.status === 'active' ? '結束考核' : '重新開放'}
                    </button>
                  </div>
                </div>

                {selectedReview?.id === r.id && (
                  <div>
                    <h5 style={{ color: '#374151', marginBottom: '12px' }}>參與人員管理</h5>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '8px', marginBottom: '12px', alignItems: 'end' }}>
                      <div>
                        <label style={labelStyle}>員工</label>
                        <select value={newParticipant.user_id} onChange={e => setNewParticipant(p => ({ ...p, user_id: e.target.value }))} style={inputStyle}>
                          <option value="">請選擇員工</option>
                          {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={labelStyle}>指定主管</label>
                        <select value={newParticipant.supervisor_id} onChange={e => setNewParticipant(p => ({ ...p, supervisor_id: e.target.value }))} style={inputStyle}>
                          <option value="">請選擇主管</option>
                          {users.filter(u => ['supervisor', 'boss', 'admin'].includes(u.role)).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                        </select>
                      </div>
                      <button onClick={handleAddParticipant} style={btnPrimary}>新增</button>
                    </div>

                    <div style={{ display: 'grid', gap: '8px' }}>
                      {participants.map(p => (
                        <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
                          <div>
                            <span style={{ fontWeight: '500', color: '#374151' }}>{p.user?.full_name}</span>
                            <span style={{ fontSize: '13px', color: '#9ca3af', marginLeft: '8px' }}>主管：{p.supervisor?.full_name || '未指定'}</span>
                          </div>
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                            <span style={{ fontSize: '11px', backgroundColor: p.self_submitted ? '#D1FAE5' : '#FEF3C7', color: p.self_submitted ? '#10B981' : '#D97706', padding: '2px 6px', borderRadius: '4px' }}>
                              {p.self_submitted ? '自評完成' : '待自評'}
                            </span>
                            <span style={{ fontSize: '11px', backgroundColor: p.supervisor_submitted ? '#D1FAE5' : '#FEF3C7', color: p.supervisor_submitted ? '#10B981' : '#D97706', padding: '2px 6px', borderRadius: '4px' }}>
                              {p.supervisor_submitted ? '評量完成' : '待評量'}
                            </span>
                            <button onClick={() => handleRemoveParticipant(p.id)} style={{ ...btnSecondary, color: '#EF4444', padding: '4px 8px', fontSize: '12px' }}>移除</button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => setSelectedReview(null)} style={{ ...btnSecondary, marginTop: '12px' }}>完成</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ===== Review 主元件 =====
function Review({ userProfile }) {
  const location = useLocation()
  const isBoss = userProfile?.role === 'boss'
  const isSupervisor = userProfile?.role === 'supervisor' || userProfile?.role === 'deputy_supervisor'
  const isAdmin = userProfile?.role === 'admin'

  const tabs = [{ path: '/review', label: '我的考核' }]
  if (isSupervisor || isBoss) tabs.push({ path: '/review/evaluate', label: '員工評量' })
  if (isBoss) tabs.push({ path: '/review/overview', label: '考核總覽' })
  if (isBoss) tabs.push({ path: '/review/admin', label: '考核設定' })

  return (
    <div>
      <h2 style={{ marginBottom: '20px', color: '#1f2937', fontSize: '22px' }}>年度考核</h2>
      <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: '2px solid #e5e7eb', flexWrap: 'wrap' }}>
        {tabs.map(tab => (
          <Link key={tab.path} to={tab.path} style={{
            padding: '10px 20px', textDecoration: 'none', fontSize: '14px', fontWeight: '500',
            color: location.pathname === tab.path ? '#4F46E5' : '#6b7280',
            borderBottom: location.pathname === tab.path ? '2px solid #4F46E5' : '2px solid transparent',
            marginBottom: '-2px'
          }}>
            {tab.label}
          </Link>
        ))}
      </div>

      <Routes>
        <Route index element={<MyReview userProfile={userProfile} />} />
        {(isSupervisor || isBoss) && <Route path="evaluate" element={<SupervisorReview userProfile={userProfile} />} />}
        {isBoss && <Route path="overview" element={<ReviewOverview userProfile={userProfile} />} />}
        {isBoss && <Route path="admin" element={<ReviewAdmin />} />}
      </Routes>
    </div>
  )
}

const cardStyle = { backgroundColor: 'white', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const labelStyle = { display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: '500', color: '#374151' }
const inputStyle = { width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' }
const btnPrimary = { padding: '8px 18px', backgroundColor: '#4F46E5', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px', fontWeight: '500' }
const btnSecondary = { padding: '8px 18px', backgroundColor: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px' }

export default Review