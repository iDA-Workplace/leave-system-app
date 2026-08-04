import { useState } from 'react'
import { supabase } from '../lib/supabase'
import * as XLSX from 'xlsx'
import { Button, Card, PageHeader, TextField } from '../components/ui'
import { useToast } from '../context/ToastContext'
import './ExportReport.css'

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function ExportReport() {
  const [loading, setLoading] = useState(false)
  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setMonth(0, 1)
    return toISODate(d)
  })
  const [endDate, setEndDate] = useState(() => toISODate(new Date()))
  const { showToast } = useToast()

  async function handleExport() {
    if (!startDate || !endDate) { showToast('請選擇起訖日期', { tone: 'error' }); return }
    if (endDate < startDate) { showToast('結束日期不能早於開始日期', { tone: 'error' }); return }

    setLoading(true)

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

    const fileName = `請假記錄_${startDate}_至_${endDate}.xlsx`

    XLSX.writeFile(wb, fileName)
    setLoading(false)
  }

  return (
    <div className="export-report-page">
      <PageHeader title="匯出請假報表" />

      <Card>
        <div className="export-report-grid">
          <TextField label="起始日期" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          <TextField label="結束日期" type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} />
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
