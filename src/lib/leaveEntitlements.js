import { supabase } from './supabase'

// The app has always treated a full leave day as 8 hours (LeaveForm records
// same-day leave in hours; multi-day leave is counted as workdays x 8), so
// quotas are stored in hours and only converted for display.
export const HOURS_PER_DAY = 8

export function isAnnualLeaveType(leaveType) {
  return !!leaveType?.name?.includes('特休')
}

// Per-employee agreed quotas, set by 財務 in 員工假期管理. Returns a map of
// leave_type_id -> quota in hours, containing ONLY the leave types that were
// explicitly switched to 手動調整; anything absent falls back to the company
// default (比照勞基法). RLS lets each employee read their own rows.
export async function fetchEntitlementOverrides(userId) {
  if (!userId) return {}
  const { data } = await supabase
    .from('user_leave_entitlements')
    .select('leave_type_id, mode, quota_hours')
    .eq('user_id', userId)
    .eq('mode', 'manual')

  const map = {}
  for (const row of data || []) {
    if (row.quota_hours != null) map[row.leave_type_id] = Number(row.quota_hours)
  }
  return map
}

// Shared by 假單管理 and 請假申請, which show the identical balance panel.
// `annualLeave` is the annual_leave_summary row (in DAYS); everything else
// comes from leave_types.annual_quota_hours (in HOURS). A manual override
// replaces whichever of those two would otherwise apply.
export function buildBalanceRows({ leaveTypes, leaveStats, annualLeave, overrides = {} }) {
  return (leaveTypes || []).map(lt => {
    const override = overrides[lt.id]

    if (isAnnualLeaveType(lt)) {
      return {
        id: lt.id,
        name: lt.name,
        color: lt.color,
        used: (annualLeave?.used || 0) * HOURS_PER_DAY,
        total: override != null ? override : (annualLeave?.entitled || 0) * HOURS_PER_DAY,
      }
    }

    const stat = (leaveStats || []).find(s => s.name === lt.name)
    return {
      id: lt.id,
      name: lt.name,
      color: lt.color,
      used: stat?.totalHours || 0,
      total: override != null ? override : (lt.annual_quota_hours ?? null),
    }
  })
}

// The homepage shows 特休 in days rather than as a full balance table, so it
// needs the override resolved back into days on its own.
export async function fetchAnnualLeaveDays(userId) {
  const [summaryRes, typesRes] = await Promise.all([
    supabase.from('annual_leave_summary').select('*').eq('user_id', userId).single(),
    supabase.from('leave_types').select('id, name'),
  ])

  const summary = summaryRes.data
  if (!summary) return null

  let entitled = summary.entitled_days || 0
  const annualType = (typesRes.data || []).find(isAnnualLeaveType)
  if (annualType) {
    const overrides = await fetchEntitlementOverrides(userId)
    const override = overrides[annualType.id]
    if (override != null) entitled = override / HOURS_PER_DAY
  }

  const used = summary.used_days || 0
  return { entitled, used, remaining: entitled - used }
}
