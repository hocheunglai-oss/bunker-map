-- Full historical integrity checks currently take 5-10 seconds. PostgREST's
-- inherited 8-second deadline can cancel valid evidence under ordinary load.
-- Its supported function-level deadline gives ONLY these server-only RPCs
-- bounded headroom. No role/global setting, verification body, ACL, queue,
-- certification, template, or lock ordering is changed.
set local lock_timeout = '3s';
alter function public.verify_outlook_exchange_truth_ledger()
  set statement_timeout = '20s';
alter function public.verify_outlook_template_recipient_truth()
  set statement_timeout = '20s';
alter function public.save_email_template_canonical(jsonb, bigint, timestamptz)
  set statement_timeout = '20s';
alter function public.repair_email_templates_canonical(jsonb)
  set statement_timeout = '20s';
alter function public.replace_email_template_library_canonical(jsonb, text)
  set statement_timeout = '20s';
alter function public.reserve_outlook_template_insertion(uuid, text, bigint, uuid, text, text, text, integer)
  set statement_timeout = '20s';
