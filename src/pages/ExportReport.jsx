import { useState } from 'react'
import { supabase } from '../lib/supabase'
import * as XLSX from 'xlsx'
import { Button, Card, PageHeader, Select } from '../components/ui'
import { useToast } from '../context/ToastContext'
import './ExportReport.css'

function ExportReport() {
  const [loading, setLoading] = useState(false)
  const [year, setYear] = useState(new Date().getFullYear())
  const [month, setMonth] = useState(0) // 0 = 全年
  const { showToast } = useToast()

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
      showToast('這段時間沒有假單資料', { tone: 'error' })
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
    <div className="export-report-page">
      <PageHeader title="匯出請假報表" />

      <Card>
        <div className="export-report-grid">
          <Select label="年份" value={year} onChange={e => setYear(Number(e.target.value))}>
            {years.map(y => <option key={y} value={y}>{y} 年</option>)}
          </Select>
          <Select label="月份" value={month} onChange={e => setMonth(Number(e.target.value))}>
            {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        </div>

        <div className="export-report-hint">
          匯出內容包含：申請人、假別、日期、時數、狀態、代理人、原因、審核記錄
        </div>

        <Button block loading={loading} onClick={handleExport}>
          {loading ? '匯出中...' : '📥 匯出 Excel'}
        </Button>
      </Card>
    </div>
  )
}

export default ExportReport
