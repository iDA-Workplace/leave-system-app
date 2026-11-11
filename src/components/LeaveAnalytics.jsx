import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { fetchAllRows } from '../lib/fetchAllRows'
import { computeLeaveStats } from '../lib/leaveStats'
import { leaveTypeName, HOURS_PER_DAY } from '../lib/leaveEntitlements'
import { Button, Card, EmptyState, Skeleton } from './ui'
import { useLanguage } from '../context/LanguageContext'
import './LeaveAnalytics.css'

/**
 * 請假統計（大數據總表）。使用者 2026-11 決定的內容：
 *   1 總覽數字、2 每人統計表、3 假別分布、4 月份趨勢、5 部門統計、
 *   9 特休使用狀況、10 職務代理人、12 HR 代登與異議（放在每人統計表裡）
 * 網頁上看，也可以匯出 Excel。只算已核准、不含離職同仁、WFH 另外算（見 lib/leaveStats.js）。
 *
 * scope：'all' = 全公司（HR）；之後主管的「團隊請假統計」會傳 { managerId } 只看直屬部屬。
 */
export default function LeaveAnalytics({ startDate, endDate, scope = 'all' }) {
  const { t, lang } = useLanguage()
  const [state, setState] = useState({ loading: true, error: null, data: null })

  const valid = !!startDate && !!endDate && startDate <= endDate
  const managerId = scope === 'all' ? null : scope?.managerId ?? null

  useEffect(() => {
    if (!valid) return
    let cancelled = false
    ;(async () => {
      // 換期間時：舊的數字先留著、變淡（stats--busy），新的讀完再換掉
      setState(s => ({ ...s, loading: true, error: null }))
      let usersQ = supabase.from('users').select('id, full_name, department, manager_id').eq('is_active', true).order('full_name')
      if (managerId) usersQ = usersQ.eq('manager_id', managerId)
      const [usersRes, leavesRes, summaryRes, typesRes, overridesRes] = await Promise.all([
        usersQ,
        // 分批讀：整年、全公司的假單很容易超過 1000 筆
        fetchAllRows(() => supabase.from('leave_requests')
          .select('id, requester_id, proxy_user_id, registered_by, disputed_at, hours, start_date, end_date, status, leave_type:leave_types(id, name, name_en, is_wfh, is_annual)')
          .eq('status', 'approved').lte('start_date', endDate).gte('end_date', startDate)
          .order('start_date').order('id')),
        supabase.from('annual_leave_summary').select('user_id, entitled_days, used_days'),
        supabase.from('leave_types').select('id, is_annual'),
        fetchAllRows(() => supabase.from('user_leave_entitlements').select('user_id, leave_type_id, mode, quota_hours').eq('mode', 'manual').order('user_id')),
      ])
      if (cancelled) return
      const error = usersRes.error || leavesRes.error
      if (error) { setState({ loading: false, error: error.message, data: null }); return }

      // 特休：HR 在「員工假期管理」手動調整過的，以調整後的天數為準（跟首頁、假單管理一致）
      const annualTypeId = (typesRes.data || []).find(x => x.is_annual)?.id
      const overrides = new Map((overridesRes.data || [])
        .filter(o => o.leave_type_id === annualTypeId && o.quota_hours != null)
        .map(o => [o.user_id, Number(o.quota_hours) / HOURS_PER_DAY]))
      const annual = (summaryRes.data || []).map(r => ({
        user_id: r.user_id,
        entitled: overrides.get(r.user_id) ?? r.entitled_days,
        used: r.used_days,
      }))

      setState({
        loading: false, error: null,
        data: computeLeaveStats({ leaves: leavesRes.data || [], users: usersRes.data || [], start: startDate, end: endDate, annual }),
      })
    })()
    return () => { cancelled = true }
  }, [startDate, endDate, managerId, valid])

  const stats = state.data
  const typeLabel = ty => (ty ? leaveTypeName(ty, lang) : t('stats_unknown_type'))
  const dept = d => d || t('stats_no_department')
  const pct = r => (r == null ? '—' : `${Math.round(r * 100)}%`)

  function exportExcel() {
    const wb = XLSX.utils.book_new()
    const add = (rows, name, widths) => {
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}])
      if (widths) ws['!cols'] = widths.map(wch => ({ wch }))
      XLSX.utils.book_append_sheet(wb, ws, name)
    }
    const o = stats.overview
    add([
      { [t('stats_x_item')]: t('stats_period'), [t('stats_x_value')]: `${startDate} ～ ${endDate}` },
      { [t('stats_x_item')]: t('stats_total_days'), [t('stats_x_value')]: o.totalDays },
      { [t('stats_x_item')]: t('stats_avg_days'), [t('stats_x_value')]: o.avgPerPerson },
      { [t('stats_x_item')]: t('stats_leave_count'), [t('stats_x_value')]: o.leaveCount },
      { [t('stats_x_item')]: t('stats_wfh_days'), [t('stats_x_value')]: o.wfhDays },
      { [t('stats_x_item')]: t('stats_headcount'), [t('stats_x_value')]: o.headcount },
      { [t('stats_x_item')]: t('stats_people_with_leave'), [t('stats_x_value')]: o.peopleWithLeave },
      { [t('stats_x_item')]: t('stats_x_rules'), [t('stats_x_value')]: t('stats_rules') },
    ], t('stats_s_overview'), [22, 60])
    add(stats.perPerson.map(p => ({
      [t('stats_col_name')]: p.user.full_name, [t('stats_col_department')]: dept(p.user.department),
      [t('stats_col_count')]: p.count, [t('stats_col_days')]: p.days,
      ...Object.fromEntries(stats.typeColumns.map(c => [typeLabel(c.type), p.byType[c.id] ?? 0])),
      [t('stats_col_wfh')]: p.wfhDays, [t('stats_col_per_month')]: p.perMonth,
      [t('stats_col_proxy')]: p.proxyCount, [t('stats_col_hr_registered')]: p.hrRegistered, [t('stats_col_disputed')]: p.disputed,
    })), t('stats_s_people'))
    add(stats.byType.map(x => ({
      [t('stats_col_type')]: typeLabel(x.type), [t('stats_col_count')]: x.count, [t('stats_col_days')]: x.days, [t('stats_col_share')]: pct(x.share),
    })), t('stats_s_types'), [14, 8, 10, 8])
    add(stats.byMonth.map(m => ({
      [t('stats_col_month')]: m.month, [t('stats_col_days')]: m.days, [t('stats_col_wfh')]: m.wfhDays,
    })), t('stats_s_months'), [10, 10, 10])
    add(stats.byDepartment.map(d => ({
      [t('stats_col_department')]: dept(d.department), [t('stats_col_headcount')]: d.headcount,
      [t('stats_col_days')]: d.days, [t('stats_col_avg')]: d.avg,
    })), t('stats_s_departments'), [14, 8, 10, 12])
    add(stats.annual.map(a => ({
      [t('stats_col_name')]: a.user.full_name, [t('stats_col_department')]: dept(a.user.department),
      [t('stats_col_entitled')]: a.entitled, [t('stats_col_used')]: a.used, [t('stats_col_remaining')]: a.remaining, [t('stats_col_rate')]: pct(a.rate),
    })), t('stats_s_annual'), [12, 12, 10, 10, 10, 10])
    add(stats.proxies.map(p => ({
      [t('stats_col_name')]: p.user.full_name, [t('stats_col_department')]: dept(p.user.department),
      [t('stats_col_proxy_count')]: p.count, [t('stats_col_proxy_days')]: p.days,
    })), t('stats_s_proxies'), [12, 12, 10, 10])
    XLSX.writeFile(wb, `${t('stats_file_name', { start: startDate, end: endDate })}.xlsx`)
  }

  if (!valid) return null
  if (state.loading && !stats) return <Card><Skeleton height="240px" /></Card>
  if (state.error) return <Card><EmptyState title={t('stats_err_load')} description={state.error} /></Card>
  if (!stats) return null

  const o = stats.overview
  return (
    <div className={`stats ${state.loading ? 'stats--busy' : ''}`}>
      <div className="stats__head">
        <div>
          <h2 className="stats__title">{t('stats_title')}</h2>
          <p className="stats__rules">{t('stats_rules')}</p>
        </div>
        <Button variant="outlined" onClick={exportExcel}>{t('stats_export')}</Button>
      </div>

      {/* 1 總覽 */}
      <div className="stats__tiles">
        <Tile label={t('stats_total_days')} value={o.totalDays} unit={t('stats_unit_days')} />
        <Tile label={t('stats_avg_days')} value={o.avgPerPerson} unit={t('stats_unit_days')} />
        <Tile label={t('stats_leave_count')} value={o.leaveCount} unit={t('stats_unit_count')} />
        <Tile label={t('stats_wfh_days')} value={o.wfhDays} unit={t('stats_unit_days')} />
      </div>
      <p className="stats__note">{t('stats_people_note', { n: o.headcount, k: o.peopleWithLeave })}</p>

      {o.leaveCount === 0 && o.wfhDays === 0 ? (
        <Card><EmptyState title={t('stats_empty')} /></Card>
      ) : (
        <>
          <div className="stats__grid">
            {/* 4 月份趨勢 */}
            <Card>
              <h3 className="stats__card-title">{t('stats_s_months')}</h3>
              <MonthColumns rows={stats.byMonth} unit={t('stats_unit_days')} monthSuffix={t('stats_month_suffix')} />
            </Card>
            {/* 3 假別分布 */}
            <Card>
              <h3 className="stats__card-title">{t('stats_s_types')}</h3>
              <Bars rows={stats.byType.map(x => ({
                key: x.id, label: typeLabel(x.type), value: x.days,
                text: t('stats_type_line', { days: x.days, n: x.count, pct: pct(x.share) }),
              }))} />
            </Card>
            {/* 5 部門統計 */}
            <Card>
              <h3 className="stats__card-title">{t('stats_s_departments')}</h3>
              <p className="stats__card-sub">{t('stats_dept_sub')}</p>
              <Bars rows={stats.byDepartment.map(d => ({
                key: d.department, label: dept(d.department), value: d.avg,
                text: t('stats_dept_line', { avg: d.avg, n: d.headcount, days: d.days }),
              }))} />
            </Card>
            {/* 10 職務代理人 */}
            <Card>
              <h3 className="stats__card-title">{t('stats_s_proxies')}</h3>
              {stats.proxies.length === 0 ? <p className="stats__card-sub">{t('stats_no_proxies')}</p> : (
                <Bars rows={stats.proxies.slice(0, 10).map(p => ({
                  key: p.user.id, label: p.user.full_name, value: p.count,
                  text: t('stats_proxy_line', { n: p.count, days: p.days }),
                }))} />
              )}
            </Card>
          </div>

          {/* 2 每人統計表（含 12 HR 代登、異議） */}
          <Card>
            <h3 className="stats__card-title">{t('stats_s_people')}</h3>
            <div className="stats__table-wrap">
              <table className="stats__table">
                <thead>
                  <tr>
                    <th>{t('stats_col_name')}</th><th>{t('stats_col_department')}</th>
                    <th className="num">{t('stats_col_count')}</th><th className="num">{t('stats_col_days')}</th>
                    {stats.typeColumns.map(c => <th key={c.id} className="num">{typeLabel(c.type)}</th>)}
                    <th className="num">{t('stats_col_wfh')}</th><th className="num">{t('stats_col_per_month')}</th>
                    <th className="num">{t('stats_col_proxy')}</th><th className="num">{t('stats_col_hr_registered')}</th>
                    <th className="num">{t('stats_col_disputed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.perPerson.map(p => (
                    <tr key={p.user.id}>
                      <td>{p.user.full_name}</td><td>{dept(p.user.department)}</td>
                      <td className="num">{p.count}</td><td className="num strong">{p.days}</td>
                      {stats.typeColumns.map(c => <td key={c.id} className="num">{p.byType[c.id] ?? '—'}</td>)}
                      <td className="num">{p.wfhDays || '—'}</td><td className="num">{p.perMonth}</td>
                      <td className="num">{p.proxyCount || '—'}</td><td className="num">{p.hrRegistered || '—'}</td>
                      <td className="num">{p.disputed || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* 9 特休使用狀況（今年；跟查詢期間無關） */}
      <Card>
        <h3 className="stats__card-title">{t('stats_s_annual')}</h3>
        <p className="stats__card-sub">{t('stats_annual_sub', { y: new Date().getFullYear() })}</p>
        <div className="stats__table-wrap">
          <table className="stats__table">
            <thead>
              <tr>
                <th>{t('stats_col_name')}</th><th>{t('stats_col_department')}</th>
                <th className="num">{t('stats_col_entitled')}</th><th className="num">{t('stats_col_used')}</th>
                <th className="num">{t('stats_col_remaining')}</th><th>{t('stats_col_rate')}</th>
              </tr>
            </thead>
            <tbody>
              {stats.annual.map(a => (
                <tr key={a.user.id}>
                  <td>{a.user.full_name}</td><td>{dept(a.user.department)}</td>
                  <td className="num">{a.entitled}</td><td className="num">{a.used}</td>
                  <td className="num strong">{a.remaining}</td>
                  <td>
                    <div className="stats__meter" title={pct(a.rate)}>
                      <span style={{ width: `${Math.min(100, Math.round((a.rate ?? 0) * 100))}%` }} />
                    </div>
                    <span className="stats__meter-text">{pct(a.rate)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

function Tile({ label, value, unit }) {
  return (
    <div className="stats__tile">
      <div className="stats__tile-label">{label}</div>
      <div className="stats__tile-value">{value}<span>{unit}</span></div>
    </div>
  )
}

/** 橫條：一個系列、依數值長短；數字直接寫在條旁邊（不只靠顏色） */
function Bars({ rows }) {
  const max = Math.max(0, ...rows.map(r => r.value))
  return (
    <ul className="stats__bars">
      {rows.map(r => (
        <li key={r.key} title={`${r.label}：${r.text}`}>
          <span className="stats__bar-label">{r.label}</span>
          <span className="stats__bar-track">
            <span className="stats__bar" style={{ width: max ? `${Math.max(2, (r.value / max) * 100)}%` : 0 }} />
          </span>
          <span className="stats__bar-value">{r.text}</span>
        </li>
      ))}
    </ul>
  )
}

/** 月份直條：每月請假天數（不含 WFH），數字在條上方 */
function MonthColumns({ rows, unit, monthSuffix }) {
  const max = useMemo(() => Math.max(0, ...rows.map(r => r.days)), [rows])
  // 期間跨年時月份要帶年份，不然 1 月、12 月分不出是哪一年
  const multiYear = rows.length > 0 && rows[0].month.slice(0, 4) !== rows[rows.length - 1].month.slice(0, 4)
  return (
    <div className="stats__cols" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
      {rows.map(r => (
        <div key={r.month} className="stats__col" title={`${r.month}：${r.days} ${unit}`}>
          <span className="stats__col-value">{r.days || ''}</span>
          <span className="stats__col-bar" style={{ height: max ? `${Math.max(r.days ? 3 : 0, (r.days / max) * 100)}%` : 0 }} />
          <span className="stats__col-label">
            {multiYear ? `${r.month.slice(2, 4)}/${Number(r.month.slice(5))}` : Number(r.month.slice(5))}
            {!multiYear && <span className="stats__col-unit">{monthSuffix}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}
