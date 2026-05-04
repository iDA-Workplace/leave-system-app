import { useState } from 'react'
import { supabase } from '../lib/supabase'
import * as XLSX from 'xlsx'

function ExportReport() {
  const [loading, setLoading] = useState(false)
  const [year, setYear] = useState(new Date().getFullYear())
  const [month, setMonth] = useState(0) // 0 = 全年

  const currentYear = new Date().getFullYear()
  const years = [currentYear - 1, currentYear, currentYear + 1]
  const months = [
    { value: 0, label: '全年' },
    { value: 1, label: '1 月' }, { value: 2, label: '2 月' },
    { value: 3, label: '3 月' }, { value: 4, label: '4 月' },
    { value: 5, label: '5 月' }, { value: 6, label: '6 月' },
    { value: 7, label: '7 月' }, { value: 8, label: '8 月' },
    { value: 9, label: '9 月' }, { value: 10, label: '10 月' },
    { value: 11, label: '11 月' }, { value: 12, label: '12 月' },
  ]

  async function handleExport() {
    setLoading(true)

    let startDate, endDate
    if (month === 0) {
      startDate = `${year}-01-01`
      endDate = `${year}-12-31`
    } else {
      const lastDay = new Date(year, month, 0).getDate()
      startDate = `${year}-${String(month).padStart(2, '0')}-01`
      endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`
    }

    const { data } = await supabase
      .from('leave_requests')
      .select(`
        *,
        requester:users!leave_requests_requester_id_fkey(full_name, email),
        leave_type:leave_types(name),
        proxy:users!leave_requests_proxy_user_id_fkey(full_name),
        approvals:leave_approvals(
          action, comment, created_at,
          approver:users!leave_approvals_approver_id_fkey(full_name)
        )
      `)
      .gte('start_date', startDate)
      .lte('end_date', endDate)
      .order('start_date')

    if (!data || data.length === 0) {
      alert('這段時間沒有假單資料')
      setLoading(false)
      return
    }

    const statusMap = {
      pending: '審核中',
      approved: '已核准',
      rejected: '已拒絕',
      returned: '已退回',
      withdrawn: '已收回'
    }

    const rows = data.map(lr => ({
      '申請人': lr.requester?.full_name || '',
      'Email': lr.requester?.email || '',
      '假別': lr.leave_type?.name || '',
      '開始日期': lr.start_date || '',
      '結束日期': lr.end_date || '',
      '開始時間': lr.start_time || '',
      '結束時間': lr.end_time || '',
      '時數': lr.hours || '',
      '狀態': statusMap[lr.status] || lr.status,
      '工作代理人': lr.proxy?.full_name || '',
      '請假原因': lr.reason || '',
      '申請時間': lr.created_at ? new Date(lr.created_at).toLocaleString('zh-TW') : '',
      '審核人': lr.approvals?.map(a => a.approver?.full_name).join(', ') || '',
      '審核結果': lr.approvals?.map(a => a.action === 'approved' ? '核准' : '拒絕').join(', ') || '',
      '審核備註': lr.approvals?.map(a => a.comment).filter(Boolean).join(', ') || '',
    }))

    const ws = XLSX.utils.json_to_sheet(rows)

    // 設定欄寬
    ws['!cols'] = [
      { wch: 12 }, { wch: 25 }, { wch: 10 },
      { wch: 12 }, { wch: 12 }, { wch: 10 },
      { wch: 10 }, { wch: 8 }, { wch: 10 },
      { wch: 12 }, { wch: 20 }, { wch: 20 },
      { wch: 15 }, { wch: 10 }, { wch: 20 },
    ]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '請假記錄')

    const fileName = month === 0
      ? `請假記錄_${year}年.xlsx`
      : `請假記錄_${year}年${month}月.xlsx`

    XLSX.writeFile(wb, fileName)
    setLoading(false)
  }

  return (
    <div style={{ maxWidth: '500px' }}>
      <h3 style={{ marginBottom: '20px', color: '#1f2937' }}>匯出請假報表</h3>

      <div style={{
        backgroundColor: 'white', borderRadius: '12px',
        padding: '24px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)'
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
          <div>
            <label style={labelStyle}>年份</label>
            <select value={year} onChange={e => setYear(Number(e.target.value))} style={inputStyle}>
              {years.map(y => <option key={y} value={y}>{y} 年</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>月份</label>
            <select value={month} onChange={e => setMonth(Number(e.target.value))} style={inputStyle}>
              {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
        </div>

        <div style={{
          backgroundColor: '#f9fafb', borderRadius: '8px',
          padding: '12px 16px', marginBottom: '20px',
          fontSize: '13px', color: '#6b7280'
        }}>
          匯出內容包含：申請人、假別、日期、時數、狀態、代理人、原因、審核記錄
        </div>

        <button
          onClick={handleExport}
          disabled={loading}
          style={{
            width: '100%', padding: '12px',
            backgroundColor: loading ? '#a5b4fc' : '#4F46E5',
            color: 'white', border: 'none', borderRadius: '8px',
            fontSize: '16px', fontWeight: '600',
            cursor: loading ? 'not-allowed' : 'pointer'
          }}
        >
          {loading ? '匯出中...' : '📥 匯出 Excel'}
        </button>
      </div>
    </div>
  )
}

const labelStyle = { display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: '500', color: '#374151' }
const inputStyle = { width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' }

export default ExportReport