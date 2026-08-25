alter table public.spc_mobile_modes
  drop constraint if exists spc_mobile_modes_active_expiry;

update public.spc_mobile_modes
set expires_at = coalesce(activated_at, updated_at, clock_timestamp()) + interval '24 hours'
where enabled;

update public.spc_mobile_modes
set enabled = false,
    deactivated_at = coalesce(deactivated_at, clock_timestamp()),
    activation_token = null,
    activation_status = 'idle',
    activation_message_id = null,
    activation_delivery_status = null,
    activation_last_error = null,
    updated_at = clock_timestamp()
where enabled
  and expires_at <= clock_timestamp();

update public.spc_mobile_enquiry_deliveries as delivery
set status = 'expired',
    processing_started_at = null,
    last_error_code = 'Backup Mode expired.',
    updated_at = clock_timestamp()
where delivery.status in ('queued', 'prompt_sent', 'acknowledged', 'failed')
  and exists (
    select 1
    from public.spc_mobile_modes as mode
    where mode.spc_user_id = delivery.spc_user_id
      and not mode.enabled
  );

alter table public.spc_mobile_modes
  add constraint spc_mobile_modes_active_expiry check (
    (enabled and expires_at is not null and activated_at is not null)
    or not enabled
  );

drop index if exists public.spc_mobile_modes_active_idx;
create index spc_mobile_modes_active_idx
  on public.spc_mobile_modes(expires_at)
  where enabled;

comment on table public.spc_mobile_modes is
  'Legacy table name retained for backups. Server-managed, per-user 24-hour Backup Mode opt-in for direct WhatsApp enquiry copies.';
comment on column public.spc_mobile_modes.expires_at is
  'Hard Backup Mode expiry, set to 24 hours after each user activation.';
comment on table public.spc_mobile_enquiry_deliveries is
  'Idempotent per-user Backup Mode delivery ledger. Normal WhatsApp group delivery is independent and continues.';
