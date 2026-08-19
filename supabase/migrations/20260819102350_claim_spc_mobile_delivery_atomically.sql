alter table public.spc_mobile_enquiry_deliveries
  add column if not exists processing_started_at timestamptz;

alter table public.spc_mobile_enquiry_deliveries
  drop constraint if exists spc_mobile_enquiry_deliveries_status_check;

alter table public.spc_mobile_enquiry_deliveries
  add constraint spc_mobile_enquiry_deliveries_status_check
    check (status in (
      'queued',
      'prompt_sent',
      'acknowledged',
      'processing',
      'content_sent',
      'failed',
      'manual_review',
      'expired'
    ));

alter table public.spc_mobile_modes
  drop constraint if exists spc_mobile_modes_activation_status;

alter table public.spc_mobile_modes
  add constraint spc_mobile_modes_activation_status
    check (activation_status in (
      'idle',
      'queued',
      'processing',
      'prompt_sent',
      'acknowledged',
      'failed',
      'manual_review'
    ));

create index if not exists spc_mobile_enquiry_deliveries_processing_idx
  on public.spc_mobile_enquiry_deliveries(processing_started_at)
  where status = 'processing';

comment on column public.spc_mobile_enquiry_deliveries.processing_started_at is
  'Atomic delivery ownership timestamp. Stale claims require manual review and are never retried automatically.';
