-- Persist the point after which WhatsApp may have accepted a message. An
-- expired prepared claim must never become an automatic resend.
alter table public.spc_group_delivery_jobs
  add column if not exists send_prepared_at timestamptz;

-- Claims created by an older worker have no preparation proof. Keep their
-- uncertain outcome for review instead of handing them to the new worker.
update public.spc_group_delivery_jobs
set status = 'manual_review',
    claim_token_hash = null,
    lease_expires_at = null,
    last_error = 'Delivery was in progress during the dispatcher safety update. Check WhatsApp before sending again.',
    updated_at = clock_timestamp()
where status = 'claimed';

update public.spc_group_delivery_jobs
set status = 'manual_review',
    last_error = 'Automatic delivery stopped after 20 attempts. ' || coalesce(last_error, 'Check the destination group.'),
    updated_at = clock_timestamp()
where status in ('queued', 'failed') and attempt_count >= 20;

-- Disable the old protocol during migration-first deployment. Only the v2
-- worker, which calls prepare_spc_group_delivery_job before sending, may claim.
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
begin
  return;
end;
$$;

create or replace function public.claim_spc_group_delivery_job_v2(
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
  expired_job record;
begin
  if p_claim_token_hash is null or p_claim_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid claim token hash.';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'Invalid claim lease.';
  end if;

  -- All worker tabs share this lock, so concurrent polls cannot each claim a
  -- different job. Recheck active inside the same transaction as the claim.
  perform 1 from public.spc_group_dispatchers
  where id = p_dispatcher_id and active
  for update;
  if not found then return; end if;

  -- Select real rows before UPDATE: an empty UPDATE still triggers the backup
  -- statement fence, which would make an idle two-second poll invalidate it.
  for expired_job in
    select jobs.id, jobs.send_prepared_at
    from public.spc_group_delivery_jobs as jobs
    where (jobs.status = 'claimed'
      and coalesce(jobs.lease_expires_at, '-infinity'::timestamptz) <= clock_timestamp()
      and (jobs.send_prepared_at is not null or jobs.attempt_count >= 20))
      or (jobs.status in ('queued', 'failed') and jobs.attempt_count >= 20)
    for update skip locked
  loop
    update public.spc_group_delivery_jobs
    set status = 'manual_review',
        claim_token_hash = null,
        lease_expires_at = null,
        last_error = case when expired_job.send_prepared_at is not null
          then 'WhatsApp submission was prepared but not confirmed. Check the group before sending again.'
          else 'Automatic delivery stopped after 20 attempts. Check the destination group.' end,
        updated_at = clock_timestamp()
    where id = expired_job.id;
  end loop;

  if exists (
    select 1 from public.spc_group_delivery_jobs
    where status = 'claimed' and lease_expires_at > clock_timestamp()
  ) then return; end if;

  select jobs.id into candidate_id
  from public.spc_group_delivery_jobs as jobs
  where (jobs.status in ('queued', 'failed') or (
    jobs.status = 'claimed'
    and coalesce(jobs.lease_expires_at, '-infinity'::timestamptz) <= clock_timestamp()
  ))
    and jobs.send_prepared_at is null
    and jobs.available_at <= clock_timestamp()
    and jobs.attempt_count < 20
    and nullif(btrim(jobs.destination_group_name), '') is not null
  order by jobs.created_at, jobs.id
  for update skip locked
  limit 1;
  if candidate_id is null then return; end if;

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

create or replace function public.prepare_spc_group_delivery_job(
  p_job_id uuid,
  p_dispatcher_id uuid,
  p_claim_token_hash text
)
returns setof public.spc_group_delivery_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.spc_group_dispatchers
  where id = p_dispatcher_id and active
  for update;
  if not found then return; end if;

  -- A one-shot permit: if this response is lost, repeating preparation must
  -- fail closed because the first worker may have proceeded to WhatsApp.
  return query
  update public.spc_group_delivery_jobs as jobs
  set send_prepared_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + interval '90 seconds',
      updated_at = clock_timestamp()
  where jobs.id = p_job_id
    and jobs.status = 'claimed'
    and jobs.claimed_by = p_dispatcher_id
    and jobs.claim_token_hash = p_claim_token_hash
    and jobs.lease_expires_at > clock_timestamp()
    and jobs.send_prepared_at is null
  returning jobs.*;
end;
$$;

create or replace function public.complete_spc_group_delivery_job(
  p_job_id uuid,
  p_dispatcher_id uuid,
  p_claim_token_hash text,
  p_result text,
  p_error text default null
)
returns setof public.spc_group_delivery_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job_row public.spc_group_delivery_jobs%rowtype;
  result_status text := p_result;
  result_error text := nullif(left(coalesce(p_error, ''), 1000), '');
begin
  if p_result is null or p_result not in ('sent', 'failed', 'manual_review') then
    raise exception 'Invalid delivery result.';
  end if;
  perform 1 from public.spc_group_dispatchers
  where id = p_dispatcher_id and active
  for update;
  if not found then return; end if;

  select jobs.* into job_row from public.spc_group_delivery_jobs as jobs
  where jobs.id = p_job_id and jobs.status = 'claimed'
    and jobs.claimed_by = p_dispatcher_id
    and jobs.claim_token_hash = p_claim_token_hash
  for update;
  if not found then return; end if;

  if job_row.send_prepared_at is not null and (
    p_result = 'failed' or coalesce(job_row.lease_expires_at, '-infinity'::timestamptz) <= clock_timestamp()
  ) then
    result_status := 'manual_review';
    result_error := 'WhatsApp submission was prepared but not confirmed in time. Check the group before sending again.';
  elsif coalesce(job_row.lease_expires_at, '-infinity'::timestamptz) <= clock_timestamp() then
    return;
  elsif p_result = 'sent' and job_row.send_prepared_at is null then
    result_status := 'manual_review';
    result_error := 'Delivery was reported without submission preparation. Check WhatsApp before sending again.';
  elsif p_result = 'failed' and job_row.attempt_count >= 20 then
    result_status := 'manual_review';
    result_error := left('Automatic delivery stopped after 20 attempts. ' || coalesce(result_error, 'Check the destination group.'), 1000);
  end if;

  return query
  update public.spc_group_delivery_jobs as jobs
  set status = result_status,
      available_at = case when result_status = 'failed'
        then clock_timestamp() + make_interval(secs => least(300, 15 * greatest(1, jobs.attempt_count)))
        else jobs.available_at end,
      claim_token_hash = null,
      lease_expires_at = null,
      last_error = result_error,
      sent_at = case when result_status = 'sent' then clock_timestamp() else jobs.sent_at end,
      updated_at = clock_timestamp()
  where jobs.id = job_row.id
  returning jobs.*;
end;
$$;

revoke all on function public.claim_spc_group_delivery_job(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.claim_spc_group_delivery_job_v2(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.prepare_spc_group_delivery_job(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.complete_spc_group_delivery_job(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_spc_group_delivery_job(uuid, text, integer) to service_role;
grant execute on function public.claim_spc_group_delivery_job_v2(uuid, text, integer) to service_role;
grant execute on function public.prepare_spc_group_delivery_job(uuid, uuid, text) to service_role;
grant execute on function public.complete_spc_group_delivery_job(uuid, uuid, text, text, text) to service_role;
