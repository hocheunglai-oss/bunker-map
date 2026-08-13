drop index if exists public.spc_mobile_enquiry_deliveries_pending_idx;
create index spc_mobile_enquiry_deliveries_pending_idx
  on public.spc_mobile_enquiry_deliveries(next_attempt_at, created_at)
  where status in ('queued', 'failed', 'acknowledged');
