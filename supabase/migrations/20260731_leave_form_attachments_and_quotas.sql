-- Leave application modal redesign (per the reference screenshot the user
-- provided: attachment upload + a per-leave-type remaining-balance sidebar).
--
-- Same deal as the other file in this folder: this session only has the
-- anon key, not a service-role key or SQL Editor access, so this has to be
-- run by hand in the Supabase Dashboard's SQL Editor before the new
-- attachment upload / balance sidebar will work. Safe to re-run.

-- 1. Attachment on a leave request (e.g. a doctor's note for sick leave).
alter table public.leave_requests
  add column if not exists attachment_url text,
  add column if not exists attachment_name text;

comment on column public.leave_requests.attachment_url is
  'Public/signed URL into the "leave-attachments" storage bucket. NULL = no attachment.';

-- 2. A flat annual quota per leave type, so non-特休 types (病假, etc.) can
--    show a used/total balance too. NULL = not quota-tracked (e.g. 事假).
--    特休 keeps using the existing annual_leave_summary view (it already
--    handles pro-rated accrual by hire date) -- this column is only read
--    for the OTHER leave types in the new balance sidebar.
alter table public.leave_types
  add column if not exists annual_quota_hours numeric;

comment on column public.leave_types.annual_quota_hours is
  'Flat yearly quota in hours for this leave type (e.g. 病假 = 240). NULL means not quota-tracked / unlimited. Ignored for the 特休 type, which uses annual_leave_summary instead.';

-- 3. Storage bucket for attachments. Supabase lets you create buckets via
--    SQL, but the bucket still needs RLS policies of its own -- the two
--    policies below are a reasonable starting point (any authenticated
--    user can upload/read; tighten this if you need per-user isolation).
insert into storage.buckets (id, name, public)
values ('leave-attachments', 'leave-attachments', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'leave-attachments authenticated upload'
  ) then
    create policy "leave-attachments authenticated upload"
      on storage.objects for insert
      to authenticated
      with check (bucket_id = 'leave-attachments');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'leave-attachments public read'
  ) then
    create policy "leave-attachments public read"
      on storage.objects for select
      to public
      using (bucket_id = 'leave-attachments');
  end if;
end $$;
