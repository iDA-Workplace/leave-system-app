import { useState } from 'react'
import { supabase } from '../lib/supabase'
import * as XLSX from 'xlsx'
import { Button, Card, PageHeader, TextField } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'
import { leaveTypeName } from '../lib/leaveEntitlements'
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
  const { t, lang } = useLanguage()

  async function handleExport() {
    if (!startDate || !endDate) { showToast(t('export_err_dates'), { tone: 'error' }); return }
    if (endDate < startDate) { showToast(t('leaveform_err_date_order'), { tone: 'error' }); return }

    setLoading(true)

    const { data } = await supabase
      .from('leave_requests')
      .select(`
        *,
        requester:users!leave_requests_requester_id_fkey(full_name, email),
        leave_type:leave_types(*),
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
      showToast(t('export_err_no_data'), { tone: 'error' })
      setLoading(false)
      return
    }

    // 報表欄位跟著介面語言走：切成英文的人拿到的檔案就該是英文表頭，
    // 否則匯出來還是得找人翻。假別名稱用 leave_types.name_en。
    const locale = lang === 'en' ? 'en-US' : 'zh-TW'
    const rows = data.map(lr => ({
      [t('xls_col_requester')]: lr.requester?.full_name || '',
      [t('xls_col_email')]: lr.requester?.email || '',
      [t('xls_col_leave_type')]: leaveTypeName(lr.leave_type, lang),
      [t('xls_col_start_date')]: lr.start_date || '',
      [t('xls_col_end_date')]: lr.end_date || '',
      [t('xls_col_start_time')]: lr.start_time || '',
      [t('xls_col_end_time')]: lr.end_time || '',
      [t('xls_col_hours')]: lr.hours || '',
      [t('xls_col_status')]: lr.status ? t(`status_${lr.status}`) : '',
      [t('xls_col_proxy')]: lr.proxy?.full_name || '',
      [t('xls_col_reason')]: lr.reason || '',
      [t('xls_col_created_at')]: lr.created_at ? new Date(lr.created_at).toLocaleString(locale) : '',
      [t('xls_col_approvers')]: lr.approvals?.map(a => a.approver?.full_name).join(', ') || '',
      [t('xls_col_decisions')]: lr.approvals?.map(a => a.action === 'approved' ? t('myleaves_action_approved') : t('myleaves_action_rejected')).join(', ') || '',
      [t('xls_col_comments')]: lr.approvals?.map(a => a.comment).filter(Boolean).join(', ') || '',
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
    XLSX.utils.book_append_sheet(wb, ws, t('xls_sheet_name'))

    const fileName = t('xls_file_name', { start: startDate, end: endDate }) + '.xlsx'

    XLSX.writeFile(wb, fileName)
    setLoading(false)
  }

  return (
    <div className="export-report-page">
      <PageHeader title={t('export_title')} />

      <Card>
        <div className="export-report-grid">
          <TextField label={t('export_start_date')} type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          <TextField label={t('export_end_date')} type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} />
        </div>

        <div className="export-report-hint">{t('export_hint')}</div>

        <Button block loading={loading} onClick={handleExport}>
          {loading ? t('export_exporting') : t('export_button')}
        </Button>
      </Card>
    </div>
  )
}

export default ExportReport
