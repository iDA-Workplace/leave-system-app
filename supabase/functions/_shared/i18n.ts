// Slack 訊息的中英文字典。
//
// 跟前端 src/i18n/translations.js 是同樣的做法（t(key, params) + {name} 佔位符），
// 但這是完全獨立的一份 —— Slack 訊息的語氣、標點、emoji 位置都跟網頁介面不是
// 同一回事，硬要共用同一份字典只會兩邊互相牽制。
//
// 語言的決定方式：每一則通知都是「發給誰」就照那個人 users.language 的設定，
// 不是看誰觸發了這個動作。核准假單的人可能習慣中文，但假單是要發給可能設定
// 英文的申請人 —— 一則訊息只會用收件人自己的語言，絕對不會把兩種語言混在
// 同一則裡。
//
// 例外是「公開頻道」的訊息（每日請假名單、臨時請假補發公告）：那些是一次發給
// 一整個頻道，沒有「單一收件人」可以決定語言，只能固定一種。用環境變數
// SLACK_CHANNEL_LANGUAGE 決定（預設 zh，未設定就照舊全部中文，行為不變）。

export type Lang = 'zh' | 'en'

export function normalizeLang(v: string | null | undefined): Lang {
  return v === 'en' ? 'en' : 'zh'
}

const T = {
  zh: {
    unknown_person: '（未知人員）',
    leave_fallback_type: '請假',
    all_day: '整日',
    full_day_marker: '　整天',
    days_unit: '{n} 天',
    hours_unit: '{n} 小時',
    multiday_range: '{range} 連假中',

    detail_requester: '*申請人:* {name}',
    detail_type: '*假別:* {type}',
    detail_date: '*休假日期:* {date}',
    detail_time: '*休假時間:* {time}',
    detail_hours: '*時數:* {duration}',
    detail_proxy: '*職務代理人:* {name}',
    detail_reason: '*事由:* {reason}',
    detail_reject_reason: '*駁回原因:* {reason}',

    err_missing_request_id: '缺少 request_id',
    err_fetch_leave: '讀取假單失敗：{msg}',
    err_unknown_type: '未知的通知類型：{type}',
    err_fetch_steps: '讀取簽核關卡失敗：{msg}',
    err_fetch_targets: '讀取通知對象失敗：{msg}',

    no_approver_slack_id: '這一關的簽核人沒有設定 Slack ID',
    new_request_text: '{name} 送出了一張待您審核的假單',
    new_request_heading: ':memo: *有一張假單待您審核*\n{detail}',
    btn_approve: '核准',
    btn_reject: '駁回',
    review_on_web_hint: '也可以到請假系統的「首頁 → 待審核假單」處理。',

    approved_text: '您的假單已核准',
    approved_heading: ':white_check_mark: *假單已核准*\n{detail}',
    channel_not_set: '未設定 SLACK_LEAVE_CHANNEL，略過頻道公告',
    today_leave_text: '{name} 今天請假',
    today_leave_heading: ':bell: *今日臨時請假*\n{line}',
    today_leave_note: '此假單於今日上午的請假公告發出後才核准，故補發通知。',
    channel_posted: 'posted',
    channel_pending_digest: '尚未到彙整時間，將由每日公告一併發出',
    channel_not_today: '假期不含今天，不需公告',

    no_requester_slack_id: '申請人沒有設定 Slack ID',
    rejected_text: '您的假單已被拒絕',
    rejected_heading: ':x: *假單未通過*\n{detail}',
    rejected_detail_hint: '詳細原因請到請假系統的「假單管理」查看。',

    no_proxy_or_slack_id: '沒有職務代理人或代理人未設定 Slack ID',
    proxy_already_notified: '代理人已在其他通知對象中，不重複發送',
    proxy_text: '您被指定為 {name} 的職務代理人',
    proxy_heading: ':handshake: *您被指定為職務代理人*\n{detail}',
    proxy_note: '這張假單已核准，該時段請協助代理其職務。',
    proxy_sent: 'sent',

    weekday_0: '日', weekday_1: '一', weekday_2: '二', weekday_3: '三',
    weekday_4: '四', weekday_5: '五', weekday_6: '六',
    digest_heading: ':palm_tree: *{month}/{day}（{weekday}）今日請假名單*',
    digest_group_fullday: '全天',
    digest_group_morning: '上午',
    digest_group_afternoon: '下午',
    digest_group_heading: '*■ {label}*\n{lines}',
    digest_footer: '由請假系統自動發送。完整行事曆請見系統首頁。',
    digest_summary_text: '今日請假名單（共 {n} 筆）',

    overdue_reason: '逾期未審核，系統自動退回',
    overdue_text: '您的請假申請已逾期退回',
    overdue_heading: ':warning: *您的請假申請已逾期退回*\n{detail}',
    overdue_note: '此假單因 {n} 天內未獲審核，已自動退回。請重新送出申請。',
    reminder_text: '{name} 的假單待您審核',
    reminder_heading: ':bell: *待審假單提醒*\n{detail}',
    reminder_note_new: '今天送出，尚未處理',
    reminder_note_waited: '已等待 {n} 天',

    no_account_text: '找不到您的系統帳號',
    no_account_heading: ':warning: 找不到對應的系統帳號，請聯繫管理員在「員工帳號管理」補上您的 Slack User ID。',
    ask_leave_prompt_text: '要請假嗎？點下面的按鈕填寫假單。',
    ask_leave_prompt_heading: ':memo: 要請假嗎？點下面的按鈕填寫假單。',
    btn_fill_leave_form: '填寫假單',

    modal_leave_title: '請假申請',
    modal_submit: '送出',
    modal_cancel: '取消',
    field_leave_type: '假別',
    field_leave_type_placeholder: '請選擇',
    field_start_date: '開始日期',
    field_end_date: '結束日期',
    field_start_time: '開始時間',
    field_end_time: '結束時間',
    field_multiday_hint: '跨日請假時會忽略時間，整天計算',
    field_proxy: '職務代理人',
    field_proxy_placeholder: '（可不填）',
    field_reason: '事由',
    modal_attachment_hint: '附件請到請假系統網頁補上（Slack 表單不支援上傳檔案）。',

    err_end_before_start: '結束日期不能早於開始日期',
    err_end_time_before_start: '結束時間必須晚於開始時間',
    err_no_flow: '您尚未被指定審核流程，請聯繫管理員設定。',
    err_submit_failed: '送出失敗：{msg}',
    quota_exceeded: '{type}額度不足：本次申請 {requested} 小時，但只剩 {remaining} 小時（年度額度 {quota} 小時，已使用或審核中 {used} 小時）。',

    leave_submitted_text: '假單已送出',
    leave_submitted_heading: ':white_check_mark: *假單已送出*\n{detail}',
    leave_submitted_no_flow: '此流程不需簽核，已自動核准。',
    leave_submitted_pending: '已通知簽核人，審核結果會在這裡通知您。',

    modal_reject_title: '駁回假單',
    modal_reject_submit: '送出駁回',
    field_reject_reason: '駁回原因',
    err_reject_reason_required: '請填寫駁回原因',

    approved_replace_text: '已核准',
    approved_replace_heading: ':white_check_mark: *已核准*\n{detail}',
    approved_stamp_final: '您已於 {stamp} 核准，流程已完成',
    approved_stamp_next: '您已於 {stamp} 核准，已轉交下一關',
    rejected_replace_text: '已駁回',
    rejected_replace_heading: ':x: *已駁回*\n{detail}',

    guard_not_found: '找不到這張假單，可能已被刪除。',
    guard_already_handled: '這張假單{status}，已由其他方式處理完畢，不需要再動作。',
    guard_no_flow: '這張假單沒有設定審核流程，請到系統處理。',
    guard_not_your_turn: '目前輪到第 {n} 關的簽核人處理，不是您。',
    status_approved: '已核准',
    status_rejected: '已駁回',
    status_withdrawn: '已由申請人收回',
    status_returned: '已逾期退回',

    balance_no_account: '找不到對應的系統帳號，請聯繫管理員在「員工帳號管理」補上您的 Slack User ID。',
    balance_text: '{name} 的假期額度',
    balance_heading: ':bar_chart: *您的假期額度*（{year} 年度）\n{lines}',
    balance_no_limit: '• *{type}*　無年度上限',
    balance_line: '• *{type}*　可用 {n} 小時{days}',
    balance_days_suffix: '（{days} 天）',
    balance_days_hours_suffix: '（{days} 天 {hours} 小時）',
    balance_footer: '可用額度已扣除還在等簽核的假單。',
  },
  en: {
    unknown_person: '(unknown)',
    leave_fallback_type: 'Leave',
    all_day: 'All day',
    full_day_marker: '　All day',
    days_unit: '{n} days',
    hours_unit: '{n} hrs',
    multiday_range: '{range}',

    detail_requester: '*Employee:* {name}',
    detail_type: '*Leave type:* {type}',
    detail_date: '*Dates:* {date}',
    detail_time: '*Time:* {time}',
    detail_hours: '*Duration:* {duration}',
    detail_proxy: '*Proxy:* {name}',
    detail_reason: '*Reason:* {reason}',
    detail_reject_reason: '*Reason for rejection:* {reason}',

    err_missing_request_id: 'Missing request_id',
    err_fetch_leave: 'Could not load the leave request: {msg}',
    err_unknown_type: 'Unknown notification type: {type}',
    err_fetch_steps: 'Could not load the approval step: {msg}',
    err_fetch_targets: 'Could not load notification recipients: {msg}',

    no_approver_slack_id: 'The approver for this step has no Slack ID set',
    new_request_text: '{name} submitted a leave request for your review',
    new_request_heading: ':memo: *A leave request needs your review*\n{detail}',
    btn_approve: 'Approve',
    btn_reject: 'Reject',
    review_on_web_hint: 'You can also handle this from “Home → Pending Approvals” in the leave system.',

    approved_text: 'Your leave request was approved',
    approved_heading: ':white_check_mark: *Leave request approved*\n{detail}',
    channel_not_set: 'SLACK_LEAVE_CHANNEL is not set, skipping the channel announcement',
    today_leave_text: '{name} is on leave today',
    today_leave_heading: ':bell: *Same-day leave*\n{line}',
    today_leave_note: 'Approved after this morning’s leave announcement, so this is a follow-up notice.',
    channel_posted: 'posted',
    channel_pending_digest: 'Not yet time for the daily digest — will be included in it',
    channel_not_today: 'The leave period does not cover today, no announcement needed',

    no_requester_slack_id: 'The requester has no Slack ID set',
    rejected_text: 'Your leave request was rejected',
    rejected_heading: ':x: *Leave request rejected*\n{detail}',
    rejected_detail_hint: 'See the “Leave Management” page in the leave system for details.',

    no_proxy_or_slack_id: 'No proxy set, or the proxy has no Slack ID',
    proxy_already_notified: 'The proxy is already in the notification list, not sending again',
    proxy_text: 'You have been assigned as {name}’s proxy',
    proxy_heading: ':handshake: *You’ve been assigned as a proxy*\n{detail}',
    proxy_note: 'This leave request has been approved — please cover their responsibilities during that time.',
    proxy_sent: 'sent',

    weekday_0: 'Sun', weekday_1: 'Mon', weekday_2: 'Tue', weekday_3: 'Wed',
    weekday_4: 'Thu', weekday_5: 'Fri', weekday_6: 'Sat',
    digest_heading: ':palm_tree: *Out today ({month}/{day}, {weekday})*',
    digest_group_fullday: 'All day',
    digest_group_morning: 'Morning',
    digest_group_afternoon: 'Afternoon',
    digest_group_heading: '*■ {label}*\n{lines}',
    digest_footer: 'Posted automatically by the leave system. See the homepage for the full calendar.',
    digest_summary_text: 'Out today ({n} people)',

    overdue_reason: 'Automatically returned — not reviewed in time',
    overdue_text: 'Your leave request was returned (overdue)',
    overdue_heading: ':warning: *Your leave request was returned (overdue)*\n{detail}',
    overdue_note: 'This request was not reviewed within {n} days and was automatically returned. Please submit it again.',
    reminder_text: '{name}’s leave request needs your review',
    reminder_heading: ':bell: *Pending approval reminder*\n{detail}',
    reminder_note_new: 'Submitted today, not yet reviewed',
    reminder_note_waited: 'Waiting for {n} days',

    no_account_text: 'We could not find your account',
    no_account_heading: ':warning: We could not match you to an account. Ask an administrator to add your Slack User ID under “Employee Accounts”.',
    ask_leave_prompt_text: 'Want to request leave? Click the button below to fill out the form.',
    ask_leave_prompt_heading: ':memo: Want to request leave? Click the button below to fill out the form.',
    btn_fill_leave_form: 'Fill out leave request',

    modal_leave_title: 'Leave Request',
    modal_submit: 'Submit',
    modal_cancel: 'Cancel',
    field_leave_type: 'Leave type',
    field_leave_type_placeholder: 'Select',
    field_start_date: 'Start date',
    field_end_date: 'End date',
    field_start_time: 'Start time',
    field_end_time: 'End time',
    field_multiday_hint: 'Time is ignored for multi-day leave — it is counted as full days',
    field_proxy: 'Proxy',
    field_proxy_placeholder: '(optional)',
    field_reason: 'Reason',
    modal_attachment_hint: 'Attach files from the leave system website — the Slack form does not support uploads.',

    err_end_before_start: 'End date cannot be earlier than start date',
    err_end_time_before_start: 'End time must be later than start time',
    err_no_flow: 'No approval flow has been assigned to you. Please contact an administrator.',
    err_submit_failed: 'Submission failed: {msg}',
    quota_exceeded: 'Not enough {type} left: this request is {requested} hours, but only {remaining} hours remain (annual quota {quota} hours; {used} hours already used or pending).',

    leave_submitted_text: 'Leave request submitted',
    leave_submitted_heading: ':white_check_mark: *Leave request submitted*\n{detail}',
    leave_submitted_no_flow: 'No approval is required for this flow — it was approved automatically.',
    leave_submitted_pending: 'The approver has been notified. You’ll be notified here with the result.',

    modal_reject_title: 'Reject Leave Request',
    modal_reject_submit: 'Submit rejection',
    field_reject_reason: 'Reason for rejection',
    err_reject_reason_required: 'Please enter a reason for rejection',

    approved_replace_text: 'Approved',
    approved_replace_heading: ':white_check_mark: *Approved*\n{detail}',
    approved_stamp_final: 'You approved this at {stamp} — the review is complete',
    approved_stamp_next: 'You approved this at {stamp} — passed to the next approver',
    rejected_replace_text: 'Rejected',
    rejected_replace_heading: ':x: *Rejected*\n{detail}',

    guard_not_found: 'This leave request could not be found — it may have been deleted.',
    guard_already_handled: 'This leave request is {status} and has already been handled elsewhere — no action needed.',
    guard_no_flow: 'This leave request has no approval flow set. Please handle it in the system.',
    guard_not_your_turn: 'It is currently step {n}’s approver’s turn, not yours.',
    status_approved: 'approved',
    status_rejected: 'rejected',
    status_withdrawn: 'withdrawn by the requester',
    status_returned: 'returned as overdue',

    balance_no_account: 'We could not match you to an account. Ask an administrator to add your Slack User ID under “Employee Accounts”.',
    balance_text: '{name}’s leave balance',
    balance_heading: ':bar_chart: *Your leave balance* ({year})\n{lines}',
    balance_no_limit: '• *{type}*　no annual limit',
    balance_line: '• *{type}*　{n} hours available{days}',
    balance_days_suffix: ' ({days} days)',
    balance_days_hours_suffix: ' ({days} days {hours} hrs)',
    balance_footer: 'Available quota already excludes leave that is still pending approval.',
  },
} as const

export type MsgKey = keyof typeof T['zh']

export function t(lang: Lang, key: MsgKey, params?: Record<string, string | number>): string {
  let text: string = T[lang]?.[key] ?? T.zh[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

const WEEKDAY_KEYS = ['weekday_0', 'weekday_1', 'weekday_2', 'weekday_3', 'weekday_4', 'weekday_5', 'weekday_6'] as const

/** getUTCDay()／getDay() 的 0-6 轉成對應的字典 key，避免呼叫端自己拼字串。 */
export function weekdayKey(day: number): MsgKey {
  return WEEKDAY_KEYS[day] ?? 'weekday_0'
}
