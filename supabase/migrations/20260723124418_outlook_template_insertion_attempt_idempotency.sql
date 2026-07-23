create unique index if not exists audit_logs_outlook_template_insertion_operation_id_key
  on public.audit_logs ((record_pk ->> 'operationId'))
  where table_schema = 'app'
    and table_name = 'outlook_template_insertion_attempts'
    and operation = 'INSERT'
    and record_pk ? 'operationId';