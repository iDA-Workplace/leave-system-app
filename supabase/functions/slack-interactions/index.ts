// Slack 互動：在 Slack 裡送假單、在 Slack 裡審核假單。
//
// ⚠️ 這支跟另外三支 function 的結構不一樣：它「不」拆 _shared 共用檔，整支
// 是自給自足的單一檔案。原因是這支程式碼量大，如果比照其他支維護
// index.ts + standalone.ts 兩份副本，兩份遲早會改到不一致 —— 而這支牽涉
// 權限判斷，不一致的後果比其他支嚴重。單一檔案同時適用網頁編輯器貼上與
// CLI 部署，沒有副本要同步。
//
// ⚠️ 同理，下面的中英文字典是 _shared/i18n.ts 的複本，不是 import。改動
// 訊息文字時兩邊都要跟著改 —— 這是刻意接受的重複，換來的是這支跟其他三支
// 一樣可以整支貼進 Supabase 網頁編輯器，不必依賴多檔案匯入。
//
// ── 這支處理的三種請求 ─────────────────────────────────────────────
// 1. Events API（application/json）
//    - url_verification：Slack 設定 Request URL 時的握手
//    - message.im：同事私訊 bot 打「請假」→ 回一則帶按鈕的訊息
//      （Slack 規定：打字「不會」給 trigger_id，沒有 trigger_id 就不能彈出
//       表單視窗，所以一定要先回一顆按鈕讓使用者點）
// 2. Interactivity（application/x-www-form-urlencoded，payload=<json>）
//    - block_actions：點「填寫假單」「核准」「駁回」按鈕
//    - view_submission：送出假單表單、送出駁回理由
//
// ── 語言 ───────────────────────────────────────────────────────────
// 每則訊息都照「收件人自己」users.language 的設定發，不是看誰觸發動作 ——
// 核准假單的主管可能是中文介面，但假單是發給可能設定英文的申請人。對不到
// 系統帳號的人（resolveUser 找不到）一律用中文，因為那種情況根本不知道
// 對方是誰，無從得知語言偏好。公開頻道公告（今日臨時請假）沒有單一收件人，
// 語言固定，見 SLACK_CHANNEL_LANGUAGE（未設定＝中文，行為與改版前一致）。
//
// ── 資安 ───────────────────────────────────────────────────────────
// 這條路徑是「Slack 反過來打進我們的資料庫」，沒有任何登入狀態，用的是
// service role key（繞過所有 RLS）。所以每一個請求都必須：
//   a. 驗證簽章確認真的來自 Slack（不然任何人都能偽造請求核准假單）
//   b. 把 Slack user id 對應回系統帳號，對不到就拒絕
//   c. 動作發生的當下「重新」檢查權限與狀態，不信任按鈕上帶的任何資訊
//      （按鈕可能是三天前發的，那張假單早就在網頁上被處理掉了）

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SLACK_API = 'https://slack.com/api'
const HOURS_PER_DAY = 8

function requireEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`缺少環境變數 ${name}`)
  return v
}

function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )
}

// ===== 中英文字典（_shared/i18n.ts 的複本，見檔頭說明）=====

type Lang = 'zh' | 'en'

function normalizeLang(v: string | null | undefined): Lang {
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

    new_request_text: '{name} 送出了一張待您審核的假單',
    new_request_heading: ':memo: *有一張假單待您審核*\n{detail}',
    btn_approve: '核准',
    btn_reject: '駁回',

    today_leave_text: '{name} 今天請假',
    today_leave_heading: ':bell: *今日臨時請假*\n{line}',
    today_leave_note: '此假單於今日上午的請假公告發出後才核准，故補發通知。',
    // 在家工作另外一組字：他有在工作，只是不在辦公室。用「請假」的字眼公告
    // 會讓同事以為今天找不到他。
    today_wfh_text: '{name} 今天在家工作',
    today_wfh_heading: ':house_with_garden: *今日在家工作*\n{line}',
    today_wfh_note: '此申請於今日上午的公告發出後才核准，故補發通知。仍可照常聯繫。',

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
    wfh_no_proxy_note: ':information_source: 在家工作不需要指定職務代理人 —— 人有在上班，只是不在辦公室。',
    field_reason: '事由',
    modal_attachment_hint: '附件請到請假系統網頁補上（Slack 表單不支援上傳檔案）。',

    err_end_before_start: '結束日期不能早於開始日期',
    err_end_time_before_start: '結束時間必須晚於開始時間',
    err_no_flow: '您尚未被指定審核流程，請聯繫管理員設定。',
    err_submit_failed: '送出失敗：{msg}',

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
    approved_dm_text: '您的假單已核准',
    approved_dm_heading: ':white_check_mark: *假單已核准*\n{detail}',
    rejected_dm_text: '您的假單已被駁回',
    rejected_dm_heading: ':x: *假單未通過*\n{detail}',

    proxy_text: '您被指定為 {name} 的職務代理人',
    proxy_heading: ':handshake: *您被指定為職務代理人*\n{detail}',
    proxy_note: '這張假單已核准，該時段請協助代理其職務。',

    // HR 代同仁登記請假
    ask_leave_prompt_heading_hr: ':memo: 要請假嗎？點下面的按鈕填寫假單。需要幫同仁補登記的話，按「代同仁登記」。',
    btn_hr_register: '代同仁登記',
    modal_hrreg_title: '代同仁登記請假',
    modal_hrreg_submit: '登記並通知',
    modal_hrreg_hint: '用於同仁口頭請假、事後沒有補假單的情況。登記後系統會私訊該同仁請他確認，{days} 天內未提出異議視同確認。',
    field_hrreg_for_whom: '幫誰登記',
    field_hrreg_select_person: '請選擇同仁',
    err_hrreg_not_allowed: '您沒有代同仁登記請假的權限。這個功能只開放給人資／財務角色。',
    hrreg_filed_text: '已完成代登記',
    hrreg_filed_heading: ':white_check_mark: *已完成代登記*\n{detail}',
    hrreg_filed_note: '已私訊 {name} 請他確認，並註明 {days} 天內未提出異議視同確認。若他提出異議，通知會回到這裡。',
    hrreg_dm_text: 'HR 幫你登記了一筆請假，請確認',
    hrreg_dm_heading: ':memo: *HR 幫你登記了一筆請假*\n{detail}',
    hrreg_dm_note: '⚠️ 內容正確請按「確認」；有誤請按「提出修改異議」並說明。*{deadline} 前未提出異議，視同確認。*',

    // 收回假單
    btn_withdraw: '收回假單',
    btn_refill: '重新填寫',
    withdraw_done_text: '假單已收回',
    withdraw_done_heading: ':leftwards_arrow_with_hook: *假單已收回*\n{detail}',
    withdraw_done_note: '這張假單不會再送給主管審核。日期或時間填錯的話，按下面的按鈕重填一張。',
    withdraw_guard_not_yours: '這不是您送出的假單，無法收回。',
    withdraw_guard_approved: '這張假單已經核准，不能收回。如果日期或時間有誤，請聯繫 HR 協助更正。',
    withdraw_guard_not_pending: '這張假單{status}，已經不能收回。',
    withdraw_guard_race: '這張假單剛剛已經被處理掉了（多半是簽核人同時按了核准），無法收回。請重新查看最新狀態。',
    approver_withdrawn_text: '{name} 已收回假單',
    approver_withdrawn_heading: ':leftwards_arrow_with_hook: *此假單已被收回*\n{detail}',
    approver_withdrawn_note: '申請人已自行收回，您不需要處理。',

    // 代登記假單的確認／異議
    btn_ack_confirm: '確認',
    btn_ack_dispute: '提出修改異議',
    ack_done_text: '已確認',
    ack_done_heading: ':white_check_mark: *你已確認這筆請假紀錄*\n{detail}',
    ack_done_stamp: '確認時間：{stamp}',
    modal_dispute_title: '提出修改異議',
    modal_dispute_submit: '送出異議',
    field_dispute_reason: '哪裡有誤？請說明',
    field_dispute_hint: '例如：日期不對、假別不對、這天我沒有請假。HR 會收到通知。',
    err_dispute_reason_required: '請說明哪裡有誤',
    dispute_done_text: '已送出異議',
    dispute_done_heading: ':triangular_flag_on_post: *已送出修改異議*\n{detail}',
    dispute_done_stamp: '已通知 HR，在處理完成前這筆不會自動視同確認。',
    dispute_hr_text: '{name} 對你登記的請假提出異議',
    dispute_hr_heading: ':triangular_flag_on_post: *有人對代登記的請假提出異議*\n{detail}',
    dispute_hr_reason: '*異議內容:* {reason}',
    dispute_hr_note: '這筆維持已核准、時數照算，系統不會自動更動。請確認後到請假系統修改或刪除。在處理完成前，它不會自動視同確認。',
    ack_guard_not_registered: '這筆不是 HR 代為登記的請假，不需要確認。',
    ack_guard_not_yours: '這筆不是登記給您的，無法代為確認。',
    ack_guard_already_acked: '這筆已經確認過了，不需要再按一次。',
    ack_guard_already_disputed: '您已經對這筆提出過異議，HR 正在處理中。',

    guard_not_found: '找不到這張假單，可能已被刪除。',
    guard_already_handled: '這張假單{status}，已由其他方式處理完畢，不需要再動作。',
    guard_no_flow: '這張假單沒有設定審核流程，請到系統處理。',
    guard_not_your_turn: '目前輪到第 {n} 關的簽核人處理，不是您。',
    status_approved: '已核准',
    status_rejected: '已駁回',
    status_withdrawn: '已由申請人收回',
    status_returned: '已逾期退回',

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

    new_request_text: '{name} submitted a leave request for your review',
    new_request_heading: ':memo: *A leave request needs your review*\n{detail}',
    btn_approve: 'Approve',
    btn_reject: 'Reject',

    today_leave_text: '{name} is on leave today',
    today_leave_heading: ':bell: *Same-day leave*\n{line}',
    today_leave_note: 'Approved after this morning’s leave announcement, so this is a follow-up notice.',
    today_wfh_text: '{name} is working from home today',
    today_wfh_heading: ':house_with_garden: *Working from home today*\n{line}',
    today_wfh_note: 'Approved after this morning’s announcement, so this is a follow-up notice. They are still reachable as usual.',

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
    wfh_no_proxy_note: ':information_source: Working from home needs no proxy — you are still working, just not in the office.',
    field_reason: 'Reason',
    modal_attachment_hint: 'Attach files from the leave system website — the Slack form does not support uploads.',

    err_end_before_start: 'End date cannot be earlier than start date',
    err_end_time_before_start: 'End time must be later than start time',
    err_no_flow: 'No approval flow has been assigned to you. Please contact an administrator.',
    err_submit_failed: 'Submission failed: {msg}',

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
    approved_dm_text: 'Your leave request was approved',
    approved_dm_heading: ':white_check_mark: *Leave request approved*\n{detail}',
    rejected_dm_text: 'Your leave request was rejected',
    rejected_dm_heading: ':x: *Leave request rejected*\n{detail}',

    proxy_text: 'You have been assigned as {name}’s proxy',
    proxy_heading: ':handshake: *You’ve been assigned as a proxy*\n{detail}',
    proxy_note: 'This leave request has been approved — please cover their responsibilities during that time.',

    ask_leave_prompt_heading_hr: ':memo: Want to request leave? Use the button below. To file a record on a colleague’s behalf, use “File for a colleague”.',
    btn_hr_register: 'File for a colleague',
    modal_hrreg_title: 'File leave for a colleague',
    modal_hrreg_submit: 'File and notify',
    modal_hrreg_hint: 'For when someone told you about their leave verbally and never filed a request. They will be notified to confirm — if they raise no objection within {days} days, it counts as confirmed.',
    field_hrreg_for_whom: 'File for',
    field_hrreg_select_person: 'Select a colleague',
    err_hrreg_not_allowed: 'You do not have permission to file leave for colleagues. This is limited to HR / finance roles.',
    hrreg_filed_text: 'Leave record filed',
    hrreg_filed_heading: ':white_check_mark: *Leave record filed*\n{detail}',
    hrreg_filed_note: '{name} has been asked to confirm, and told that raising no objection within {days} days counts as confirmed. If they object, you will be notified here.',
    hrreg_dm_text: 'HR filed a leave record for you — please confirm',
    hrreg_dm_heading: ':memo: *HR filed a leave record for you*\n{detail}',
    hrreg_dm_note: '⚠️ If this is correct, click “Confirm”. If not, click “Raise an objection” and explain. *If you raise no objection before {deadline}, this counts as confirmed.*',

    btn_withdraw: 'Withdraw request',
    btn_refill: 'Submit a new one',
    withdraw_done_text: 'Leave request withdrawn',
    withdraw_done_heading: ':leftwards_arrow_with_hook: *Leave request withdrawn*\n{detail}',
    withdraw_done_note: 'This request will no longer go to your manager. If the dates or times were wrong, use the button below to submit a new one.',
    withdraw_guard_not_yours: 'This is not your leave request, so you cannot withdraw it.',
    withdraw_guard_approved: 'This request has already been approved and cannot be withdrawn. If the dates or times are wrong, contact HR to have it corrected.',
    withdraw_guard_not_pending: 'This request is {status}, so it can no longer be withdrawn.',
    withdraw_guard_race: 'This request was just handled (most likely an approver clicked Approve at the same moment), so it could not be withdrawn. Please check its current status.',
    approver_withdrawn_text: '{name} withdrew their leave request',
    approver_withdrawn_heading: ':leftwards_arrow_with_hook: *This request has been withdrawn*\n{detail}',
    approver_withdrawn_note: 'The requester withdrew it themselves — no action needed.',

    btn_ack_confirm: 'Confirm',
    btn_ack_dispute: 'Raise an objection',
    ack_done_text: 'Confirmed',
    ack_done_heading: ':white_check_mark: *You confirmed this leave record*\n{detail}',
    ack_done_stamp: 'Confirmed at {stamp}',
    modal_dispute_title: 'Raise an objection',
    modal_dispute_submit: 'Submit objection',
    field_dispute_reason: 'What is wrong? Please explain',
    field_dispute_hint: 'For example: wrong date, wrong leave type, I was not on leave that day. HR will be notified.',
    err_dispute_reason_required: 'Please explain what is wrong',
    dispute_done_text: 'Objection submitted',
    dispute_done_heading: ':triangular_flag_on_post: *Objection submitted*\n{detail}',
    dispute_done_stamp: 'HR has been notified. This record will not auto-confirm while it is being sorted out.',
    dispute_hr_text: '{name} raised an objection to a leave record you filed',
    dispute_hr_heading: ':triangular_flag_on_post: *Objection to an HR-filed leave record*\n{detail}',
    dispute_hr_reason: '*Objection:* {reason}',
    dispute_hr_note: 'The record stays approved and still counts toward their balance — nothing changes automatically. Please review it in the leave system and edit or delete it. It will not auto-confirm until this is resolved.',
    ack_guard_not_registered: 'This leave request was not filed by HR, so there is nothing to confirm.',
    ack_guard_not_yours: 'This record was not filed for you, so you cannot confirm it.',
    ack_guard_already_acked: 'This record has already been confirmed — no need to do it again.',
    ack_guard_already_disputed: 'You already raised an objection to this record. HR is looking into it.',

    guard_not_found: 'This leave request could not be found — it may have been deleted.',
    guard_already_handled: 'This leave request is {status} and has already been handled elsewhere — no action needed.',
    guard_no_flow: 'This leave request has no approval flow set. Please handle it in the system.',
    guard_not_your_turn: 'It is currently step {n}’s approver’s turn, not yours.',
    status_approved: 'approved',
    status_rejected: 'rejected',
    status_withdrawn: 'withdrawn by the requester',
    status_returned: 'returned as overdue',

    balance_text: '{name}’s leave balance',
    balance_heading: ':bar_chart: *Your leave balance* ({year})\n{lines}',
    balance_no_limit: '• *{type}*　no annual limit',
    balance_line: '• *{type}*　{n} hours available{days}',
    balance_days_suffix: ' ({days} days)',
    balance_days_hours_suffix: ' ({days} days {hours} hrs)',
    balance_footer: 'Available quota already excludes leave that is still pending approval.',
  },
} as const

type MsgKey = keyof typeof T['zh']

function t(lang: Lang, key: MsgKey, params?: Record<string, string | number>): string {
  let text: string = T[lang]?.[key] ?? T.zh[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

/** 公開頻道公告固定用哪個語言：沒設定環境變數就維持全部中文。 */
function channelLang(): Lang {
  return normalizeLang(Deno.env.get('SLACK_CHANNEL_LANGUAGE'))
}

// ===== Slack API =====

async function callSlack(method: string, payload: unknown) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${requireEnv('SLACK_BOT_TOKEN')}`,
    },
    body: JSON.stringify(payload),
  })
  // Slack 失敗時照樣回 HTTP 200，錯誤在 body.ok / body.error
  const body = await res.json()
  if (!body.ok) console.error(`Slack ${method} 失敗：${body.error}`)
  return body
}

/** 用 response_url 覆蓋原本那則訊息（把按鈕換掉，避免重複點）。 */
async function replaceMessage(responseUrl: string, text: string, blocks: unknown[]) {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replace_original: true, text, blocks }),
  })
}

const section = (md: string) => ({ type: 'section', text: { type: 'mrkdwn', text: md } })
const contextLine = (md: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: md }] })

// ===== 背景工作 =====

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined

/**
 * 把工作丟到「回應送出之後」才跑。
 *
 * Slack 規定表單送出（view_submission）與按鈕點擊（block_actions）都必須在
 * 3 秒內收到回應，否則使用者畫面會跳出「連線時遇到一些問題」—— 即使我們的
 * 工作其實已經成功。發通知要打好幾次 Slack API，很容易就超過 3 秒，所以
 * 凡是「使用者不需要等結果」的事（發通知、更新原訊息）一律丟到背景，
 * 只有「決定表單要不要關掉／顯示錯誤」的事才同步做完。
 */
function background(p: Promise<unknown>) {
  const task = p.catch(e => console.error('背景工作失敗：', e))
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(task)
}

// ===== 簽章驗證 =====

async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
  const ts = req.headers.get('x-slack-request-timestamp')
  const sig = req.headers.get('x-slack-signature')
  if (!ts || !sig) return false

  // 重放攻擊防護：超過 5 分鐘的請求一律不收
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false

  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(requireEnv('SLACK_SIGNING_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`v0:${ts}:${rawBody}`))
  const expected = 'v0=' + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('')

  // 長度不同直接失敗；長度相同時逐字比較但不提早跳出，避免用回應時間反推簽章
  if (expected.length !== sig.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0
}

// ===== 請假時數（與網頁版 lib/leaveEntitlements.js 同一套算法）=====

function calcHours(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  if (endMin <= startMin) return 0
  let total = endMin - startMin
  const overlapStart = Math.max(startMin, 12 * 60)
  const overlapEnd = Math.min(endMin, 13 * 60)
  if (overlapEnd > overlapStart) total -= (overlapEnd - overlapStart)
  return Math.max(0, total / 60)
}

function countWorkdays(startDate: string, endDate: string): number {
  let count = 0
  const current = new Date(startDate)
  const end = new Date(endDate)
  while (current <= end) {
    const day = current.getUTCDay()
    if (day !== 0 && day !== 6) count++
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return count
}

function leaveRequestHours(r: { hours: number | null; start_date: string; end_date: string }): number {
  if (r.hours != null) return Number(r.hours)
  return countWorkdays(r.start_date, r.end_date) * HOURS_PER_DAY
}

// 送出假單前的額度檢查（checkQuota）在 2026-09 移除了：需求改成「額度用完
// 仍然可以請，不擋」，網頁版送出那段也一起拿掉了。這支只服務那條擋下來的
// 路徑，留著就是沒人呼叫的死碼。原始實作在 git 歷史裡（搜 quota_exceeded）。

// ===== 共用查詢 =====

/** Slack 帳號 → 系統帳號。對不到就是不認識的人，一律拒絕。 */
async function resolveUser(db: SupabaseClient, slackUserId: string) {
  const { data } = await db
    .from('users')
    .select('id, full_name, slack_user_id, default_flow_id, is_active, language, is_finance')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()
  if (!data || data.is_active === false) return null
  return data
}

const LEAVE_SELECT = `
  id, start_date, end_date, start_time, end_time, hours, reason, status, flow_id, current_step,
  registered_by, acknowledged_at, disputed_at, approver_message_refs,
  requester:users!leave_requests_requester_id_fkey(id, full_name, department, slack_user_id, language),
  proxy:users!leave_requests_proxy_user_id_fkey(full_name, slack_user_id, language),
  leave_type:leave_types(name, name_en, is_wfh)
`

/** 一則已經發出去的待審核通知的位置。lang 一起記，改寫時才不會變成另一種語言。 */
interface ApproverMessageRef { channel: string; ts: string; lang: Lang }

interface LeaveRow {
  id: string; start_date: string; end_date: string
  start_time: string | null; end_time: string | null
  hours: number | null; reason: string | null; status: string
  flow_id: string | null; current_step: number | null
  // HR 代登記的假單才有值，見 migration 20260915_hr_registered_leave 與
  // 20260916_hr_registered_leave_dispute
  registered_by?: string | null
  acknowledged_at?: string | null
  disputed_at?: string | null
  // 待審核通知發到 Slack 的哪幾則訊息，見 migration 20260916_approver_message_refs
  approver_message_refs?: ApproverMessageRef[] | null
  requester?: { id: string; full_name: string; department: string | null; slack_user_id: string | null; language?: string | null } | null
  proxy?: { full_name: string; slack_user_id?: string | null; language?: string | null } | null
  leave_type?: { name: string; name_en?: string | null; is_wfh?: boolean | null } | null
}

// ===== 假單的文字呈現（與 _shared/leave.ts 同一套規則）=====

/** 滿 8 小時就算請整天，未滿都算半天（使用者定義）。 */
const FULL_DAY_HOURS = 8

function isMultiDay(l: LeaveRow): boolean {
  return !!l.end_date && l.end_date > l.start_date
}

function isFullDay(l: LeaveRow): boolean {
  return isMultiDay(l) || (l.hours ?? FULL_DAY_HOURS) >= FULL_DAY_HOURS
}

const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
const hhmm = (time: string) => time.slice(0, 5)

/** 假別名稱：跟網頁版的 leaveTypeName() 同一套規則 —— 英文模式沒填 name_en 就沿用中文名。 */
function leaveTypeName(l: LeaveRow, lang: Lang): string {
  if (!l.leave_type) return t(lang, 'leave_fallback_type')
  if (lang === 'en' && l.leave_type.name_en) return l.leave_type.name_en
  return l.leave_type.name || t(lang, 'leave_fallback_type')
}

/** 「8/17」或「8/17 ~ 8/19」 */
function dateLabel(l: LeaveRow): string {
  return isMultiDay(l) ? `${shortDate(l.start_date)} ~ ${shortDate(l.end_date)}` : shortDate(l.start_date)
}

/** 「08:30-17:30」；多日假沒有時間意義，寫「整日」。 */
function timeLabel(l: LeaveRow, lang: Lang): string {
  if (isMultiDay(l)) return t(lang, 'all_day')
  if (l.start_time && l.end_time) return `${hhmm(l.start_time)}-${hhmm(l.end_time)}`
  return t(lang, 'all_day')
}

/** 連續一天以上一律用天數表示，單日才用小時。 */
function durationLabel(l: LeaveRow, lang: Lang): string {
  if (isMultiDay(l)) return t(lang, 'days_unit', { n: countWorkdays(l.start_date, l.end_date) })
  return t(lang, 'hours_unit', { n: l.hours ?? FULL_DAY_HOURS })
}

/** 單張假單的條列式明細。`extra` 補該情境專屬的欄位（例如駁回原因）。 */
function leaveDetailLines(l: LeaveRow, lang: Lang, extra: string[] = []): string {
  const lines = [
    t(lang, 'detail_requester', { name: l.requester?.full_name ?? '—' }),
    t(lang, 'detail_type', { type: leaveTypeName(l, lang) }),
    t(lang, 'detail_date', { date: dateLabel(l) }),
    t(lang, 'detail_time', { time: timeLabel(l, lang) }),
    t(lang, 'detail_hours', { duration: durationLabel(l, lang) }),
  ]
  // 沒填代理人就整行不顯示，不要留一行「無」佔版面
  if (l.proxy?.full_name) lines.push(t(lang, 'detail_proxy', { name: l.proxy.full_name }))
  if (l.reason) lines.push(t(lang, 'detail_reason', { reason: l.reason }))
  return [...lines, ...extra].join('\n')
}

/** 頻道公告用的精簡單行（不含部門）。 */
function digestLine(l: LeaveRow, lang: Lang, { markFullDay = false } = {}): string {
  const name = l.requester?.full_name ?? t(lang, 'unknown_person')
  const type = leaveTypeName(l, lang)
  if (isMultiDay(l)) return `• ${name}　${type}（${t(lang, 'multiday_range', { range: dateLabel(l) })}）`
  // 整天卻什麼都不寫，看起來像資訊漏掉（未滿 8 小時的會顯示時間範圍）
  if (isFullDay(l)) return `• ${name}　${type}${markFullDay ? t(lang, 'full_day_marker') : ''}`
  return `• ${name}　${type}　${timeLabel(l, lang)}`
}

function dm(slackUserId: string, text: string, blocks: unknown[]) {
  return callSlack('chat.postMessage', { channel: slackUserId, text, blocks, unfurl_links: false })
}

/** 這一關的簽核人（系統 id、Slack id、各自的語言偏好）。 */
async function approversForStep(db: SupabaseClient, flowId: string, stepOrder: number) {
  const { data } = await db
    .from('approval_flow_steps')
    .select('approver_id, approver:users!approval_flow_steps_approver_id_fkey(slack_user_id, language)')
    .eq('flow_id', flowId).eq('step_order', stepOrder)
  return (data ?? []) as { approver_id: string; approver?: { slack_user_id?: string; language?: string } }[]
}

/** 管理後台「核准通知對象」裡設定、且仍啟用的人。 */
async function notificationTargets(db: SupabaseClient) {
  const { data } = await db
    .from('notification_targets')
    .select('user:users(slack_user_id, language)')
    .eq('is_active', true)
  return (data ?? []).map(
    (r: { user?: { slack_user_id?: string | null; language?: string | null } }) => r.user,
  )
}

/**
 * 假單走到最後一關核准之後，私訊「申請人本人 ＋ 管理後台設定的核准通知對象」。
 *
 * ⚠️ 這段與 send-slack-notification 的 notifyApproved 是同一件事的兩份實作，
 * 因為核准有兩個入口：網頁上按核准走那支 function，Slack 訊息上按核准走這支。
 * 2026-09 之前這裡漏了「通知對象」那一半 —— 而大家平常都是在 Slack 上按的，
 * 結果就是後台設定了通知對象卻從來沒收到過通知。改這裡的話那支也要跟著改。
 *
 * 代理人如果同時也被設為通知對象，會收到兩則（「假單已核准」與「你是代理
 * 人」）。這是刻意的：兩則講的是不同的事，一則是知會、一則有交辦動作，
 * 使用者要求兩則都保留（2026-09 確認）。
 */
async function notifyApprovedRecipients(
  db: SupabaseClient, leave: LeaveRow, { includeRequester = true } = {},
): Promise<void> {
  const rows: ({ slack_user_id?: string | null; language?: string | null } | undefined)[] = [
    ...(includeRequester && leave.requester?.slack_user_id
      ? [{ slack_user_id: leave.requester.slack_user_id, language: leave.requester.language }]
      : []),
    ...await notificationTargets(db),
  ]

  const sent = new Set<string>()
  for (const row of rows) {
    if (!row?.slack_user_id || sent.has(row.slack_user_id)) continue
    sent.add(row.slack_user_id)
    const lang = normalizeLang(row.language)
    await dm(row.slack_user_id, t(lang, 'approved_dm_text'), [
      section(t(lang, 'approved_dm_heading', { detail: leaveDetailLines(leave, lang) })),
    ])
  }
}

/** 待審核通知（含核准／駁回按鈕）—— 送給某一關的所有簽核人，各自用自己的語言。 */
async function notifyApprovers(db: SupabaseClient, leave: LeaveRow) {
  if (!leave.flow_id || !leave.current_step) return
  const steps = await approversForStep(db, leave.flow_id, leave.current_step)

  const buildBlocks = (lang: Lang) => [
    section(t(lang, 'new_request_heading', { detail: leaveDetailLines(leave, lang) })),
    ...(leave.reason ? [section(`*${t(lang, 'field_reason')}*\n${leave.reason}`)] : []),
    ...(leave.proxy?.full_name ? [contextLine(`${t(lang, 'field_proxy')}：${leave.proxy.full_name}`)] : []),
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: t(lang, 'btn_approve'), emoji: true },
          action_id: 'approve_leave', value: leave.id },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: t(lang, 'btn_reject'), emoji: true },
          action_id: 'reject_leave', value: leave.id },
      ],
    },
  ]

  // 記下每則通知發到哪 —— 申請人之後收回假單時，要靠這個把這幾則訊息改寫成
  // 「此假單已被收回」。事後沒有別的辦法找到它們（見 migration
  // 20260916_approver_message_refs 的說明）。
  const refs: ApproverMessageRef[] = []
  for (const s of steps) {
    if (!s.approver?.slack_user_id) continue
    const lang = normalizeLang(s.approver.language)
    const sent = await dm(s.approver.slack_user_id, t(lang, 'new_request_text', { name: leave.requester?.full_name ?? '' }), buildBlocks(lang))
    if (sent.ok && sent.channel && sent.ts) {
      refs.push({ channel: String(sent.channel), ts: String(sent.ts), lang })
    }
  }

  // 整個覆蓋，不累加：上一關那則在核准的當下就已經改寫成「已核准」了。
  // 一則都沒發成功時寫 null，免得留著上一關的舊位置、之後改寫到錯的訊息。
  await db.from('leave_requests')
    .update({ approver_message_refs: refs.length ? refs : null })
    .eq('id', leave.id)
}

// ===== 假單表單 =====

const TIME_OPTIONS: string[] = []
for (let h = 8; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 18 && m > 30) break
    TIME_OPTIONS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  }
}

const opt = (text: string, value: string) => ({ text: { type: 'plain_text', text, emoji: true }, value })

/** 表單上目前已經填了什麼。改假別要重畫表單時，靠它把填過的內容帶回去。 */
interface LeaveModalState {
  leaveTypeId?: string | null
  startDate?: string | null
  endDate?: string | null
  startTime?: string | null
  endTime?: string | null
  proxyId?: string | null
  reason?: string | null
}

/** 從 Slack 送來的 view payload 讀出使用者目前填了什麼。 */
function readLeaveModalState(view: Record<string, any>): LeaveModalState {
  const v = view?.state?.values ?? {}
  const pick = (block: string) => v[block]?.v?.selected_option?.value ?? null
  return {
    leaveTypeId: pick('leave_type'),
    startDate: v.start_date?.v?.selected_date ?? null,
    endDate: v.end_date?.v?.selected_date ?? null,
    startTime: pick('start_time'),
    endTime: pick('end_time'),
    // 職務代理人那一格被藏起來時這裡會讀不到，自然就是 null
    proxyId: pick('proxy'),
    reason: v.reason?.v?.value ?? null,
  }
}

async function buildLeaveModal(
  db: SupabaseClient, requester: { id: string }, lang: Lang, current: LeaveModalState = {},
) {
  const [typesRes, colleaguesRes] = await Promise.all([
    db.from('leave_types').select('id, name, name_en, is_annual, is_wfh').eq('is_active', true).order('name'),
    // Slack 的下拉選單上限 100 個選項，超過就得改成需要另一個端點的動態搜尋。
    // 以這個系統的規模不會碰到，但真的超過時寧可截斷也不要整個表單開不起來。
    db.from('users').select('id, full_name').eq('is_active', true).neq('id', requester.id)
      .order('full_name').limit(100),
  ])

  const types = typesRes.data ?? []
  const colleagues = colleaguesRes.data ?? []
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const typeLabel = (row: { name: string; name_en: string | null }) =>
    lang === 'en' && row.name_en ? row.name_en : row.name

  // 在家工作不需要職務代理人 —— 人有在上班，只是不在辦公室，沒有職務要交接。
  // 整個欄位藏起來，比留著讓人猶豫要不要填好（跟網頁版 LeaveForm.jsx 一致）。
  const selectedType = types.find(row => row.id === current.leaveTypeId)
  const isWfh = !!selectedType?.is_wfh
  const selectedProxy = colleagues.find(u => u.id === current.proxyId)
  const startTime = current.startTime ?? '09:00'
  const endTime = current.endTime ?? '18:00'

  return {
    type: 'modal',
    callback_id: 'submit_leave',
    title: { type: 'plain_text', text: t(lang, 'modal_leave_title'), emoji: true },
    submit: { type: 'plain_text', text: t(lang, 'modal_submit'), emoji: true },
    close: { type: 'plain_text', text: t(lang, 'modal_cancel'), emoji: true },
    blocks: [
      {
        // dispatch_action：選了假別就通知我們一次，才有辦法依假別重畫表單。
        // 沒有這一行的話 Slack 不會在 input 區塊被改動時送出任何事件。
        type: 'input', block_id: 'leave_type', dispatch_action: true,
        label: { type: 'plain_text', text: t(lang, 'field_leave_type'), emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          placeholder: { type: 'plain_text', text: t(lang, 'field_leave_type_placeholder'), emoji: true },
          ...(selectedType ? { initial_option: opt(typeLabel(selectedType), selectedType.id) } : {}),
          options: types.map(row => opt(typeLabel(row), row.id)),
        },
      },
      {
        type: 'input', block_id: 'start_date',
        label: { type: 'plain_text', text: t(lang, 'field_start_date'), emoji: true },
        element: { type: 'datepicker', action_id: 'v', initial_date: current.startDate ?? today },
      },
      {
        type: 'input', block_id: 'end_date',
        label: { type: 'plain_text', text: t(lang, 'field_end_date'), emoji: true },
        element: { type: 'datepicker', action_id: 'v', initial_date: current.endDate ?? today },
      },
      {
        type: 'input', block_id: 'start_time',
        label: { type: 'plain_text', text: t(lang, 'field_start_time'), emoji: true },
        hint: { type: 'plain_text', text: t(lang, 'field_multiday_hint'), emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          initial_option: opt(startTime, startTime),
          options: TIME_OPTIONS.map(time => opt(time, time)),
        },
      },
      {
        type: 'input', block_id: 'end_time',
        label: { type: 'plain_text', text: t(lang, 'field_end_time'), emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          initial_option: opt(endTime, endTime),
          options: TIME_OPTIONS.map(time => opt(time, time)),
        },
      },
      // 選了 WFH 就整格拿掉，並補一句說明 —— 欄位無聲消失看起來像壞掉。
      ...(isWfh ? [contextLine(t(lang, 'wfh_no_proxy_note'))] : [{
        type: 'input', block_id: 'proxy', optional: true,
        label: { type: 'plain_text', text: t(lang, 'field_proxy'), emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          placeholder: { type: 'plain_text', text: t(lang, 'field_proxy_placeholder'), emoji: true },
          ...(selectedProxy ? { initial_option: opt(selectedProxy.full_name, selectedProxy.id) } : {}),
          options: colleagues.map(u => opt(u.full_name, u.id)),
        },
      }]),
      {
        type: 'input', block_id: 'reason',
        label: { type: 'plain_text', text: t(lang, 'field_reason'), emoji: true },
        element: {
          type: 'plain_text_input', action_id: 'v', multiline: true,
          ...(current.reason ? { initial_value: current.reason } : {}),
        },
      },
      contextLine(t(lang, 'modal_attachment_hint')),
    ],
  }
}

/**
 * 使用者在表單裡換了假別 → 重畫整張表單。
 *
 * Slack 沒有「只改一個區塊」的做法，views.update 一定是整張換掉，所以要先把
 * 已經填過的內容讀回來（readLeaveModalState）再重建，否則使用者選好的日期、
 * 打好的事由會在換假別的瞬間全部不見。
 *
 * 刻意不帶 hash：hash 是用來擋併發衝突的，但這裡一次只會有一個更新，帶了反而
 * 多一種會失敗的情況（hash 稍微過期就整個更新不了）。
 */
async function refreshLeaveModal(db: SupabaseClient, me: any, lang: Lang, p: Record<string, any>) {
  const view = await buildLeaveModal(db, me, lang, readLeaveModalState(p.view))
  await callSlack('views.update', { view_id: p.view.id, view })
}

// ===== HR 代同仁登記請假 =====
//
// 跟一般假單有三個關鍵差別（見 migration 20260915_hr_registered_leave）：
//   1. 直接 approved，不走簽核 —— 這種假已經請完了，再送主管核准是倒因為果
//   2. 記下 registered_by（誰登的）與 ack_deadline（確認期限）
//   3. 送出後私訊當事人請他確認，通知裡明寫「N 天內未確認視同確認」
//
// 表單刻意跟一般請假長得很像，只多一個「幫誰登記」、少一個職務代理人 ——
// 跟網頁版的 HrRegisterLeaveDialog 一致，HR 不用重新學。

/** 同仁要在幾天內確認。跟網頁版 HrRegisterLeaveDialog 的 ACK_DAYS 是同一個數字，改的話兩邊都要改。 */
const ACK_DAYS = 3

async function buildHrRegisterModal(db: SupabaseClient, lang: Lang) {
  const [typesRes, peopleRes] = await Promise.all([
    db.from('leave_types').select('id, name, name_en').eq('is_active', true).order('name'),
    // Slack 下拉選單上限 100 個選項。以這個系統的規模不會碰到，但真的超過時
    // 寧可截斷也不要整個表單開不起來。
    db.from('users').select('id, full_name').eq('is_active', true).order('full_name').limit(100),
  ])

  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const typeLabel = (row: { name: string; name_en: string | null }) =>
    lang === 'en' && row.name_en ? row.name_en : row.name

  return {
    type: 'modal',
    callback_id: 'submit_hr_register',
    title: { type: 'plain_text', text: t(lang, 'modal_hrreg_title'), emoji: true },
    submit: { type: 'plain_text', text: t(lang, 'modal_hrreg_submit'), emoji: true },
    close: { type: 'plain_text', text: t(lang, 'modal_cancel'), emoji: true },
    blocks: [
      contextLine(t(lang, 'modal_hrreg_hint', { days: ACK_DAYS })),
      {
        type: 'input', block_id: 'requester',
        label: { type: 'plain_text', text: t(lang, 'field_hrreg_for_whom'), emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          placeholder: { type: 'plain_text', text: t(lang, 'field_hrreg_select_person'), emoji: true },
          options: (peopleRes.data ?? []).map(u => opt(u.full_name, u.id)),
        },
      },
      {
        type: 'input', block_id: 'leave_type',
        label: { type: 'plain_text', text: t(lang, 'field_leave_type'), emoji: true },
        element: {
          type: 'static_select', action_id: 'v',
          placeholder: { type: 'plain_text', text: t(lang, 'field_leave_type_placeholder'), emoji: true },
          options: (typesRes.data ?? []).map(row => opt(typeLabel(row), row.id)),
        },
      },
      {
        type: 'input', block_id: 'start_date',
        label: { type: 'plain_text', text: t(lang, 'field_start_date'), emoji: true },
        element: { type: 'datepicker', action_id: 'v', initial_date: today },
      },
      {
        type: 'input', block_id: 'end_date',
        label: { type: 'plain_text', text: t(lang, 'field_end_date'), emoji: true },
        element: { type: 'datepicker', action_id: 'v', initial_date: today },
      },
      {
        type: 'input', block_id: 'start_time',
        label: { type: 'plain_text', text: t(lang, 'field_start_time'), emoji: true },
        hint: { type: 'plain_text', text: t(lang, 'field_multiday_hint'), emoji: true },
        element: { type: 'static_select', action_id: 'v', initial_option: opt('09:00', '09:00'),
          options: TIME_OPTIONS.map(time => opt(time, time)) },
      },
      {
        type: 'input', block_id: 'end_time',
        label: { type: 'plain_text', text: t(lang, 'field_end_time'), emoji: true },
        element: { type: 'static_select', action_id: 'v', initial_option: opt('18:00', '18:00'),
          options: TIME_OPTIONS.map(time => opt(time, time)) },
      },
      {
        type: 'input', block_id: 'reason',
        label: { type: 'plain_text', text: t(lang, 'field_reason'), emoji: true },
        element: { type: 'plain_text_input', action_id: 'v', multiline: true },
      },
    ],
  }
}

async function handleHrRegisterSubmit(db: SupabaseClient, me: any, lang: Lang, p: Record<string, any>) {
  // 按鈕看不到不等於防得住 —— Slack 的互動請求是外部可以偽造 payload 的路徑，
  // 所以這裡重新確認身分，不信任「他看得到那顆按鈕」這件事。
  if (!me.is_finance) {
    return json({ response_action: 'errors', errors: { reason: t(lang, 'err_hrreg_not_allowed') } })
  }

  const v = p.view.state.values
  const pick = (block: string) => v[block]?.v?.selected_option?.value ?? null
  const requesterId = pick('requester')
  const leaveTypeId = pick('leave_type')
  const startDate = v.start_date?.v?.selected_date
  const endDate = v.end_date?.v?.selected_date
  const startTime = pick('start_time') ?? '09:00'
  const endTime = pick('end_time') ?? '18:00'
  const reason = (v.reason?.v?.value ?? '').trim()

  if (endDate < startDate) {
    return json({ response_action: 'errors', errors: { end_date: t(lang, 'err_end_before_start') } })
  }
  const multiDay = endDate > startDate
  const hours = multiDay ? null : calcHours(startTime, endTime)
  if (!multiDay && (hours ?? 0) <= 0) {
    return json({ response_action: 'errors', errors: { end_time: t(lang, 'err_end_time_before_start') } })
  }

  const deadline = new Date()
  deadline.setDate(deadline.getDate() + ACK_DAYS)

  const { data: created, error } = await db.from('leave_requests').insert({
    requester_id: requesterId,
    leave_type_id: leaveTypeId,
    // flow_id 與 current_step 留空 —— 這張不走簽核
    start_date: startDate,
    end_date: endDate,
    start_time: multiDay ? '09:00' : startTime,
    end_time: multiDay ? '18:00' : endTime,
    hours,
    reason,
    status: 'approved',
    registered_by: me.id,
    ack_deadline: deadline.toISOString(),
  }).select('id').single()

  if (error) {
    return json({ response_action: 'errors', errors: { reason: t(lang, 'err_submit_failed', { msg: error.message }) } })
  }

  // 假單已經建立，通知丟背景讓表單立刻關閉（避免 Slack 的 3 秒逾時）。
  // 通知失敗也不該讓登記失敗 —— 假單有沒有建立才是結算的依據。
  background((async () => {
    const { data: row } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', created.id).single()
    const leave = row as unknown as LeaveRow

    await notifyHrRegistered(db, leave, deadline)
    // 這種假通常是「人今天真的沒來、大家卻不知道」，所以涵蓋今天的話要公告
    await notifyChannelIfToday(db, leave)
    // 撞到當事人的按摩 → 提醒「當事人」釋出（使用者決定：發給同仁本人，不是 HR）
    await remindMassageForLeave(db, created.id, leave.requester, 'hit_heading_hr')

    if (me.slack_user_id) {
      await dm(me.slack_user_id, t(lang, 'hrreg_filed_text'), [
        section(t(lang, 'hrreg_filed_heading', { detail: leaveDetailLines(leave, lang) })),
        contextLine(t(lang, 'hrreg_filed_note', {
          name: leave.requester?.full_name ?? '', days: ACK_DAYS,
        })),
      ])
    }
  })())

  return json({ response_action: 'clear' })
}

/**
 * 私訊當事人請他確認，附「確認」與「提出修改異議」兩顆按鈕。
 *
 * ⚠️ 這段與 send-slack-notification 的 notifyHrRegistered 是同一件事的兩份
 * 實作，因為代登記有兩個入口：網頁上登記走那支，Slack 上登記走這支。改這裡
 * 的話那支也要跟著改。（這支 function 刻意不拆共用檔，見檔頭說明。）
 *
 * 一定要給「有異議」一條路：只放「確認」的話，內容有錯的人無處可按，而
 * 「N 天內未提出異議視同確認」那句話的前提就是他「按得到」異議。
 */
async function notifyHrRegistered(db: SupabaseClient, leave: LeaveRow, deadline: Date) {
  const slackId = leave.requester?.slack_user_id
  if (!slackId) return

  const lang = normalizeLang(leave.requester?.language)
  const deadlineText = deadline.toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-TW')

  await dm(slackId, t(lang, 'hrreg_dm_text'), [
    section(t(lang, 'hrreg_dm_heading', { detail: leaveDetailLines(leave, lang) })),
    contextLine(t(lang, 'hrreg_dm_note', { deadline: deadlineText })),
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: t(lang, 'btn_ack_confirm'), emoji: true },
          action_id: 'ack_registered_leave', value: leave.id },
        { type: 'button', text: { type: 'plain_text', text: t(lang, 'btn_ack_dispute'), emoji: true },
          action_id: 'dispute_registered_leave', value: leave.id },
      ],
    },
  ])
}

// ===== 進入點 =====

Deno.serve(async (req) => {
  const rawBody = await req.text()

  // 先驗簽章再做任何事。少了這一步，任何知道網址的人都能偽造請求核准假單。
  //
  // verifySignature 內部會呼叫 requireEnv('SLACK_SIGNING_SECRET')，如果這個
  // secret 忘了設定會直接 throw；包一層 try/catch 讓這種設定缺漏回一個看得懂
  // 的錯誤，而不是讓整個函式崩潰、回一個難以判斷原因的 HTTP 錯誤（Slack 的
  // Event Subscriptions 驗證網址那一步就是靠這個回應判斷 function 是否正常，
  // 崩潰的話畫面只會顯示「回應了 HTTP error」，看不出真正原因）。
  let signatureOk = false
  try {
    signatureOk = await verifySignature(req, rawBody)
  } catch (e) {
    console.error('簽章驗證失敗（多半是 SLACK_SIGNING_SECRET 沒有設定）：', e)
    return new Response('signature verification misconfigured, check function secrets', { status: 500 })
  }
  if (!signatureOk) {
    return new Response('invalid signature', { status: 401 })
  }

  const db = adminClient()
  const contentType = req.headers.get('content-type') ?? ''

  try {
    if (contentType.includes('application/json')) {
      return await handleEvent(db, JSON.parse(rawBody))
    }
    const params = new URLSearchParams(rawBody)
    const payload = JSON.parse(params.get('payload') ?? '{}')
    return await handleInteraction(db, payload)
  } catch (e) {
    console.error(e)
    return new Response('ok') // 回錯誤碼會讓 Slack 一直重送，錯誤記在 log 就好
  }
})

// ---- Events API ----

function handleEvent(db: SupabaseClient, body: Record<string, any>) {
  if (body.type === 'url_verification') {
    return new Response(body.challenge, { headers: { 'Content-Type': 'text/plain' } })
  }

  const event = body.event
  // bot_id 用來擋掉「bot 自己發的訊息」，否則我們回的訊息會再觸發自己
  if (event?.type === 'message' && event.channel_type === 'im' && !event.bot_id && !event.subtype) {
    const text: string = event.text ?? ''
    const lower = text.toLowerCase()

    // 回訊息一律走背景：Slack 沒在 3 秒內收到 200 就會「重送同一個事件」，
    // 而我們在等 Slack API 回應，很容易超過 —— 結果就是 bot 回了兩次。
    //
    // 這裡還不知道對方是誰（要等 resolveUser 才知道），所以用哪個語言回覆
    // 只能先看對方打字用的是中文關鍵字還是英文關鍵字來猜；已知身分之後的
    // replyWithBalance 內部會再改用 me.language 為準。
    if (text.includes('按摩')) {
      background(replyMassage(db, event, 'zh'))
    } else if (lower.includes('massage')) {
      background(replyMassage(db, event, 'en'))
    } else if (text.includes('假期查詢') || text.includes('假期') || text.includes('額度')) {
      background(replyWithBalance(db, event, 'zh'))
    } else if (lower.includes('balance') || lower.includes('quota')) {
      background(replyWithBalance(db, event, 'en'))
    } else if (text.includes('請假')) {
      background(promptLeaveForm(db, event, 'zh'))
    } else if (lower.includes('leave')) {
      background(promptLeaveForm(db, event, 'en'))
    }
  }
  return new Response('ok')
}

/**
 * 打字不會給 trigger_id，沒有 trigger_id 就不能直接彈出表單，所以只能先回
 * 一顆按鈕 —— 點按鈕才會產生 trigger_id。這裡的語言只是「先猜的」，猜錯了
 * 頂多這一則提示文字語言不對，後面真正開表單時（block_actions 已經知道
 * 是誰）一律照 me.language 為準。
 */
async function promptLeaveForm(db: SupabaseClient, event: Record<string, any>, fallbackLang: Lang) {
  // 這裡查一次是誰，有兩個目的：用他自己的語言回覆（不再靠關鍵字猜），
  // 以及決定要不要多給 HR 那顆「代同仁登記」。對不到帳號的人照樣給一顆
  // 「填寫假單」—— 真正的拒絕在按下按鈕之後（那裡會再查一次）。
  const me = await resolveUser(db, event.user)
  const lang = me ? normalizeLang(me.language) : fallbackLang

  const buttons: unknown[] = [{
    type: 'button', style: 'primary',
    text: { type: 'plain_text', text: t(lang, 'btn_fill_leave_form'), emoji: true },
    action_id: 'open_leave_form', value: 'open',
  }]

  // 一般同仁看不到這顆。但看不到不等於防得住 —— 真正的把關在
  // handleHrRegisterSubmit，那裡會重新確認身分。
  if (me?.is_finance) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: t(lang, 'btn_hr_register'), emoji: true },
      action_id: 'open_hr_register_form', value: 'open',
    })
  }

  return callSlack('chat.postMessage', {
    channel: event.channel,
    text: t(lang, 'ask_leave_prompt_text'),
    blocks: [
      section(t(lang, me?.is_finance ? 'ask_leave_prompt_heading_hr' : 'ask_leave_prompt_heading')),
      { type: 'actions', elements: buttons },
    ],
  })
}

// ---- 假期查詢 ----

/**
 * 回傳這位員工各假別的可用額度。
 *
 * 額度的判定規則跟送出假單時的檢查完全一致（財務個人設定 > 公司預設；
 * 已使用時數含審核中；沒設額度視為無上限），兩邊算出來的數字才不會打架。
 * `fallbackLang`：對不到系統帳號時（不知道對方是誰）用的語言，來自使用者
 * 打字關鍵字的猜測；一旦找到帳號就改用 me.language，不再用猜的。
 */
async function replyWithBalance(db: SupabaseClient, event: Record<string, any>, fallbackLang: Lang) {
  const me = await resolveUser(db, event.user)
  if (!me) {
    await callSlack('chat.postMessage', {
      channel: event.channel,
      text: t(fallbackLang, 'no_account_text'),
      blocks: [section(t(fallbackLang, 'no_account_heading'))],
    })
    return
  }
  const lang = normalizeLang(me.language)

  const year = new Date().getFullYear()
  const [typesRes, overridesRes, summaryRes, usedRes] = await Promise.all([
    db.from('leave_types').select('id, name, name_en, annual_quota_hours, is_annual').eq('is_active', true).order('name'),
    db.from('user_leave_entitlements').select('leave_type_id, quota_hours')
      .eq('user_id', me.id).eq('mode', 'manual'),
    db.from('annual_leave_summary').select('entitled_days').eq('user_id', me.id).maybeSingle(),
    db.from('leave_requests').select('leave_type_id, hours, start_date, end_date')
      .eq('requester_id', me.id).in('status', ['approved', 'pending'])
      .gte('start_date', `${year}-01-01`).lte('start_date', `${year}-12-31`),
  ])

  const overrides = new Map<string, number>()
  for (const r of overridesRes.data ?? []) {
    if (r.quota_hours != null) overrides.set(r.leave_type_id, Number(r.quota_hours))
  }

  const usedByType = new Map<string, number>()
  for (const r of usedRes.data ?? []) {
    usedByType.set(r.leave_type_id, (usedByType.get(r.leave_type_id) ?? 0) + leaveRequestHours(r))
  }

  const f = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1))

  /**
   * 把時數換算成「N 天 M 小時」放在括號裡。
   *
   * 小時才是系統實際記錄、也是擋額度時用的單位，所以永遠放主位；天數只是
   * 給人快速抓概念用的。不滿一天就回 null 讓呼叫端整個略過括號 —— 5 小時
   * 寫成「0.6 天」或「0 天 5 小時」都只會更難讀。
   */
  const asDays = (h: number) => {
    const days = Math.floor(h / HOURS_PER_DAY)
    const rest = h - days * HOURS_PER_DAY
    if (days === 0) return null
    return rest === 0
      ? t(lang, 'balance_days_suffix', { days })
      : t(lang, 'balance_days_hours_suffix', { days, hours: f(rest) })
  }

  // 特休排第一個，跟網頁上的「假期剩餘額度」一致 —— 它是唯一有年度上限、
  // 真的會用完的假別，排在一長串「無年度上限」後面很難找。查詢是 .order('name')
  // 取回來的，這裡只多加 is_annual 這個條件，其餘假別維持原本的名稱排序
  // （sort 是穩定排序）。
  const orderedTypes = [...(typesRes.data ?? [])]
    .sort((a, b) => (b.is_annual ? 1 : 0) - (a.is_annual ? 1 : 0))

  const lines: string[] = []
  for (const row of orderedTypes) {
    const typeName = lang === 'en' && row.name_en ? row.name_en : row.name
    let quota = overrides.get(row.id) ?? null
    if (quota == null) {
      quota = row.is_annual
        ? (summaryRes.data?.entitled_days != null ? Number(summaryRes.data.entitled_days) * HOURS_PER_DAY : null)
        : (row.annual_quota_hours ?? null)
    }

    if (quota == null) {
      // 沒有設額度＝不受年度上限限制，這種寫「無上限」比寫 0 或空白清楚
      lines.push(t(lang, 'balance_no_limit', { type: typeName }))
      continue
    }
    // 不夾成 0 —— 超過額度時就讓它顯示負數，這樣看得出來超了多少。
    const remaining = quota - (usedByType.get(row.id) ?? 0)
    // 特休大家習慣用「天」在講，所以額外換算一份；其他假別只寫時數
    const days = row.is_annual ? asDays(remaining) : null
    lines.push(t(lang, 'balance_line', { type: typeName, n: f(remaining), days: days ?? '' }))
  }

  await callSlack('chat.postMessage', {
    channel: event.channel,
    text: t(lang, 'balance_text', { name: me.full_name }),
    blocks: [
      section(t(lang, 'balance_heading', { year, lines: lines.join('\n') })),
      contextLine(t(lang, 'balance_footer')),
    ],
  })
}

// ---- Interactivity ----

async function handleInteraction(db: SupabaseClient, p: Record<string, any>) {
  if (p.type === 'block_actions') {
    const action = p.actions?.[0]
    const slackUserId = p.user?.id
    const me = await resolveUser(db, slackUserId)
    if (!me) {
      await dm(slackUserId, t('zh', 'no_account_text'), [section(t('zh', 'no_account_heading'))])
      return new Response('')
    }
    const lang = normalizeLang(me.language)

    // 表單裡換了假別 → 重畫表單（WFH 要把職務代理人那格藏起來）。
    // 這些 input 元件的 action_id 全都是 'v'，所以要看 block_id 才分得出來。
    if (p.view?.callback_id === 'submit_leave' && action?.block_id === 'leave_type') {
      // 走背景：Slack 要 3 秒內收到回應，而 views.update 是一次 API 往返。
      background(refreshLeaveModal(db, me, lang, p))
      return new Response('')
    }

    if (String(action?.action_id ?? '').startsWith('massage_')) {
      return handleMassageAction(db, me, lang, p, action)
    }

    if (action.action_id === 'open_leave_form') {
      await callSlack('views.open', { trigger_id: p.trigger_id, view: await buildLeaveModal(db, me, lang) })
      return new Response('')
    }
    if (action.action_id === 'open_hr_register_form') {
      // 這顆只會出現在 HR 的訊息裡，但按鈕看不到不等於防得住 —— 先擋一次，
      // 真正的把關在 handleHrRegisterSubmit（那裡會再確認一次身分）。
      if (!me.is_finance) {
        await dm(slackUserId, t(lang, 'err_hrreg_not_allowed'), [section(`:warning: ${t(lang, 'err_hrreg_not_allowed')}`)])
        return new Response('')
      }
      await callSlack('views.open', { trigger_id: p.trigger_id, view: await buildHrRegisterModal(db, lang) })
      return new Response('')
    }
    if (action.action_id === 'approve_leave') {
      return await handleApprove(db, me, lang, action.value, p.response_url)
    }
    if (action.action_id === 'withdraw_leave') {
      return handleWithdraw(db, me, lang, action.value, p.response_url)
    }
    if (action.action_id === 'ack_registered_leave') {
      return handleAcknowledge(db, me, lang, action.value, p.response_url)
    }
    if (action.action_id === 'dispute_registered_leave') {
      // 異議一定要填理由（跟駁回一樣），所以再開一個視窗收。response_url 只有
      // 現在這個 payload 有，view_submission 收不到，先塞進 private_metadata。
      await callSlack('views.open', {
        trigger_id: p.trigger_id,
        view: {
          type: 'modal', callback_id: 'submit_dispute',
          private_metadata: JSON.stringify({ request_id: action.value, response_url: p.response_url }),
          title: { type: 'plain_text', text: t(lang, 'modal_dispute_title'), emoji: true },
          submit: { type: 'plain_text', text: t(lang, 'modal_dispute_submit'), emoji: true },
          close: { type: 'plain_text', text: t(lang, 'modal_cancel'), emoji: true },
          blocks: [{
            type: 'input', block_id: 'reason',
            label: { type: 'plain_text', text: t(lang, 'field_dispute_reason'), emoji: true },
            hint: { type: 'plain_text', text: t(lang, 'field_dispute_hint'), emoji: true },
            element: { type: 'plain_text_input', action_id: 'v', multiline: true },
          }],
        },
      })
      return new Response('')
    }
    if (action.action_id === 'reject_leave') {
      // 駁回一定要填理由（與網頁版一致），所以再開一個視窗收理由。
      // response_url 只有現在這個 payload 有，view_submission 收不到，
      // 所以先塞進 private_metadata 帶過去。語言不用一併塞——view_submission
      // 送出時會重新 resolveUser 拿到同一個人的 me.language，沒有必要在
      // 兩個地方各存一份、之後改動時忘記同步。
      await callSlack('views.open', {
        trigger_id: p.trigger_id,
        view: {
          type: 'modal', callback_id: 'submit_reject',
          private_metadata: JSON.stringify({ request_id: action.value, response_url: p.response_url }),
          title: { type: 'plain_text', text: t(lang, 'modal_reject_title'), emoji: true },
          submit: { type: 'plain_text', text: t(lang, 'modal_reject_submit'), emoji: true },
          close: { type: 'plain_text', text: t(lang, 'modal_cancel'), emoji: true },
          blocks: [{
            type: 'input', block_id: 'comment',
            label: { type: 'plain_text', text: t(lang, 'field_reject_reason'), emoji: true },
            element: { type: 'plain_text_input', action_id: 'v', multiline: true },
          }],
        },
      })
      return new Response('')
    }
    return new Response('')
  }

  if (p.type === 'view_submission') {
    const me = await resolveUser(db, p.user?.id)
    if (!me) {
      return json({ response_action: 'errors', errors: { reason: t('zh', 'no_account_heading') } })
    }
    const lang = normalizeLang(me.language)
    if (p.view.callback_id === 'submit_leave') return await handleLeaveSubmit(db, me, lang, p)
    if (p.view.callback_id === 'submit_reject') return await handleRejectSubmit(db, me, lang, p)
    if (p.view.callback_id === 'submit_dispute') return await handleDisputeSubmit(db, me, lang, p)
    if (p.view.callback_id === 'submit_hr_register') return await handleHrRegisterSubmit(db, me, lang, p)
  }

  return new Response('')
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

// ---- 送出假單 ----

async function handleLeaveSubmit(db: SupabaseClient, me: any, lang: Lang, p: Record<string, any>) {
  const v = p.view.state.values
  const pick = (block: string) => v[block]?.v?.selected_option?.value ?? null
  const leaveTypeId = pick('leave_type')
  const startDate = v.start_date?.v?.selected_date
  const endDate = v.end_date?.v?.selected_date
  const startTime = pick('start_time') ?? '09:00'
  const endTime = pick('end_time') ?? '18:00'
  const proxyId = pick('proxy')
  const reason = v.reason?.v?.value ?? ''

  if (endDate < startDate) {
    return json({ response_action: 'errors', errors: { end_date: t(lang, 'err_end_before_start') } })
  }

  const isMultiDay = endDate > startDate
  const hours = isMultiDay ? null : calcHours(startTime, endTime)
  if (!isMultiDay && (hours ?? 0) <= 0) {
    return json({ response_action: 'errors', errors: { end_time: t(lang, 'err_end_time_before_start') } })
  }
  if (!me.default_flow_id) {
    return json({ response_action: 'errors', errors: { reason: t(lang, 'err_no_flow') } })
  }

  // 這裡原本會擋下超過年度額度的申請（網頁版送出時也有同一道）。
  // 2026-09 依需求兩邊一起移除：額度用完仍然可以請，超額怎麼處理交給人資
  // 判斷，不是系統該擋的。查餘額時餘額會顯示成負數，使用者看得出來超了多少。

  // 只查 is_wfh：選了 WFH 時那一格會被藏起來，但「先選了代理人才改成 WFH」
  // 的殘留值還是可能被送上來，所以這裡再清一次（跟網頁版同一道保險）。
  const { data: leaveType } = await db
    .from('leave_types').select('is_wfh').eq('id', leaveTypeId).maybeSingle()

  const { data: created, error } = await db.from('leave_requests').insert({
    requester_id: me.id,
    leave_type_id: leaveTypeId,
    flow_id: me.default_flow_id,
    start_date: startDate,
    end_date: endDate,
    start_time: isMultiDay ? '09:00' : startTime,
    end_time: isMultiDay ? '18:00' : endTime,
    hours,
    proxy_user_id: leaveType?.is_wfh ? null : proxyId,
    reason,
    status: 'pending',
    current_step: 1,
  }).select('id').single()

  if (error) {
    return json({ response_action: 'errors', errors: { reason: t(lang, 'err_submit_failed', { msg: error.message }) } })
  }

  // 假單已經寫進資料庫，剩下的通知使用者不需要等 —— 全部丟到背景，
  // 讓 Slack 立刻收到「關閉表單」的回應，避免 3 秒逾時跳出「連線時遇到
  // 一些問題」（工作其實有做完，只是回應太慢）。
  background((async () => {
    const { data: leave } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', created.id).single()
    const row = leave as unknown as LeaveRow

    const steps = await approversForStep(db, me.default_flow_id, 1)
    if (steps.length === 0) {
      // 沒有設定任何簽核關卡＝不需審核（目前只有老闆是這種設定），與網頁版一致。
      // 這條路徑一樣要走完「核准後」該做的事 —— 之前這裡直接改狀態就結束，
      // 導致這種員工當天臨時請假時頻道上沒有任何人知道。
      await db.from('leave_requests').update({ status: 'approved' }).eq('id', created.id)
      // 申請人自己不重複發：他等一下就會收到下面那則「假單已送出／此流程不需
      // 簽核，已自動核准」，再多一則「假單已核准」只是同一件事講兩次。
      await notifyApprovedRecipients(db, row, { includeRequester: false })
      await notifyProxy(db, row)
      await notifyChannelIfToday(db, row)
    } else {
      await notifyApprovers(db, row)
    }

    if (me.slack_user_id) {
      await dm(me.slack_user_id, t(lang, 'leave_submitted_text'), [
        section(t(lang, 'leave_submitted_heading', { detail: leaveDetailLines(row, lang) })),
        contextLine(steps.length === 0 ? t(lang, 'leave_submitted_no_flow') : t(lang, 'leave_submitted_pending')),
        // 「收回假單」只有在還要送審時才給 —— 沒有簽核關卡的人一送出就是
        // 已核准，而已核准的假單不能收回（使用者明確要求，2026-09）。
        ...(steps.length === 0 ? [] : [{
          type: 'actions',
          elements: [{
            type: 'button', text: { type: 'plain_text', text: t(lang, 'btn_withdraw'), emoji: true },
            action_id: 'withdraw_leave', value: created.id,
          }],
        }]),
      ])
    }

    // 撞到自己已報名／排好的按摩 → 提醒釋出（放在「假單已送出」之後，順序才自然）
    await remindMassageForLeave(db, created.id, me, 'hit_heading_self')
  })())

  return json({ response_action: 'clear' })
}

// ---- 核准 ----

function handleApprove(db: SupabaseClient, me: any, lang: Lang, requestId: string, responseUrl: string) {
  // 按鈕點擊同樣有 3 秒回應限制，所以整段做完再回應會逾時。改成立刻回應、
  // 實際處理走背景 —— 使用者看到的結果是原訊息被改寫（透過 response_url），
  // 那個動作本來就是非同步的，不需要卡在這次 HTTP 回應裡。
  background((async () => {
    const { data } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', requestId).single()
    const leave = data as unknown as LeaveRow

    const guard = await guardApproval(db, me, leave, lang)
    if (guard) {
      await replaceMessage(responseUrl, guard, [section(`:information_source: ${guard}`)])
      return
    }

    await db.from('leave_approvals').insert({
      request_id: leave.id, approver_id: me.id, step_order: leave.current_step, action: 'approved',
    })

    const { data: allSteps } = await db
      .from('approval_flow_steps').select('step_order').eq('flow_id', leave.flow_id)
    const maxStep = Math.max(...(allSteps ?? []).map(s => s.step_order))
    const isFinal = (leave.current_step ?? 1) >= maxStep

    if (isFinal) {
      await db.from('leave_requests').update({ status: 'approved' }).eq('id', leave.id)
    } else {
      await db.from('leave_requests').update({ current_step: (leave.current_step ?? 1) + 1 }).eq('id', leave.id)
    }

    const now = new Date(Date.now() + 8 * 3600 * 1000)
    // 這則「已於 X 核准」是寫給按下核准的那個人（me）看的，所以用 me.language。
    const stamp = `${now.getUTCMonth() + 1}月${now.getUTCDate()}日 ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`

    // 按鈕換成結果文字，避免重複點或看不出自己按過了
    await replaceMessage(responseUrl, t(lang, 'approved_replace_text'), [
      section(t(lang, 'approved_replace_heading', { detail: leaveDetailLines(leave, lang) })),
      contextLine(isFinal ? t(lang, 'approved_stamp_final', { stamp }) : t(lang, 'approved_stamp_next', { stamp })),
    ])

    if (isFinal) {
      await notifyApprovedRecipients(db, leave)
      await notifyProxy(db, leave)
      await notifyChannelIfToday(db, leave)
    } else {
      await notifyApprovers(db, { ...leave, current_step: (leave.current_step ?? 1) + 1 })
    }
  })())

  return new Response('')
}

// ---- 駁回 ----

async function handleRejectSubmit(db: SupabaseClient, me: any, lang: Lang, p: Record<string, any>) {
  const meta = JSON.parse(p.view.private_metadata || '{}')
  const comment = (p.view.state.values.comment?.v?.value ?? '').trim()
  if (!comment) return json({ response_action: 'errors', errors: { comment: t(lang, 'err_reject_reason_required') } })

  const { data } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', meta.request_id).single()
  const leave = data as unknown as LeaveRow

  const guard = await guardApproval(db, me, leave, lang)
  if (guard) return json({ response_action: 'errors', errors: { comment: guard } })

  await db.from('leave_approvals').insert({
    request_id: leave.id, approver_id: me.id, step_order: leave.current_step,
    action: 'rejected', comment,
  })
  await db.from('leave_requests').update({ status: 'rejected' }).eq('id', leave.id)

  // 狀態已經寫進資料庫，通知丟背景讓表單立刻關閉（同樣避免 3 秒逾時）。
  // 把關與寫入刻意留在同步段：那兩件事的結果決定表單要關掉還是顯示錯誤。
  background((async () => {
    if (meta.response_url) {
      const detail = leaveDetailLines(leave, lang, [t(lang, 'detail_reject_reason', { reason: comment })])
      await replaceMessage(meta.response_url, t(lang, 'rejected_replace_text'), [
        section(t(lang, 'rejected_replace_heading', { detail })),
      ])
    }
    if (leave.requester?.slack_user_id) {
      const requesterLang = normalizeLang(leave.requester.language)
      const requesterDetail = leaveDetailLines(leave, requesterLang, [t(requesterLang, 'detail_reject_reason', { reason: comment })])
      await dm(leave.requester.slack_user_id, t(requesterLang, 'rejected_dm_text'), [
        section(t(requesterLang, 'rejected_dm_heading', { detail: requesterDetail })),
      ])
    }
  })())

  return json({ response_action: 'clear' })
}

// ---- 收回假單 ----

/**
 * 收回前的把關。回傳字串代表擋下並說明原因，null 代表可以動作。
 *
 * 「已核准的假單絕對不能收回」是使用者明確要求的規則（2026-09）—— 已核准的
 * 假可能已經出現在早上的公告裡、時數也已經計入，讓申請人自己抽掉會讓帳跟
 * 大家看到的事實對不起來。核准後才發現請錯日期的話，走 HR 更正。
 */
function guardWithdraw(me: any, leave: LeaveRow | null, lang: Lang): string | null {
  if (!leave) return t(lang, 'guard_not_found')
  // Slack 的互動請求是外部可以偽造 payload 的路徑，所以要驗這張是不是他自己的
  if (leave.requester?.id !== me.id) return t(lang, 'withdraw_guard_not_yours')
  if (leave.status === 'approved') return t(lang, 'withdraw_guard_approved')
  if (leave.status !== 'pending') {
    const statusKey = ({ rejected: 'status_rejected', withdrawn: 'status_withdrawn', returned: 'status_returned' } as const)[leave.status]
    return t(lang, 'withdraw_guard_not_pending', { status: statusKey ? t(lang, statusKey) : leave.status })
  }
  return null
}

function handleWithdraw(db: SupabaseClient, me: any, lang: Lang, requestId: string, responseUrl: string) {
  // 按鈕點擊有 3 秒回應限制，處理走背景（同 handleApprove）。
  background((async () => {
    const { data } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', requestId).single()
    const leave = data as unknown as LeaveRow

    const guard = guardWithdraw(me, leave, lang)
    if (guard) {
      await replaceMessage(responseUrl, guard, [section(`:information_source: ${guard}`)])
      return
    }

    // 條件寫在 update 裡（.eq('status', 'pending')），不是先查再寫 ——
    // 主管剛好在同一秒按下核准的話，這樣才不會把已經核准的假單改成收回。
    // 那種情況會回 0 列，走下面那條訊息。
    const { data: updated, error } = await db.from('leave_requests')
      .update({ status: 'withdrawn' })
      .eq('id', leave.id).eq('status', 'pending').select()

    if (error || !updated?.length) {
      const msg = t(lang, 'withdraw_guard_race')
      await replaceMessage(responseUrl, msg, [section(`:information_source: ${msg}`)])
      return
    }

    // 自己這則換成結果，並附「重新填寫」—— 收回多半是因為日期填錯，
    // 這時候最想做的就是立刻重填一張，不該再要他自己去找入口。
    await replaceMessage(responseUrl, t(lang, 'withdraw_done_text'), [
      section(t(lang, 'withdraw_done_heading', { detail: leaveDetailLines(leave, lang) })),
      contextLine(t(lang, 'withdraw_done_note')),
      {
        type: 'actions',
        elements: [{
          type: 'button', style: 'primary',
          text: { type: 'plain_text', text: t(lang, 'btn_refill'), emoji: true },
          action_id: 'open_leave_form', value: 'open',
        }],
      },
    ])

    await markApproverMessagesWithdrawn(db, leave)
  })())

  return new Response('')
}

/**
 * 把簽核人那幾則「有一張假單待您審核」改寫成「此假單已被收回」，按鈕一併消失。
 *
 * 位置是當初發通知時記下來的（approver_message_refs）。改寫失敗不影響收回
 * 本身 —— 假單狀態已經寫進資料庫了，那才是結算依據；而且就算這則訊息沒改到，
 * 簽核人按下核准也會被 guardApproval 擋下來並顯示「已由申請人收回」。
 */
async function markApproverMessagesWithdrawn(db: SupabaseClient, leave: LeaveRow) {
  const refs = leave.approver_message_refs
  if (!Array.isArray(refs) || refs.length === 0) return

  for (const ref of refs) {
    if (!ref?.channel || !ref?.ts) continue
    // 用當初發送時的語言改寫，不是用收回者的語言 —— 這則是寫給簽核人看的
    const lang = normalizeLang(ref.lang)
    await callSlack('chat.update', {
      channel: ref.channel,
      ts: ref.ts,
      text: t(lang, 'approver_withdrawn_text', { name: leave.requester?.full_name ?? '' }),
      blocks: [
        section(t(lang, 'approver_withdrawn_heading', { detail: leaveDetailLines(leave, lang) })),
        contextLine(t(lang, 'approver_withdrawn_note')),
      ],
    })
  }

  // 訊息已經不是待審核狀態了，位置留著沒有意義，清掉免得日後誤用
  await db.from('leave_requests').update({ approver_message_refs: null }).eq('id', leave.id)
}

// ---- 代登記假單：確認 / 提出修改異議 ----

/**
 * 按下確認或異議之前的把關。回傳字串代表擋下並說明原因，null 代表可以動作。
 *
 * 跟核准那邊一樣，一律用資料庫「當下」的狀態判斷，不信任按鈕帶的東西 ——
 * 那則私訊可能是三天前發的，這筆早就在網頁上按過確認，或者已經自動確認了。
 */
function guardAck(me: any, leave: LeaveRow | null, lang: Lang): string | null {
  if (!leave) return t(lang, 'guard_not_found')
  if (!leave.registered_by) return t(lang, 'ack_guard_not_registered')
  // 按鈕的 value 是假單 id，理論上只有收到那則私訊的人看得到按鈕；但 Slack
  // 的互動請求是「任何人都能偽造 payload 打進來」的路徑，所以還是要驗一次
  // 這筆是不是登記給他的 —— 不然別人可以幫你按確認。
  if (leave.requester?.id !== me.id) return t(lang, 'ack_guard_not_yours')
  if (leave.acknowledged_at) return t(lang, 'ack_guard_already_acked')
  if (leave.disputed_at) return t(lang, 'ack_guard_already_disputed')
  return null
}

/** 台北時間的「9月16日 10:59」。 */
function taipeiStamp(): string {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  return `${now.getUTCMonth() + 1}月${now.getUTCDate()}日 ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`
}

function handleAcknowledge(db: SupabaseClient, me: any, lang: Lang, requestId: string, responseUrl: string) {
  // 按鈕點擊有 3 秒回應限制，處理走背景（同 handleApprove）。
  background((async () => {
    const { data } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', requestId).single()
    const leave = data as unknown as LeaveRow

    const guard = guardAck(me, leave, lang)
    if (guard) {
      await replaceMessage(responseUrl, guard, [section(`:information_source: ${guard}`)])
      return
    }

    await db.from('leave_requests')
      .update({ acknowledged_at: new Date().toISOString(), auto_acknowledged: false })
      .eq('id', leave.id)

    // 按鈕換成結果文字，避免重複點或看不出自己按過了
    await replaceMessage(responseUrl, t(lang, 'ack_done_text'), [
      section(t(lang, 'ack_done_heading', { detail: leaveDetailLines(leave, lang) })),
      contextLine(t(lang, 'ack_done_stamp', { stamp: taipeiStamp() })),
    ])
  })())

  return new Response('')
}

/**
 * 送出修改異議。
 *
 * 刻意「不」改動假單狀態 —— 維持已核准、時數照算（2026-09 與使用者確認）。
 * 系統不自動判斷誰對誰錯，只負責把話傳到並留下紀錄，改不改由 HR 判斷。
 *
 * 但 disputed_at 一填上去，逾期自動確認那支排程就會跳過這一筆：同仁已經明確
 * 表示過不同意，再套用「未提出異議視同確認」在勞資爭議上站不住腳 —— 那句話
 * 的前提就是「沒有提出異議」。
 */
async function handleDisputeSubmit(db: SupabaseClient, me: any, lang: Lang, p: Record<string, any>) {
  const meta = JSON.parse(p.view.private_metadata || '{}')
  const reason = (p.view.state.values.reason?.v?.value ?? '').trim()
  if (!reason) return json({ response_action: 'errors', errors: { reason: t(lang, 'err_dispute_reason_required') } })

  const { data } = await db.from('leave_requests').select(LEAVE_SELECT).eq('id', meta.request_id).single()
  const leave = data as unknown as LeaveRow

  const guard = guardAck(me, leave, lang)
  if (guard) return json({ response_action: 'errors', errors: { reason: guard } })

  const { data: updated, error } = await db.from('leave_requests')
    .update({ disputed_at: new Date().toISOString(), dispute_reason: reason })
    .eq('id', leave.id).select()
  if (error || !updated?.length) {
    return json({ response_action: 'errors', errors: { reason: t(lang, 'err_submit_failed', { msg: error?.message ?? '0 rows' }) } })
  }

  // 異議已經寫進資料庫，通知丟背景讓表單立刻關閉（避免 3 秒逾時）。
  background((async () => {
    if (meta.response_url) {
      await replaceMessage(meta.response_url, t(lang, 'dispute_done_text'), [
        section(t(lang, 'dispute_done_heading', { detail: leaveDetailLines(leave, lang) })),
        contextLine(t(lang, 'dispute_done_stamp')),
      ])
    }
    await notifyDisputeToHr(db, leave, reason)
  })())

  return json({ response_action: 'clear' })
}

/**
 * 通知「登記那筆的 HR 本人」（registered_by），不是全體 HR ——
 * 誰登的誰處理，責任最清楚（2026-09 與使用者確認）。
 */
async function notifyDisputeToHr(db: SupabaseClient, leave: LeaveRow, reason: string) {
  if (!leave.registered_by) return
  const { data: hr } = await db
    .from('users').select('slack_user_id, language').eq('id', leave.registered_by).maybeSingle()
  if (!hr?.slack_user_id) return

  const lang = normalizeLang(hr.language)
  const detail = leaveDetailLines(leave, lang, [t(lang, 'dispute_hr_reason', { reason })])
  await dm(hr.slack_user_id, t(lang, 'dispute_hr_text', { name: leave.requester?.full_name ?? '' }), [
    section(t(lang, 'dispute_hr_heading', { detail })),
    contextLine(t(lang, 'dispute_hr_note')),
  ])
}

/**
 * 核准／駁回前的把關。回傳字串代表擋下並說明原因，回傳 null 代表可以動作。
 * 訊息用 `lang`（動作發起人 me 的語言）—— 這是唯一會直接顯示給他看的文字。
 *
 * 一律用資料庫「當下」的狀態判斷，不信任按鈕上帶的任何東西 —— 那顆按鈕可能
 * 是三天前發出的，這張假單早就在網頁上被處理掉了，或流程已經走到別關。
 */
async function guardApproval(db: SupabaseClient, me: any, leave: LeaveRow | null, lang: Lang): Promise<string | null> {
  if (!leave) return t(lang, 'guard_not_found')
  if (leave.status !== 'pending') {
    const statusKey = ({ approved: 'status_approved', rejected: 'status_rejected', withdrawn: 'status_withdrawn', returned: 'status_returned' } as const)[leave.status]
    const label = statusKey ? t(lang, statusKey) : leave.status
    return t(lang, 'guard_already_handled', { status: label })
  }
  if (!leave.flow_id || !leave.current_step) return t(lang, 'guard_no_flow')

  const steps = await approversForStep(db, leave.flow_id, leave.current_step)
  if (!steps.some(s => s.approver_id === me.id)) {
    return t(lang, 'guard_not_your_turn', { n: leave.current_step })
  }
  return null
}

/**
 * 核准後通知職務代理人。
 *
 * 刻意等到核准後才發 —— 假單還沒過就先通知，萬一被駁回，代理人已經以為
 * 要代班了。代理人的 Slack ID 沒填就安靜略過（跟其他通知一致）。
 *
 * 代理人同時也是「核准通知對象」時會另外收到一則「假單已核准」，這裡不做
 * 去重 —— 兩則講的是不同的事（一則知會、一則有交辦動作），使用者要求兩則
 * 都留（2026-09 確認）。
 */
async function notifyProxy(db: SupabaseClient, leave: LeaveRow) {
  const { data } = await db
    .from('leave_requests')
    .select('proxy:users!leave_requests_proxy_user_id_fkey(slack_user_id, language)')
    .eq('id', leave.id).maybeSingle()

  const proxy = (data as { proxy?: { slack_user_id?: string; language?: string } } | null)?.proxy
  if (!proxy?.slack_user_id) return
  const lang = normalizeLang(proxy.language)
  await dm(proxy.slack_user_id, t(lang, 'proxy_text', { name: leave.requester?.full_name ?? '' }), [
    section(t(lang, 'proxy_heading', { detail: leaveDetailLines(leave, lang) })),
    contextLine(t(lang, 'proxy_note')),
  ])
}

/**
 * 當天臨時請假：核准當下若假期已涵蓋今天且過了每日公告時間，補一則頻道公告。
 *
 * 在家工作用另一組文字 —— 他有在工作，只是不在辦公室。沿用「今日臨時請假」
 * 的字眼會讓同事以為今天找不到他。早上 9:00 的彙整已經把 WFH 分成獨立一組，
 * 這則補發的公告要跟它一致。
 */
async function notifyChannelIfToday(db: SupabaseClient, leave: LeaveRow) {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const today = now.toISOString().slice(0, 10)
  const coversToday = leave.start_date <= today && leave.end_date >= today
  if (!coversToday || now.getUTCHours() < 9) return

  const channel = Deno.env.get('SLACK_LEAVE_CHANNEL')
  if (!channel) return
  const lang = channelLang()
  const wfh = !!leave.leave_type?.is_wfh
  await callSlack('chat.postMessage', {
    channel,
    text: t(lang, wfh ? 'today_wfh_text' : 'today_leave_text', { name: leave.requester?.full_name ?? '' }),
    blocks: [
      section(t(lang, wfh ? 'today_wfh_heading' : 'today_leave_heading', { line: digestLine(leave, lang, { markFullDay: true }) })),
      contextLine(t(lang, wfh ? 'today_wfh_note' : 'today_leave_note')),
    ],
  })
}

// ===== 按摩預約 =====
//
// 私訊打「按摩」→ 回一張卡片：最近的幾期、我的狀態、該有的按鈕。
// 所有按摩相關的按鈕（卡片上的、massage-notify 發的私訊與頻道公告上的）
// 都在這裡處理。規則全部在資料庫函式（*_as 版本，帶入對應到的系統帳號），
// 這裡只負責把結果翻成文字 —— 跟網頁一樣，不在這裡重算任何規則。
//
// ⚠️ 時間格式與「請釋出名額」提醒的文字跟 massage-notify 重複（兩支都要能
// 單獨貼進網頁編輯器），改的話兩邊都要改。

const MT = {
  zh: {
    weekdays: '日一二三四五六',
    date: '{m}/{d}（{w}）',
    slot: '時段 {n}（{from}–{to}）',

    card_text: '💆 按摩預約',
    card_empty: '💆 目前沒有開放中的按摩預約。開放報名時會在頻道公告。',
    card_heading: '💆 *{title}*\n{date} {from}–{to}・名額 {n} 位',
    phase_open: '報名中，{deadline} 截止・目前 {k} 人報名',
    phase_closed: '報名已截止，等待抽籤・共 {k} 人報名',
    phase_drawn: '已抽籤',
    me_none_open: '你還沒報名。',
    me_none: '你沒有報名這一期。',
    me_signed: '✅ 你已報名（第 {pos} 位報名）。',
    me_slot: '✅ 你的{slot}。',
    me_slot_conflict: '⚠️ 這個時段跟你的請假撞到了，請找同仁交換，換好後告訴負責人。',
    me_waitlist: '你是候補第 {k} 位。',
    me_offer: '🎉 {slot} 有空位，輪到你了！',
    me_offer_until: '請在 {time} 前按「我要」。',
    me_yield: '你上一期已經按過摩囉！這期也很幸運地抽中了 🎉 如果你願意，可以把名額讓給還在候補、還沒按到的同仁，讓更多人有機會體驗。要不要讓完全由你決定，選擇保留也完全沒問題。',
    me_released: '你已取消這一期。',
    me_release_held: '你已釋出{slot}，{time} 前仍可取消釋出名額。',
    me_attended: '✅ 已記錄你有按到。',
    me_no_show: '這一期記錄為未到。',

    btn_signup: '報名',
    btn_withdraw: '取消報名',
    btn_release: '釋出名額',
    btn_leave_waitlist: '退出候補',
    btn_accept: '我要',
    btn_yield_keep: '這次我想保留',
    btn_yield_give: '讓給候補同仁',
    btn_done: '已完成',
    btn_list: '看名單',

    confirm_cancel: '先不要',
    confirm_withdraw_title: '取消報名？',
    confirm_withdraw_text: '取消後如果想再報名，會排到最後面。',
    confirm_release_title: '釋出名額？',
    confirm_release_text: '名額會交給候補或開放其他同仁報名，釋出之後不能再改回來。',
    confirm_release_text_held: '釋出後，名額會在 {time} 交給候補或開放其他同仁報名；在那之前你都可以取消釋出。確定要釋出嗎？',
    confirm_waitlist_title: '退出候補？',
    confirm_waitlist_text: '退出之後就不會再收到遞補邀請。',
    confirm_yield_title: '讓給候補？',
    confirm_yield_text: '名額會交給候補第一位，讓出之後不能再改回來。',

    list_text: '💆 {title} 名單',
    list_signups: '*{title}* 報名名單（{k} 人）\n{lines}',
    list_empty: '*{title}* 還沒有人報名。',
    list_drawn: '*{title}* 名單',
    list_selected_h: '*時段表*',
    list_empty_slot: '_無人預約_',
    list_waitlist_h: '*候補*（依順位）',

    ok_signed_up: '✅ 報名成功！',
    ok_partial_leave: '你在按摩時間有部分請假，排時段時會自動避開。',
    ok_withdrew: '已取消報名。',
    ok_released: '已釋出名額，會交給候補或開放其他同仁報名。',
    ok_released_late: '已釋出名額，會交給候補或開放其他同仁報名。',
    ok_released_held: '已釋出名額。{time} 前仍可取消釋出（卡片或私訊裡的「取消釋出」）。',
    ok_release_cancelled: '✅ 已取消釋出，{slot}照原本安排。',
    btn_cancel_release: '取消釋出',
    cancel_release_closed: '已超過 {time}，無法取消釋出。',
    cancel_release_taken: '名額已安排給其他同仁，無法取消釋出。',
    cancel_release_none: '你沒有釋出中的時段。',
    grab_ok: '✅ 你報名到{slot}了！時段開始前 10 分鐘會再提醒你。',
    grab_has_slot: '你這期已經有時段囉（{slot}），把機會留給其他同仁吧 😊',
    grab_leave: '這個時段你剛好請假（{leave}），請好好休息 🙏',
    grab_taken: '名額已滿。',
    grab_over: '這個時段已經結束。',
    grab_not_open: '名額還沒開放（{time} 開放）。',
    ok_left_waitlist: '已退出候補。',
    ok_accepted: '🎉 {slot} 是你的了！',
    ok_kept: '好的，名額幫你保留。',
    ok_yielded: '謝謝你！名額已讓給候補的同仁。',
    ok_done: '✅ 已記錄你有按到。',

    err_unknown: '操作失敗，請稍後再試一次，或到網頁操作。',
    err_session_not_found: '找不到這一期',
    err_already_drawn: '這一期已經抽過籤了',
    err_signup_closed: '報名已截止',
    err_user_inactive: '帳號已停用',
    err_leave_conflict: '你在按摩時間有請假，無法報名',
    err_already_signed_up: '你已經報名了',
    err_not_found: '找不到這筆資料',
    err_already_released: '已經取消過了',
    err_slot_over: '這個時段已經結束了',
    err_no_pending_offer: '這個邀請已經失效（可能已過期，或已安排給別人）',
    err_offer_expired: '這個邀請已經過期，已改問下一位候補',
    err_slot_taken: '這個時段已經有人了',
    err_not_started: '時段還沒開始',
    err_already_marked: '已經標記過了',
    err_no_slot: '你沒有時段',
    err_not_asked: '沒有詢問你要不要讓出',
    err_already_answered: '你已經回答過了',

    bad_id_text: '⚠️ 有同仁收不到按摩通知',
    bad_id_heading: '⚠️ *{name}* 的 Slack User ID（`{id}`）無效，系統私訊不到對方，所以收不到按摩通知。\n請到網頁「管理後台 → 員工帳號」更正。',
    bad_id_missed: '這次沒送到的通知：{what}。同一個錯誤的 ID 只會提醒一次；更正之後，之後的通知就會正常送達（已經錯過的不會補發）。',
    hit_text: '💆 請釋出按摩名額',
    hit_heading_self: '💆 你剛請的假跟按摩預約撞到了，請把名額釋出給其他同仁：',
    hit_heading_hr: '💆 HR 幫你登記的假跟按摩預約撞到了，請把名額釋出給其他同仁：',
    hit_line_slot: '*{title}*（{date}）{slot}',
    hit_line_waitlist: '*{title}*（{date}）候補中',
    hit_line_signed: '*{title}*（{date}）已報名，等待抽籤',
  },
  en: {
    weekdays: 'SunMonTueWedThuFriSat',
    date: '{w} {m}/{d}',
    slot: 'slot {n} ({from}–{to})',

    card_text: '💆 Massage booking',
    card_empty: '💆 There is no massage booking open right now. New sessions are announced in the channel.',
    card_heading: '💆 *{title}*\n{date} {from}–{to} · {n} spots',
    phase_open: 'Sign-up open until {deadline} · {k} signed up so far',
    phase_closed: 'Sign-up closed, waiting for the draw · {k} signed up',
    phase_drawn: 'Draw done',
    me_none_open: 'You have not signed up yet.',
    me_none: 'You did not sign up for this session.',
    me_signed: '✅ You are signed up (#{pos} to sign up).',
    me_slot: '✅ Your {slot}.',
    me_slot_conflict: '⚠️ This slot overlaps your leave. Please swap with a colleague and let the organizer know.',
    me_waitlist: 'You are #{k} on the waitlist.',
    me_offer: '🎉 {slot} is free — it is your turn!',
    me_offer_until: 'Tap "I want it" before {time}.',
    me_yield: "You had a massage last time, and you got lucky again this time 🎉 If you'd like, you can give this spot to a colleague on the waitlist who hasn't had one yet, so more people get a chance. It's entirely your call — keeping it is completely fine too.",
    me_released: 'You cancelled this session.',
    me_release_held: 'You released {slot}. You can undo the release until {time}.',
    me_attended: '✅ Recorded that you got your massage.',
    me_no_show: 'Recorded as a no-show for this session.',

    btn_signup: 'Sign up',
    btn_withdraw: 'Cancel sign-up',
    btn_release: 'Release spot',
    btn_leave_waitlist: 'Leave waitlist',
    btn_accept: 'I want it',
    btn_yield_keep: "I'd like to keep it",
    btn_yield_give: 'Give it to the waitlist',
    btn_done: 'Done',
    btn_list: 'See the list',

    confirm_cancel: 'Not now',
    confirm_withdraw_title: 'Cancel your sign-up?',
    confirm_withdraw_text: 'If you sign up again later, you will be placed last.',
    confirm_release_title: 'Release your spot?',
    confirm_release_text: 'Your spot goes to the waitlist or opens to everyone, and cannot be taken back.',
    confirm_release_text_held: 'Your spot goes to the waitlist or opens to everyone at {time}; until then you can undo the release. Release it?',
    confirm_waitlist_title: 'Leave the waitlist?',
    confirm_waitlist_text: 'You will not receive any more offers for this session.',
    confirm_yield_title: 'Give your spot away?',
    confirm_yield_text: 'Your spot goes to the first person on the waitlist. This cannot be undone.',

    list_text: '💆 {title}: list',
    list_signups: '*{title}*: {k} signed up\n{lines}',
    list_empty: '*{title}*: nobody has signed up yet.',
    list_drawn: '*{title}*',
    list_selected_h: '*Schedule*',
    list_empty_slot: '_No booking_',
    list_waitlist_h: '*Waitlist* (in order)',

    ok_signed_up: '✅ You are signed up!',
    ok_partial_leave: 'You have leave during part of the session; your slot will avoid it.',
    ok_withdrew: 'Sign-up cancelled.',
    ok_released: 'Spot released. It goes to the waitlist or opens to everyone.',
    ok_released_late: 'Spot released. It goes to the waitlist or opens to everyone.',
    ok_released_held: 'Spot released. You can undo it until {time} ("Undo release" on the card or in your DMs).',
    ok_release_cancelled: '✅ Release undone — you keep {slot}.',
    btn_cancel_release: 'Undo release',
    cancel_release_closed: 'It is past {time}, so the release can no longer be undone.',
    cancel_release_taken: 'The slot has already been given to someone else, so the release cannot be undone.',
    cancel_release_none: 'You have no released slot to undo.',
    grab_ok: '✅ You got {slot}! You will get a reminder 10 minutes before it starts.',
    grab_has_slot: 'You already have a slot this time ({slot}) — leave this one for a colleague 😊',
    grab_leave: 'You are on leave during this slot ({leave}) — enjoy your time off 🙏',
    grab_taken: 'Already taken.',
    grab_over: 'This slot is already over.',
    grab_not_open: 'Not open yet (opens {time}).',
    ok_left_waitlist: 'You left the waitlist.',
    ok_accepted: '🎉 {slot} is yours!',
    ok_kept: 'OK, your spot is kept.',
    ok_yielded: 'Thank you! Your spot went to the waitlist.',
    ok_done: '✅ Recorded that you got your massage.',

    err_unknown: 'Something went wrong. Please try again later or use the website.',
    err_session_not_found: 'Session not found',
    err_already_drawn: 'The draw for this session is already done',
    err_signup_closed: 'Sign-up is closed',
    err_user_inactive: 'This account is inactive',
    err_leave_conflict: 'You are on leave during the massage time and cannot sign up',
    err_already_signed_up: 'You are already signed up',
    err_not_found: 'Record not found',
    err_already_released: 'Already cancelled',
    err_slot_over: 'This slot is already over',
    err_no_pending_offer: 'This offer is no longer valid (it expired or was given to someone else)',
    err_offer_expired: 'This offer expired; the next person on the waitlist has been asked',
    err_slot_taken: 'Someone already has this slot',
    err_not_started: 'Your slot has not started yet',
    err_already_marked: 'Already marked',
    err_no_slot: 'You do not have a slot',
    err_not_asked: 'You were not asked to give up your spot',
    err_already_answered: 'You already answered',

    bad_id_text: '⚠️ Someone is not getting massage notifications',
    bad_id_heading: "⚠️ *{name}*'s Slack User ID (`{id}`) is invalid, so the system cannot DM them and they are not getting massage notifications.\nPlease fix it under Admin → Employee accounts on the website.",
    bad_id_missed: 'Missed this time: {what}. You are told only once per wrong ID; once it is fixed, later notifications arrive normally (missed ones are not resent).',
    hit_text: '💆 Please release your massage spot',
    hit_heading_self: '💆 The leave you just filed overlaps your massage booking. Please release your spot for others:',
    hit_heading_hr: '💆 The leave HR registered for you overlaps your massage booking. Please release your spot for others:',
    hit_line_slot: '*{title}* ({date}) {slot}',
    hit_line_waitlist: '*{title}* ({date}) on the waitlist',
    hit_line_signed: '*{title}* ({date}) signed up, waiting for the draw',
  },
} as const

type MKey = keyof typeof MT['zh']

function mt(lang: Lang, key: MKey, params?: Record<string, string | number>): string {
  let text: string = MT[lang]?.[key] ?? MT.zh[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) text = text.split(`{${k}}`).join(String(v))
  return text
}

/** 資料庫回傳的錯誤代碼 → 文字。不認得的代碼一律用通用訊息。 */
function massageErr(lang: Lang, code: string | undefined): string {
  const key = `err_${code}` as MKey
  return `⚠️ ${key in MT.zh ? mt(lang, key) : mt(lang, 'err_unknown')}`
}

// ---- 時間（台灣全年 UTC+8） ----

interface MSession {
  id: string; title: string; session_date: string; start_time: string
  slot_minutes: number; break_minutes: number; slot_count: number
  signup_deadline: string; cancel_deadline: string; drawn_at: string | null
  release_open_at: string; release_opened_at: string | null
}
const M_SESSION_COLS = 'id, title, session_date, start_time, slot_minutes, break_minutes, slot_count, signup_deadline, cancel_deadline, drawn_at, release_open_at, release_opened_at'

const mToMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}
const mFmtMin = (total: number) =>
  `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`

function mSlotRange(s: MSession, n: number) {
  const start = mToMin(String(s.start_time).slice(0, 5)) + (n - 1) * (s.slot_minutes + s.break_minutes)
  return { from: mFmtMin(start), to: mFmtMin(start + s.slot_minutes) }
}
function mWindow(s: MSession) {
  const start = mToMin(String(s.start_time).slice(0, 5))
  return { from: mFmtMin(start), to: mFmtMin(start + s.slot_count * (s.slot_minutes + s.break_minutes)) }
}
const mAt = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+08:00`)
const mTaipeiToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

function mDate(lang: Lang, date: string) {
  const d = new Date(`${date}T00:00:00Z`)
  const w = lang === 'en'
    ? MT.en.weekdays.slice(d.getUTCDay() * 3, d.getUTCDay() * 3 + 3)
    : MT.zh.weekdays[d.getUTCDay()]
  return mt(lang, 'date', { m: d.getUTCMonth() + 1, d: d.getUTCDate(), w })
}
function mDateTime(lang: Lang, iso: string) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000)
  return `${mDate(lang, d.toISOString().slice(0, 10))} ${mFmtMin(d.getUTCHours() * 60 + d.getUTCMinutes())}`
}
const mSlot = (lang: Lang, s: MSession, n: number) => mt(lang, 'slot', { n, ...mSlotRange(s, n) })

/** 釋出等待期：抽過籤、還沒到釋出開放時間（這段時間釋出的可以取消；跟資料庫的 massage_release_held 同一個判斷） */
const mHeld = (s: MSession) => !!s.drawn_at && !s.release_opened_at && Date.now() < new Date(s.release_open_at).getTime()

/** 釋出開放時間 →「10/28（三）上午 11:00」（massage-notify 有一份一樣的） */
function mFmtOpens(lang: Lang, iso: string) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000)
  const h = d.getUTCHours()
  const m = String(d.getUTCMinutes()).padStart(2, '0')
  const date = mDate(lang, d.toISOString().slice(0, 10))
  if (lang === 'en') return `${date} ${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`
  return `${date}${h < 12 ? '上午' : '下午'} ${h % 12 || 12}:${m}`
}

/** 「釋出名額」的確認視窗：等待期間會說明幾點前可以取消釋出 */
function mReleaseConfirm(lang: Lang, s: MSession) {
  const text = mHeld(s)
    ? mt(lang, 'confirm_release_text_held', { time: mFmtOpens(lang, s.release_open_at) })
    : mt(lang, 'confirm_release_text')
  return {
    title: { type: 'plain_text', text: mt(lang, 'confirm_release_title') },
    text: { type: 'mrkdwn', text },
    confirm: { type: 'plain_text', text: mt(lang, 'btn_release') },
    deny: { type: 'plain_text', text: mt(lang, 'confirm_cancel') },
  }
}

// ---- 按鈕 ----

const mButton = (text: string, action_id: string, value: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'button', text: { type: 'plain_text', text, emoji: true }, action_id, value, ...extra })
const mConfirm = (lang: Lang, title: MKey, text: MKey, ok: string) => ({
  title: { type: 'plain_text', text: mt(lang, title) },
  text: { type: 'mrkdwn', text: mt(lang, text) },
  confirm: { type: 'plain_text', text: ok },
  deny: { type: 'plain_text', text: mt(lang, 'confirm_cancel') },
})

// ---- 卡片 ----

interface MSignup {
  id: string; user_id: string; signed_up_at: string; draw_rank: number | null; slot_no: number | null
  slot_conflict: boolean; released_at: string | null; yield_asked: boolean; yield_answer: string | null
  offer_status: string | null; offer_slot_no: number | null; offer_expires_at: string | null
  attendance: string | null
}
const M_SIGNUP_COLS = 'id, user_id, signed_up_at, draw_rank, slot_no, slot_conflict, released_at, yield_asked, yield_answer, offer_status, offer_slot_no, offer_expires_at, attendance'

/** 還沒結束的期數，最多 3 期（最近的在前） */
async function upcomingMassageSessions(db: SupabaseClient): Promise<MSession[]> {
  const { data } = await db.from('massage_sessions').select(M_SESSION_COLS)
    .gte('session_date', mTaipeiToday()).order('session_date').limit(6)
  const now = new Date()
  return ((data ?? []) as MSession[])
    .filter(s => now < mAt(s.session_date, mWindow(s).to))
    .slice(0, 3)
}

async function massageCardBlocks(db: SupabaseClient, me: any, lang: Lang): Promise<unknown[]> {
  const sessions = await upcomingMassageSessions(db)
  if (sessions.length === 0) return [section(mt(lang, 'card_empty'))]

  const now = new Date()
  const blocks: unknown[] = []
  for (const s of sessions) {
    const { data } = await db.from('massage_signups').select(M_SIGNUP_COLS).eq('session_id', s.id)
    const all = (data ?? []) as MSignup[]
    const active = all.filter(g => !g.released_at)
    const mine = all.find(g => g.user_id === me.id)
    const phase = s.drawn_at ? 'drawn' : now < new Date(s.signup_deadline) ? 'open' : 'closed'

    const lines = [mt(lang, 'card_heading', { title: s.title, date: mDate(lang, s.session_date), ...mWindow(s), n: s.slot_count })]
    lines.push(phase === 'open'
      ? mt(lang, 'phase_open', { deadline: mDateTime(lang, s.signup_deadline), k: active.length })
      : phase === 'closed' ? mt(lang, 'phase_closed', { k: active.length }) : mt(lang, 'phase_drawn'))

    const buttons: unknown[] = []
    const releaseHeld = !!mine?.released_at && !!mine.slot_no && !!s.drawn_at
      && mine.released_at >= s.drawn_at && mHeld(s)
    if (releaseHeld) {
      // 等待期間釋出的：還可以取消釋出（使用者決定）
      const time = mFmtOpens(lang, s.release_open_at)
      lines.push(mt(lang, 'me_release_held', { slot: mSlot(lang, s, mine!.slot_no!), time }))
      buttons.push(mButton(mt(lang, 'btn_cancel_release'), 'massage_cancel_release', mine!.id, { style: 'primary' }))
    } else if (!mine || mine.released_at) {
      if (mine?.released_at && (phase !== 'open')) lines.push(mt(lang, 'me_released'))
      else lines.push(mt(lang, phase === 'open' ? 'me_none_open' : 'me_none'))
      if (phase === 'open') buttons.push(mButton(mt(lang, 'btn_signup'), 'massage_signup', s.id, { style: 'primary' }))
    } else if (!s.drawn_at) {
      const pos = active.sort((a, b) => a.signed_up_at.localeCompare(b.signed_up_at)).findIndex(g => g.id === mine.id) + 1
      lines.push(mt(lang, 'me_signed', { pos }))
      buttons.push(mButton(mt(lang, 'btn_withdraw'), 'massage_withdraw', mine.id,
        { confirm: mConfirm(lang, 'confirm_withdraw_title', 'confirm_withdraw_text', mt(lang, 'btn_withdraw')) }))
    } else if (mine.slot_no) {
      const slotStart = mAt(s.session_date, mSlotRange(s, mine.slot_no).from)
      const slotEnd = mAt(s.session_date, mSlotRange(s, mine.slot_no).to)
      lines.push(mt(lang, 'me_slot', { slot: mSlot(lang, s, mine.slot_no) }))
      // 跟網頁一樣：抽籤當下的標記，加上「現在」的請假（抽籤之後才請的假也要顯示）
      const { data: okSlots } = await db.rpc('massage_ok_slots', { p_session_id: s.id, p_user_id: me.id })
      const leaveHitsSlot = Array.isArray(okSlots) && !okSlots.includes(mine.slot_no)
      if ((mine.slot_conflict || leaveHitsSlot) && now < slotEnd) lines.push(mt(lang, 'me_slot_conflict'))
      if (mine.attendance === 'attended') lines.push(mt(lang, 'me_attended'))
      else if (mine.attendance === 'no_show') lines.push(mt(lang, 'me_no_show'))
      if (mine.yield_asked && !mine.yield_answer) {
        lines.push(mt(lang, 'me_yield'))
        buttons.push(mButton(mt(lang, 'btn_yield_keep'), 'massage_yield_keep', mine.id))
        buttons.push(mButton(mt(lang, 'btn_yield_give'), 'massage_yield_give', mine.id,
          { confirm: mConfirm(lang, 'confirm_yield_title', 'confirm_yield_text', mt(lang, 'btn_yield_give')) }))
      } else if (now < slotEnd && !mine.attendance) {
        buttons.push(mButton(mt(lang, 'btn_release'), 'massage_release', mine.id,
          { style: 'danger', confirm: mReleaseConfirm(lang, s) }))
      }
      if (now >= slotStart && !mine.attendance) {
        buttons.push(mButton(mt(lang, 'btn_done'), 'massage_done', mine.id, { style: 'primary' }))
      }
    } else {
      const waitlist = active.filter(g => !g.slot_no && g.draw_rank != null)
        .sort((a, b) => (a.draw_rank ?? 0) - (b.draw_rank ?? 0))
      lines.push(mt(lang, 'me_waitlist', { k: waitlist.findIndex(g => g.id === mine.id) + 1 }))
      if (mine.offer_status === 'pending' && mine.offer_slot_no) {
        lines.push(mt(lang, 'me_offer', { slot: mSlot(lang, s, mine.offer_slot_no) }))
        if (mine.offer_expires_at) lines.push(mt(lang, 'me_offer_until', { time: mDateTime(lang, mine.offer_expires_at) }))
        buttons.push(mButton(mt(lang, 'btn_accept'), 'massage_accept', mine.id, { style: 'primary' }))
      }
      buttons.push(mButton(mt(lang, 'btn_leave_waitlist'), 'massage_leave_waitlist', mine.id,
        { confirm: mConfirm(lang, 'confirm_waitlist_title', 'confirm_waitlist_text', mt(lang, 'btn_leave_waitlist')) }))
    }
    // 「看名單」拿掉了（使用者決定）：名單一有變動，頻道就會發一則最新時段表，私訊再看一次像重複通知。
    // 以前發出去的卡片上還留著那顆按鈕，按下去照樣會回名單（下面的 massage_list）。

    if (blocks.length) blocks.push({ type: 'divider' })
    // block_id 用 mcard 開頭：按鈕被按下時，靠它分辨「這是卡片」（要整張換成最新狀態）
    blocks.push({ type: 'section', block_id: `mcard_${s.id}`, text: { type: 'mrkdwn', text: lines.join('\n') } })
    blocks.push({ type: 'actions', block_id: `mcard_act_${s.id}`, elements: buttons })
  }
  return blocks
}

/** 名單：抽籤前照報名先後；抽籤後是正取（照時段）＋候補（照順位）。跟網頁上的公開名單一樣。 */
async function massageListBlocks(db: SupabaseClient, lang: Lang, sessionId: string): Promise<unknown[]> {
  const { data: s } = await db.from('massage_sessions').select(M_SESSION_COLS).eq('id', sessionId).maybeSingle()
  if (!s) return [section(massageErr(lang, 'session_not_found'))]
  const session = s as MSession
  const { data } = await db.from('massage_signups')
    .select('slot_no, draw_rank, signed_up_at, user:users!massage_signups_user_id_fkey(full_name)')
    .eq('session_id', session.id).is('released_at', null)
  const rows = (data ?? []) as any[]
  const name = (r: any) => r.user?.full_name ?? '—'

  if (!session.drawn_at) {
    if (rows.length === 0) return [section(mt(lang, 'list_empty', { title: session.title }))]
    const lines = rows.sort((a, b) => a.signed_up_at.localeCompare(b.signed_up_at)).map((r, i) => `${i + 1}. ${name(r)}`)
    return [section(mt(lang, 'list_signups', { title: session.title, k: rows.length, lines: lines.join('\n') }))]
  }
  // 每個時段都列出來，沒人的寫「無人預約」（跟網頁的時段表一致）
  const bySlot = new Map(rows.filter(r => r.slot_no).map(r => [r.slot_no, name(r)]))
  const selected = Array.from({ length: session.slot_count }, (_, i) => i + 1)
    .map(n => `\`${mSlotRange(session, n).from}\` ${bySlot.get(n) ?? mt(lang, 'list_empty_slot')}`)
  const waitlist = rows.filter(r => !r.slot_no && r.draw_rank != null).sort((a, b) => a.draw_rank - b.draw_rank)
    .map((r, i) => `${i + 1}. ${name(r)}`)
  const blocks: unknown[] = [
    section(mt(lang, 'list_drawn', { title: session.title })),
    section(`${mt(lang, 'list_selected_h')}\n${selected.join('\n') || '—'}`),
  ]
  if (waitlist.length) blocks.push(section(`${mt(lang, 'list_waitlist_h')}\n${waitlist.join('\n')}`))
  return blocks
}

// ---- 打「按摩」 ----

async function replyMassage(db: SupabaseClient, event: Record<string, any>, fallbackLang: Lang) {
  const me = await resolveUser(db, event.user)
  if (!me) {
    await callSlack('chat.postMessage', {
      channel: event.channel, text: t(fallbackLang, 'no_account_text'), blocks: [section(t(fallbackLang, 'no_account_heading'))],
    })
    return
  }
  const lang = normalizeLang(me.language)
  await callSlack('chat.postMessage', { channel: event.channel, text: mt(lang, 'card_text'), blocks: await massageCardBlocks(db, me, lang) })
}

// ---- 按鈕 ----

/**
 * 按下按摩相關的按鈕。立刻回 200（Slack 的 3 秒限制），實際動作走背景，
 * 結果用 response_url 回覆：
 *   · 卡片上的按鈕 → 整張卡片換成最新狀態，最上面加一行結果
 *   · 通知私訊上的按鈕 → 原訊息保留文字、拿掉被按的那顆按鈕，下面加一行結果
 *     （避免重複按）
 *   · 頻道公告上的「報名」→ 只有本人看得到的回覆（ephemeral），公告本身不動
 */
function handleMassageAction(db: SupabaseClient, me: any, lang: Lang, p: Record<string, any>, action: Record<string, any>) {
  background((async () => {
    const channelId = String(p.channel?.id ?? p.container?.channel_id ?? '')
    const inDm = channelId.startsWith('D')
    const blocksNow: any[] = p.message?.blocks ?? []
    const fromCard = blocksNow.some(b => String(b.block_id ?? '').startsWith('mcard'))

    if (action.action_id === 'massage_list') {
      const blocks = await massageListBlocks(db, lang, action.value)
      await massageRespond(p.response_url, mt(lang, 'card_text'), blocks, false)
      return
    }

    // 空位通知的「報名」：通知本身不動（massage-notify 會改寫成已額滿），結果只給按的人看
    if (String(action.action_id).startsWith('massage_grab')) {
      const { note, changed } = await grabMassageSlot(db, me, lang, action.value)
      if (changed) pokeMassageNotify()
      await massageRespond(p.response_url, note, [section(note)], false)
      return
    }

    const { note, changed } = await runMassageAction(db, me, lang, action.action_id, action.value)
    if (changed) pokeMassageNotify()

    if (fromCard || !inDm) {
      const card = await massageCardBlocks(db, me, lang)
      await massageRespond(p.response_url, note, [section(note), { type: 'divider' }, ...card], inDm)
    } else {
      const kept = blocksNow
        .map(b => {
          if (b.accessory?.action_id === action.action_id && b.accessory?.value === action.value) {
            const { accessory: _drop, ...rest } = b
            return rest
          }
          return b
        })
        .filter(b => !(b.type === 'actions' && (b.elements ?? []).some((el: any) =>
          el.action_id === action.action_id && el.value === action.value)))
      await massageRespond(p.response_url, note, [...kept, contextLine(note)], true)
    }
  })())
  return new Response('')
}

async function massageRespond(responseUrl: string, text: string, blocks: unknown[], replace: boolean) {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(replace
      ? { replace_original: true, text, blocks }
      : { replace_original: false, response_type: 'ephemeral', text, blocks }),
  })
}

async function mSessionOfSignup(db: SupabaseClient, signupId: string): Promise<MSession | null> {
  const { data: g } = await db.from('massage_signups').select('session_id').eq('id', signupId).maybeSingle()
  if (!g) return null
  const { data: s } = await db.from('massage_sessions').select(M_SESSION_COLS).eq('id', g.session_id).maybeSingle()
  return (s as MSession) ?? null
}

/**
 * 空位通知上的「報名」（先搶先贏）。不論在私訊或頻道，結果都只回給按的人看（ephemeral）；
 * 通知本身由 massage-notify 改寫成「已額滿」。提示文字是使用者挑的版本。
 */
async function grabMassageSlot(db: SupabaseClient, me: any, lang: Lang, value: string): Promise<{ note: string; changed: boolean }> {
  const [sessionId, slotStr] = String(value).split('|')
  const slot = Number(slotStr)
  const { data, error } = await db.rpc('massage_grab_slot_as', { p_session_id: sessionId, p_slot_no: slot, p_user_id: me.id })
  if (error) console.error('massage_grab_slot_as 失敗：', error.message)
  const res = (data ?? { ok: false }) as Record<string, any>
  const { data: sRow } = await db.from('massage_sessions').select(M_SESSION_COLS).eq('id', sessionId).maybeSingle()
  const s = sRow as MSession | null
  const slotLabel = (n: number) => (s ? mSlot(lang, s, n) : String(n))
  if (res.ok) return { note: mt(lang, 'grab_ok', { slot: slotLabel(slot) }), changed: true }
  switch (res.code) {
    case 'already_has_slot': return { note: mt(lang, 'grab_has_slot', { slot: slotLabel(res.slot_no) }), changed: false }
    case 'leave_conflict': return { note: mt(lang, 'grab_leave', { leave: mLeaveText(lang, res.leave) }), changed: false }
    case 'slot_taken': return { note: mt(lang, 'grab_taken'), changed: false }
    case 'slot_over': return { note: mt(lang, 'grab_over'), changed: false }
    case 'not_open': return { note: mt(lang, 'grab_not_open', { time: s ? mFmtOpens(lang, s.release_open_at) : '' }), changed: false }
  }
  return { note: massageErr(lang, res.code), changed: false }
}

/** 假單 →「2026/10/27 特休 13:00–18:00」 */
function mLeaveText(lang: Lang, l: Record<string, any> | null | undefined) {
  if (!l) return ''
  const d = (v: string) => String(v).slice(0, 10).replaceAll('-', '/')
  const dates = l.start_date === l.end_date ? d(l.start_date) : `${d(l.start_date)}–${d(l.end_date)}`
  const type = (lang === 'en' ? l.leave_type_en : null) ?? l.leave_type ?? ''
  const time = l.start_date === l.end_date && l.start_time && l.end_time ? ` ${l.start_time}–${l.end_time}` : ''
  return `${dates} ${type}${time}`.trim()
}

/** 真正去改資料庫。回傳要顯示的一句話，以及資料有沒有變（有變才需要叫通知那支跑一次）。 */
async function runMassageAction(db: SupabaseClient, me: any, lang: Lang, actionId: string, id: string) {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args)
    if (error) console.error(`${fn} 失敗：`, error.message)
    return (data ?? { ok: false }) as Record<string, any>
  }
  const fail = (res: Record<string, any>) => ({ note: massageErr(lang, res.code), changed: false })

  switch (actionId) {
    case 'massage_signup': {
      const res = await call('massage_sign_up_as', { p_session_id: id, p_user_id: me.id })
      if (!res.ok) return fail(res)
      const note = mt(lang, 'ok_signed_up') + (res.partial_leave ? ` ${mt(lang, 'ok_partial_leave')}` : '')
      return { note, changed: true }
    }
    case 'massage_withdraw':
    case 'massage_release':
    case 'massage_leave_waitlist': {
      const res = await call('massage_release_as', { p_signup_id: id, p_user_id: me.id })
      if (!res.ok) return fail(res)
      if (res.held && res.opens_at) return { note: mt(lang, 'ok_released_held', { time: mFmtOpens(lang, res.opens_at) }), changed: true }
      const key: MKey = res.phase === 'before_draw' ? 'ok_withdrew'
        : res.late ? 'ok_released_late'
        : actionId === 'massage_leave_waitlist' ? 'ok_left_waitlist' : 'ok_released'
      return { note: mt(lang, key), changed: true }
    }
    case 'massage_cancel_release': {
      const res = await call('massage_cancel_release_as', { p_signup_id: id, p_user_id: me.id })
      if (res.ok) {
        const s = await mSessionOfSignup(db, id)
        return { note: mt(lang, 'ok_release_cancelled', { slot: s ? mSlot(lang, s, res.slot_no) : String(res.slot_no) }), changed: true }
      }
      if (res.code === 'cancel_release_closed' && res.opens_at) {
        return { note: `⚠️ ${mt(lang, 'cancel_release_closed', { time: mFmtOpens(lang, res.opens_at) })}`, changed: false }
      }
      if (res.code === 'slot_taken') return { note: `⚠️ ${mt(lang, 'cancel_release_taken')}`, changed: false }
      if (res.code === 'not_released') return { note: `⚠️ ${mt(lang, 'cancel_release_none')}`, changed: false }
      return fail(res)
    }
    case 'massage_accept': {
      const res = await call('massage_accept_offer_as', { p_signup_id: id, p_user_id: me.id })
      // 過期、時段結束、被搶走：資料庫也會記一筆（甚至改問下一位），所以失敗也算「有變」
      if (!res.ok) return { note: massageErr(lang, res.code), changed: true }
      const { data: g } = await db.from('massage_signups').select('session_id').eq('id', id).maybeSingle()
      const { data: s } = await db.from('massage_sessions').select(M_SESSION_COLS).eq('id', g?.session_id).maybeSingle()
      return { note: mt(lang, 'ok_accepted', { slot: s ? mSlot(lang, s as MSession, res.slot_no) : String(res.slot_no) }), changed: true }
    }
    case 'massage_yield_keep':
    case 'massage_yield_give': {
      const give = actionId === 'massage_yield_give'
      const res = await call('massage_answer_yield_as', { p_signup_id: id, p_user_id: me.id, p_yield: give })
      if (!res.ok) return fail(res)
      return { note: mt(lang, give ? 'ok_yielded' : 'ok_kept'), changed: true }
    }
    case 'massage_done': {
      const res = await call('massage_mark_done_as', { p_signup_id: id, p_user_id: me.id })
      if (!res.ok) return fail(res)
      return { note: mt(lang, 'ok_done'), changed: true }
    }
  }
  return { note: mt(lang, 'err_unknown'), changed: false }
}

/**
 * 叫 massage-notify 現在跑一次（例如釋出名額之後，候補不用等到下一分鐘才收到邀請）。
 * 失敗沒關係，排程每分鐘都會跑。
 */
function pokeMassageNotify() {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  background(fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/massage-notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, apikey: key ?? '' },
    body: '{}',
  }).then(r => r.body?.cancel()))
}

// ---- 送出假單之後：撞到按摩就提醒釋出 ----

/**
 * Slack 上送假單（本人）或 HR 代登記之後呼叫。只提醒、不自動取消 —— 要不要
 * 釋出由本人決定，按了按鈕才會真的釋出。網頁上 HR 代登記走的是 massage-notify
 * 裡同樣的一段（leaveHitBlocks），改文字時兩邊都要改。
 */
async function remindMassageForLeave(
  db: SupabaseClient, leaveId: string,
  person: { id?: string; full_name?: string; slack_user_id?: string | null; language?: string | null } | null | undefined,
  heading: 'hit_heading_self' | 'hit_heading_hr',
) {
  if (!person?.slack_user_id) return
  const { data: hits } = await db.rpc('massage_signups_hit_by_leave', { p_leave_id: leaveId })
  if (!hits?.length) return
  const lang = normalizeLang(person.language)

  const blocks: unknown[] = [section(mt(lang, heading))]
  for (const h of hits as any[]) {
    const { data: s } = await db.from('massage_sessions').select(M_SESSION_COLS).eq('id', h.session_id).maybeSingle()
    if (!s) continue
    const session = s as MSession
    const date = mDate(lang, session.session_date)
    const line = h.slot_no
      ? mt(lang, 'hit_line_slot', { title: session.title, date, slot: mSlot(lang, session, h.slot_no) })
      : h.drawn
        ? mt(lang, 'hit_line_waitlist', { title: session.title, date })
        : mt(lang, 'hit_line_signed', { title: session.title, date })
    const btn = h.drawn
      ? mButton(mt(lang, 'btn_release'), 'massage_release', h.signup_id,
        { style: 'danger', confirm: mReleaseConfirm(lang, session) })
      : mButton(mt(lang, 'btn_withdraw'), 'massage_withdraw', h.signup_id,
        { confirm: mConfirm(lang, 'confirm_withdraw_title', 'confirm_withdraw_text', mt(lang, 'btn_withdraw')) })
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: line }, accessory: btn })
  }
  const res = await dm(person.slack_user_id, mt(lang, 'hit_text'), blocks)
  // HR 代登記時，當事人的 Slack User ID 可能填錯 → 請按摩負責人更正（同 massage-notify 的 reportBadSlackId）
  if (!res.ok && ['channel_not_found', 'user_not_found', 'user_disabled', 'cannot_dm_bot'].includes(res.error)) {
    await reportBadMassageSlackId(db, person, mt(lang, 'hit_text'))
  }
}

async function reportBadMassageSlackId(
  db: SupabaseClient,
  person: { id?: string; full_name?: string; slack_user_id?: string | null },
  missed: string,
) {
  const { data: settings } = await db.from('massage_settings').select('owner_id').maybeSingle()
  const { data: owner } = settings?.owner_id
    ? await db.from('users').select('id, slack_user_id, language, is_active').eq('id', settings.owner_id).maybeSingle()
    : { data: null }
  if (!owner?.slack_user_id || owner.is_active === false || owner.id === person.id) {
    console.error(`${person.full_name} 的 Slack User ID（${person.slack_user_id}）無效，也沒有可以通知的負責人`)
    return
  }
  const { data: first } = await db.rpc('massage_job_claim', { p_key: `bad_slack_id:${person.id}:${person.slack_user_id}` })
  if (first !== true) return
  const lang = normalizeLang(owner.language)
  await callSlack('chat.postMessage', {
    channel: owner.slack_user_id, text: mt(lang, 'bad_id_text'),
    blocks: [
      section(mt(lang, 'bad_id_heading', { name: person.full_name ?? '—', id: person.slack_user_id ?? '' })),
      { type: 'context', elements: [{ type: 'mrkdwn', text: mt(lang, 'bad_id_missed', { what: missed }) }] },
    ],
  })
}
