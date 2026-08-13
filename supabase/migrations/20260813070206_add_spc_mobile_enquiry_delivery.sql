create table if not exists public.spc_mobile_modes (
  spc_user_id uuid primary key references public.spc_users(id) on delete cascade,
  username text not null,
  display_name text not null,
  recipient_phone text not null check (recipient_phone ~ '^[1-9][0-9]{7,14}$'),
  enabled boolean not null default false,
  expires_at timestamptz,
  activated_at timestamptz,
  deactivated_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint spc_mobile_modes_active_expiry check (
    (enabled and expires_at is not null and activated_at is not null)
    or (not enabled)
  )
);

create index if not exists spc_mobile_modes_active_idx
  on public.spc_mobile_modes(expires_at)
  where enabled;

create table if not exists public.spc_mobile_enquiry_deliveries (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid not null references public.spc_enquiries(id) on delete cascade,
  spc_user_id uuid not null references public.spc_users(id) on delete cascade,
  recipient_phone text not null check (recipient_phone ~ '^[1-9][0-9]{7,14}$'),
  recipient_display_name text not null,
  acknowledgement_token text not null unique
    check (acknowledgement_token ~ '^[A-Za-z0-9_-]{20,80}$'),
  status text not null default 'queued'
    check (status in ('queued', 'prompt_sent', 'acknowledged', 'content_sent', 'failed', 'expired')),
  prompt_message_id text,
  content_message_id text,
  trader_message_id text,
  prompt_delivery_status text,
  content_delivery_status text,
  trader_delivery_status text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error_code text,
  acknowledged_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (enquiry_id, spc_user_id)
);

create index if not exists spc_mobile_enquiry_deliveries_pending_idx
  on public.spc_mobile_enquiry_deliveries(next_attempt_at, created_at)
  where status in ('queued', 'failed');
create index if not exists spc_mobile_enquiry_deliveries_phone_pending_idx
  on public.spc_mobile_enquiry_deliveries(recipient_phone, created_at)
  where status = 'prompt_sent';
create index if not exists spc_mobile_enquiry_deliveries_message_ids_idx
  on public.spc_mobile_enquiry_deliveries(prompt_message_id, content_message_id, trader_message_id);

alter table public.spc_mobile_modes enable row level security;
alter table public.spc_mobile_enquiry_deliveries enable row level security;

revoke all privileges on table public.spc_mobile_modes from public, anon, authenticated;
revoke all privileges on table public.spc_mobile_enquiry_deliveries from public, anon, authenticated;
grant select, insert, update, delete on table public.spc_mobile_modes to service_role;
grant select, insert, update, delete on table public.spc_mobile_enquiry_deliveries to service_role;

comment on table public.spc_mobile_modes is
  'Server-managed, expiring supplier-trader opt-in for WhatsApp mobile enquiry delivery.';
comment on table public.spc_mobile_enquiry_deliveries is
  'Idempotent delivery ledger for WhatsApp acknowledgement and two-part mobile enquiry delivery.';
