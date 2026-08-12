// 修好版本 —— 逾期假單自動退回 ＋ 提醒主管。
//
// 原本這支 function 已經存在（不是這次新寫的），但壞掉了：它會去查
// `approval_delegates`（代理審核人）這張表，但那張表已經在
// 20260810_remove_approval_delegates.sql 被整個刪掉（使用者當時明確要求
// 「代理審核設定這個功能連資料庫也一起刪」）。只要這支 function 被觸發，
// 查詢那張已不存在的表就會直接報錯失敗 —— 這也可以解釋為什麼「Slack
// 通知從來沒有真正運作過」。
//
// 這份修好版本唯一的改動：拿掉查 approval_delegates 的那一段，
// 簽核人一律用 approval_flow_steps 上原本設定的人，不再找代理人。
// 其餘商業邏輯（7 天逾期自動退回、7 天內逐日提醒）完全比照原本的程式碼，
// 沒有另外調整規則或天數 —— 那些是你要的話再另外決定的事，這次只修
// 「壞掉」這個問題。
//
// ⚠️ 這是網頁編輯器用的版本，請直接貼進 Supabase 後台既有的
// `daily-leave-job` 這支 function（用「編輯」，不要新建一支），
// 這樣才會保留原本的名稱／URL／可能已存在的排程設定。

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;

async function sendSlackMessage(slackUserId: string, message: string) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: slackUserId,
      text: message,
    }),
  });
  const data = await response.json();
  if (!data.ok) {
    console.error("Slack error:", data.error);
  }
}

serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString();

    // 取得所有待審假單
    const { data: pendingRequests } = await supabase
      .from("leave_requests")
      .select(`
        *,
        requester:users!leave_requests_requester_id_fkey(full_name, slack_user_id),
        leave_type:leave_types(name),
        flow:approval_flows(
          steps:approval_flow_steps(
            *,
            approver:users!approval_flow_steps_approver_id_fkey(full_name, slack_user_id)
          )
        )
      `)
      .eq("status", "pending");

    if (!pendingRequests || pendingRequests.length === 0) {
      return new Response(JSON.stringify({ message: "No pending requests" }), { status: 200 });
    }

    // 分兩組：逾期退回 vs 提醒
    const toReturn = pendingRequests.filter(
      (r) => new Date(r.created_at) <= new Date(sevenDaysAgo)
    );
    const toRemind = pendingRequests.filter(
      (r) => new Date(r.created_at) > new Date(sevenDaysAgo)
    );

    // 處理逾期退回
    for (const request of toReturn) {
      await supabase
        .from("leave_requests")
        .update({
          status: "returned",
          returned_at: new Date().toISOString(),
          returned_reason: "逾期未審核，系統自動退回",
        })
        .eq("id", request.id);

      if (request.requester?.slack_user_id) {
        await sendSlackMessage(
          request.requester.slack_user_id,
          `⚠️ *您的請假申請已逾期退回*\n\n` +
          `*假別：* ${request.leave_type.name}\n` +
          `*日期：* ${request.start_date} ～ ${request.end_date}\n\n` +
          `您的假單因 7 天內未獲審核，已自動退回。請重新送出申請。`
        );
      }
    }

    // 整理每位審核人的待審假單
    // （原本這裡會先查 approval_delegates 看有沒有代理人、有的話改發給
    //   代理人 —— 那張表已經被刪掉，所以直接一律發給簽核鏈上設定的人。）
    const approverMap: Record<string, {
      slackUserId: string;
      name: string;
      requests: any[];
    }> = {};

    for (const request of toRemind) {
      const currentStep = request.flow?.steps?.find(
        (s: any) => s.step_order === request.current_step
      );
      if (!currentStep) continue;

      const approver = currentStep.approver;
      if (!approver?.slack_user_id) continue;

      if (!approverMap[approver.slack_user_id]) {
        approverMap[approver.slack_user_id] = {
          slackUserId: approver.slack_user_id,
          name: approver.full_name,
          requests: [],
        };
      }

      approverMap[approver.slack_user_id].requests.push(request);
    }

    // 發送提醒給每位審核人
    for (const approver of Object.values(approverMap)) {
      const requestList = approver.requests
        .map(
          (r, i) =>
            `${i + 1}. ${r.requester.full_name}｜${r.leave_type.name}｜` +
            `${r.start_date} ～ ${r.end_date}｜` +
            `已等待 ${Math.floor(
              (Date.now() - new Date(r.created_at).getTime()) /
              (1000 * 60 * 60 * 24)
            )} 天`
        )
        .join("\n");

      await sendSlackMessage(
        approver.slackUserId,
        `🔔 *每日待審假單提醒*\n\n` +
        `您有 *${approver.requests.length} 張* 假單待審核：\n\n` +
        `${requestList}\n\n` +
        `請登入請假系統盡快處理。`
      );

      await supabase
        .from("leave_requests")
        .update({ last_reminded_at: new Date().toISOString() })
        .in("id", approver.requests.map((r) => r.id));
    }

    return new Response(
      JSON.stringify({
        returned: toReturn.length,
        reminded: toRemind.length,
      }),
      { status: 200 }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500 });
  }
});
