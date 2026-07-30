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
