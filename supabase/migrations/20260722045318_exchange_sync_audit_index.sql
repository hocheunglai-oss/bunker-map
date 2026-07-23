create index if not exists outlook_exchange_sync_queue_audit_log_id_idx
  on public.outlook_exchange_sync_queue(audit_log_id)
  where audit_log_id is not null;
