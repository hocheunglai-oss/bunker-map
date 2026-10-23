-- Keep both complete pre-row/post-row proofs and every existing write, lease,
-- source, integrity and replay guard. Two observed ~6s proofs no longer fit
-- the original10s activation budget. Bound ONLY these three RPC/function
-- settings and the existing elapsed commit fence to20s; no global/role/TTL,
-- lock-wait, worker or memory setting is changed.
set local lock_timeout = '3s';

do $bounded_proof_budget$
declare
  signature text;
  target oid;
  original jsonb;
  prior jsonb := '{}'::jsonb;
  expected_body text;
  definition text;
  expected_config text[];
  elapsed_before constant text := 'interval ''10 seconds''';
  elapsed_after constant text := 'interval ''20 seconds''';
  private_signature constant text := 'private.certify_staged_outlook_truth_and_activate(text,uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)';
  targets constant jsonb := jsonb_build_object(
    'private.certify_staged_outlook_truth_and_activate(text,uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)', '2d01c3be2a35ac720f27510eb9fd6e73',
    'public.certify_staged_read_only_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)', '8627d9e1017bfc27d77bc06e565e2db6',
    'public.certify_staged_full_outlook_truth_and_activate_templates(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)', '4be6d72c63bcc3b2b60f28e506462848'
  );
begin
  -- Validate EVERY target before the first replacement. Unknown bodies or
  -- settings require review; never silently overwrite an independently changed
  -- function. Capture the complete pg_proc row, including OID/owner/ACL.
  for signature in select jsonb_object_keys(targets) loop
    target := pg_catalog.to_regprocedure(signature);
    select to_jsonb(p) into original from pg_catalog.pg_proc p where p.oid = target;
    if original is null or md5(original ->> 'prosrc') is distinct from targets ->> signature
      or jsonb_array_length(original -> 'proconfig') is distinct from 3
      or not (original -> 'proconfig' @> '["search_path=pg_catalog, pg_temp","lock_timeout=2s","statement_timeout=10s"]'::jsonb)
    then
      raise exception 'OUTLOOK_ATOMIC_BUDGET_SOURCE_DRIFT: review the installed activation body and settings.' using errcode = '55000';
    end if;
    prior := prior || jsonb_build_object(signature, original);
  end loop;
  original := prior -> private_signature;
  if (length(original ->> 'prosrc') - length(replace(original ->> 'prosrc', elapsed_before, ''))) / length(elapsed_before) <> 1 then
    raise exception 'OUTLOOK_ATOMIC_BUDGET_SOURCE_DRIFT: the original elapsed fence is not unique.' using errcode = '55000';
  end if;
  definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(private_signature));
  execute replace(definition, elapsed_before, elapsed_after);
  -- PostgREST14 hoists exposed function settings before its main statement.
  -- Changing only the private callee cannot repair the outer10s REST timer.
  for signature in select jsonb_object_keys(targets) loop
    execute format('alter function %s set statement_timeout to %L', pg_catalog.to_regprocedure(signature), '20s');
  end loop;
  for signature in select jsonb_object_keys(targets) loop
    original := prior -> signature;
    expected_body := case when signature = private_signature
      then replace(original ->> 'prosrc', elapsed_before, elapsed_after)
      else original ->> 'prosrc' end;
    select array_agg(case when value = 'statement_timeout=10s' then 'statement_timeout=20s' else value end order by position)
      into expected_config
      from jsonb_array_elements_text(original -> 'proconfig') with ordinality as settings(value, position);
    if not exists (
      select 1 from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(signature)
        and (to_jsonb(p) - 'prosrc' - 'proconfig') = (original - 'prosrc' - 'proconfig')
        and p.prosrc = expected_body and p.proconfig = expected_config
    ) then
      raise exception 'OUTLOOK_ATOMIC_BUDGET_POSTCONDITION: activation identity, privileges, guards or settings changed unexpectedly.' using errcode = '55000';
    end if;
  end loop;
end;
$bounded_proof_budget$;

-- Deliver only with the successful DDL commit: PostgREST caches the exposed
-- function settings used to start the actual REST statement timer.
notify pgrst, 'reload schema';
