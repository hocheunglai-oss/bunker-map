-- Cutover only: first hold the legacy phonebook-carddav-writes lease and
-- drain old route invocations for their full 300-second maximum duration.
-- Promote the verified Hetzner writer with CARDDAV_WRITE_GENERATION=hetzner-v1
-- while that lease remains held, then apply this fence before releasing it.
-- This retirement persists even after the old lease expires or is released.
-- Rolling back to a legacy deployment requires an explicit corrective
-- migration and replay of changes already acknowledged by the new provider.
-- All other backup locks and owner-only release behavior remain unchanged.

create or replace function public.claim_bunker_map_backup_lock(
  p_lock_name text,
  p_run_id uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  acquired boolean := false;
  acquired_at_value constant timestamptz := clock_timestamp();
begin
  if nullif(btrim(p_lock_name), '') is null
    or position(E'\n' in p_lock_name) > 0
    or p_run_id is null
    or p_lease_seconds is null
    or p_lease_seconds < 60
    or p_lease_seconds > 3600
  then
    raise exception
      'Backup lock name, run ID, and a lease from 60 to 3600 seconds are required.';
  end if;

  if p_lock_name = 'phonebook-carddav-writes' then
    raise exception using
      errcode = '55000',
      message = 'The legacy phonebook CardDAV writer generation has been retired.';
  end if;

  insert into public.bunker_map_backup_lock (
    lock_name,
    run_id,
    acquired_at,
    expires_at
  ) values (
    p_lock_name,
    p_run_id,
    acquired_at_value,
    acquired_at_value + make_interval(secs => p_lease_seconds)
  )
  on conflict (lock_name) do update
  set
    run_id = excluded.run_id,
    acquired_at = excluded.acquired_at,
    expires_at = excluded.expires_at
  where public.bunker_map_backup_lock.expires_at <= acquired_at_value
    or public.bunker_map_backup_lock.run_id = excluded.run_id
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

revoke all on function public.claim_bunker_map_backup_lock(text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_bunker_map_backup_lock(text, uuid, integer)
  to service_role;
