-- PostgreSQL silently truncates identifiers to 63 bytes, whereas PostgREST
-- requires an exact catalog name. Preserve the already-installed function's
-- body, owner, argument contract and service-only ACL; rename it append-only.
set local lock_timeout = '3s';

alter function public.certify_staged_full_outlook_exchange_truth_and_activate_templat(
  uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text
)
rename to certify_staged_full_outlook_truth_and_activate_templates;

notify pgrst, 'reload schema';
