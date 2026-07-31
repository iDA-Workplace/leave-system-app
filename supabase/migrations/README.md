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
