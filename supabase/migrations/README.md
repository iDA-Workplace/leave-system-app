# Manual migrations

This app's Supabase project isn't wired into this repo (no CLI project link,
no service-role key here) -- so these `.sql` files are **not** applied
automatically by anything. Run them by hand:

1. Go to your Supabase project dashboard → **SQL Editor** → **New query**.
2. Paste the contents of the migration file in filename order.
3. Run it. Every statement here is idempotent, so re-running a file that's
   already been applied is harmless.

| File | What it does | Required before |
|---|---|---|
| `20260730_annual_review_overhaul.sql` | Adds `users.manager_id`, per-cycle deadlines on `annual_reviews`, and the calibration/publish/acknowledge columns on `annual_review_participants`. | The new `/review/*` and `/admin/reviews/*` screens (Epic H / B18-B22) — they will error on missing columns until this runs. |
| `20260731_leave_form_attachments_and_quotas.sql` | Adds `leave_requests.attachment_url`/`attachment_name`, `leave_types.annual_quota_hours`, and creates a public `leave-attachments` storage bucket with basic upload/read policies. | The redesigned 申請請假 modal's file-upload field and per-leave-type balance sidebar — without this, uploads will fail and non-特休 balances will show as "未設定額度". |
| `20260805_role_flag_review_templates_notify.sql` | Adds `users.is_admin` (backfilling from the old `role = 'admin'` rows, then collapsing those rows' `role` to `employee` — revisit each one in 員工帳號管理 and correct the primary role if needed), and `annual_reviews.supervisor_template_id`/`boss_template_id`. (核准通知對象 already existed as `notification_targets` / AdminPanel's 通知對象 tab — no schema change was needed for that.) | The is_admin-based role model everywhere in the app, and per-role review questionnaires. |
| `20260806_user_department_title.sql` | Adds `users.department`, `users.job_title` (both plain nullable text). | The 年度自評 screen's 員工資訊 block (姓名/職稱/入職日/部門/評核年度) and 員工帳號管理's new fields. |
| `20260807_approver_update_leave_requests_rls.sql` | Adds an RLS policy letting the assigned approver (or their delegate, or an admin) UPDATE a `leave_requests` row — not just the requester. This is a **hypothesis fix**, not a confirmed diagnosis (this session can't read your project's actual policies) for: approving/rejecting a leave request records the approval but the request's status never actually changes. | Approve/reject actually taking effect, if the cause is what we think it is. |
| `20260808_review_templates_by_department.sql` | Adds `review_templates.department` (NULL = 全公司預設模板). Does not touch or drop the old calibration/publish columns — the app just stops reading/writing them. | The department-scoped question editing in 考核管理's new 部門考核設定 tab. |
| `20260809_review_flows_and_scoring.sql` | Adds `users.english_name`; new `review_flows`/`review_flow_steps` tables (a leave-approval-flow-style configurable evaluator chain, scoped by department); `annual_review_participants.flow_id`/`current_step`/`final_score`; `review_evaluations.step_order`/`example_note`; `review_responses.example_note`. | The rebuilt 員工資訊 header, multi-step 考核流程 evaluation chain, and per-question "相關事例" reasoning notes in 考核管理. |
