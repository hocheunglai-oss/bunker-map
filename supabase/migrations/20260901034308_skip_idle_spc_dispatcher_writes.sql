-- The desktop dispatcher polls for work every two seconds. A statement-level
-- backup fence fires even when an UPDATE matches zero rows, so the previous
-- claim CTE continuously invalidated consistent backups while the queue was
-- empty. Lock a real candidate first and issue UPDATE only when work exists.

create or replace function public.claim_spc_group_delivery_job(
  p_dispatcher_id uuid,
  p_claim_token_hash text,
  p_lease_seconds integer default 90
)
returns setof public.spc_group_delivery_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidate_id uuid;
begin
  if p_claim_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid claim token hash.';
  end if;

  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'Invalid claim lease.';
  end if;

  select jobs.id
  into candidate_id
  from public.spc_group_delivery_jobs as jobs
  where (
    jobs.status in ('queued', 'failed')
    or (
      jobs.status = 'claimed'
      and jobs.lease_expires_at is not null
      and jobs.lease_expires_at <= clock_timestamp()
    )
  )
    and jobs.available_at <= clock_timestamp()
    and jobs.attempt_count < 20
    and nullif(btrim(jobs.destination_group_name), '') is not null
  order by jobs.created_at, jobs.id
  for update skip locked
  limit 1;

  if candidate_id is null then
    return;
  end if;

  return query
  update public.spc_group_delivery_jobs as jobs
  set status = 'claimed',
      attempt_count = jobs.attempt_count + 1,
      claimed_by = p_dispatcher_id,
      claim_token_hash = p_claim_token_hash,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_error = null,
      updated_at = clock_timestamp()
  where jobs.id = candidate_id
  returning jobs.*;
end;
$$;

revoke all on function public.claim_spc_group_delivery_job(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_spc_group_delivery_job(uuid, text, integer)
  to service_role;
