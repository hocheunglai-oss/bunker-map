alter table public.spc_mobile_modes
  add column if not exists conversation_open_until timestamptz,
  add column if not exists last_inbound_at timestamptz,
  add column if not exists activation_token text,
  add column if not exists activation_status text not null default 'idle',
  add column if not exists activation_message_id text,
  add column if not exists activation_delivery_status text,
  add column if not exists activation_attempt_count integer not null default 0,
  add column if not exists activation_next_attempt_at timestamptz not null default clock_timestamp(),
  add column if not exists activation_last_error text;

alter table public.spc_mobile_modes
  drop constraint if exists spc_mobile_modes_activation_status,
  drop constraint if exists spc_mobile_modes_activation_token,
  add constraint spc_mobile_modes_activation_status
    check (activation_status in ('idle', 'queued', 'prompt_sent', 'acknowledged', 'failed')),
  add constraint spc_mobile_modes_activation_token
    check (activation_token is null or activation_token ~ '^[A-Za-z0-9_-]{20,80}$');

create unique index if not exists spc_mobile_modes_activation_token_idx
  on public.spc_mobile_modes(activation_token) where activation_token is not null;
create index if not exists spc_mobile_modes_activation_pending_idx
  on public.spc_mobile_modes(activation_next_attempt_at)
  where enabled and activation_status in ('queued', 'failed');

update public.spc_mobile_modes
set
  activation_token = replace(replace(replace(encode(gen_random_bytes(24), 'base64'), '+', '-'), '/', '_'), '=', ''),
  activation_status = 'queued',
  activation_next_attempt_at = clock_timestamp(),
  conversation_open_until = null,
  updated_at = clock_timestamp()
where enabled and activation_status = 'idle';

comment on column public.spc_mobile_modes.conversation_open_until is
  'End of the rolling WhatsApp customer-service window derived from the latest inbound trader message.';
