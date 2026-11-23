-- Each filed claim and its receipts are copied together to the FCUNO Drive
-- backup root. Keep them outside the public-table daily export inventory.
create table private.trip_expense_claims (
  id uuid primary key,
  submitted_by uuid not null,
  submitter_name text not null check (char_length(submitter_name) between 1 and 200),
  submitted_at timestamptz not null default now(),
  details jsonb not null check (jsonb_typeof(details) = 'object'),
  claim_cents bigint not null check (claim_cents >= 0),
  backup_file_id text,
  backed_up_at timestamptz,
  email_attempted_at timestamptz,
  emailed_at timestamptz,
  delivery_token uuid,
  delivery_lease_until timestamptz,
  delivery_retry_at timestamptz not null default now(),
  check (backed_up_at is null or backup_file_id is not null),
  check (email_attempted_at is null or backed_up_at is not null),
  check (emailed_at is null or email_attempted_at is not null),
  check ((delivery_token is null) = (delivery_lease_until is null))
);

create index trip_expense_claims_owner_idx
  on private.trip_expense_claims (submitted_by, submitted_at desc, id desc);
create index trip_expense_claims_submitted_idx
  on private.trip_expense_claims (submitted_at desc, id desc);
create index trip_expense_claims_delivery_idx
  on private.trip_expense_claims (delivery_retry_at, submitted_at)
  where email_attempted_at is null;

alter table private.trip_expense_claims enable row level security;
revoke all on private.trip_expense_claims from public, anon, authenticated;
grant select, insert, update on private.trip_expense_claims to service_role;

create view public.trip_expense_claims with (security_invoker = true) as
select id, submitted_by, submitter_name, submitted_at, details, claim_cents,
  backup_file_id, backed_up_at, email_attempted_at, emailed_at,
  delivery_token, delivery_lease_until, delivery_retry_at
from private.trip_expense_claims;
revoke all on public.trip_expense_claims from public, anon, authenticated;
grant select, insert, update on public.trip_expense_claims to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'trip-expense-receipts', 'trip-expense-receipts', false, 10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
);
