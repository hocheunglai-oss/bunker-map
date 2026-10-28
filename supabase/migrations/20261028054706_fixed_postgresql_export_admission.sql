-- CLI-created migration; source-owned admission only. This does not enable an exporter, native login,
-- schedule, SQL access, production export or credential. No business rows.
create table private.postgresql_export_admission (
  singleton boolean primary key default true check (singleton),
  week date not null,
  attempts smallint not null check (attempts between 1 and 2),
  fence bigint not null check (fence between 1 and 9007199254740991),
  owner uuid,
  last_started_at timestamptz not null check (isfinite(last_started_at)),
  expires_at timestamptz,
  last_exported boolean,
  check ((owner is null) = (expires_at is null)),
  check (expires_at is null or (isfinite(expires_at) and expires_at > last_started_at
    and expires_at <= last_started_at + interval '250 seconds'))
);
alter table private.postgresql_export_admission enable row level security;
revoke all on private.postgresql_export_admission from public, anon, authenticated, service_role;

-- The clock parameter is solely for isolated native tests; no runtime role can
-- execute this helper. The only granted wrapper uses clock_timestamp().
create function private.claim_postgresql_export_at(p_owner uuid, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  current_week date := date_trunc('week', p_now at time zone 'UTC')::date;
  hkt timestamp := p_now at time zone 'Asia/Hong_Kong';
  lease_end timestamptz;
  held private.postgresql_export_admission%rowtype;
begin
  if p_owner is null or p_now is null or not isfinite(p_now) then
    raise exception using errcode = '22023', message = 'Invalid export admission.';
  end if;
  if extract(hour from hkt) < 2 or extract(hour from hkt) >= 6 then return null; end if;
  lease_end := least(p_now + interval '250 seconds',
    (date_trunc('day', hkt) + interval '6 hours') at time zone 'Asia/Hong_Kong');
  if lease_end - p_now < interval '70 seconds' then return null; end if;

  -- Fixed lock key, shared with the daily JSON backup. It prevents two full
  -- source reads overlapping. Neither caller can choose a lock namespace here.
  if not public.claim_bunker_map_backup_lock('daily-supabase-drive-v2', p_owner,
    floor(extract(epoch from lease_end - p_now))::integer) then return null; end if;

  -- Serialize the first-ever insert as well as later admissions. This key is
  -- fixed and transaction-scoped; the source RPC cannot hold it after return.
  perform pg_advisory_xact_lock(711402, 1);
  select * into held from private.postgresql_export_admission where singleton for update;
  if found and held.owner = p_owner and held.expires_at > p_now then
    return jsonb_build_object('week',held.week,'owner',held.owner,'fence',held.fence);
  end if;
  if found and (held.expires_at > p_now or held.last_started_at > p_now - interval '1 hour'
    or (held.week = current_week and held.attempts >= 2)) then
    perform public.release_bunker_map_backup_lock('daily-supabase-drive-v2', p_owner);
    return null;
  end if;
  insert into private.postgresql_export_admission(singleton, week, attempts, fence, owner, last_started_at, expires_at, last_exported)
  values (true, current_week, case when held.week = current_week then held.attempts + 1 else 1 end,
    coalesce(held.fence,0) + 1,p_owner,p_now,lease_end,null)
  on conflict(singleton) do update set week=excluded.week, attempts=excluded.attempts,
    fence=excluded.fence, owner=excluded.owner, last_started_at=excluded.last_started_at,
    expires_at=excluded.expires_at,last_exported=null;
  return jsonb_build_object('week',current_week,'owner',p_owner,'fence',coalesce(held.fence,0)+1);
end;
$$;

create function public.claim_fixed_postgresql_export(p_owner uuid)
returns jsonb language sql security definer set search_path = pg_catalog, pg_temp
as $$ select private.claim_postgresql_export_at(p_owner, clock_timestamp()); $$;

create function public.finish_fixed_postgresql_export(p_owner uuid, p_fence bigint, p_exported boolean)
returns boolean language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if p_owner is null or p_fence is null or p_fence < 1 or p_exported is null then return false; end if;
  -- Match the claim's lock order. A stale owner never clears a successor lease.
  perform 1 from public.bunker_map_backup_lock where lock_name='daily-supabase-drive-v2' for update;
  perform pg_advisory_xact_lock(711402, 1);
  update private.postgresql_export_admission set owner=null, expires_at=null,last_exported=p_exported
    where singleton and owner=p_owner and fence=p_fence;
  if not found then return false; end if;
  perform public.release_bunker_map_backup_lock('daily-supabase-drive-v2', p_owner);
  -- Native exit only, not a claim that GCS copied, read back or restored it.
  return true;
end;
$$;

revoke all on function private.claim_postgresql_export_at(uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.claim_fixed_postgresql_export(uuid) from public,anon,authenticated;
revoke all on function public.finish_fixed_postgresql_export(uuid,bigint,boolean) from public,anon,authenticated;
grant execute on function public.claim_fixed_postgresql_export(uuid) to service_role;
grant execute on function public.finish_fixed_postgresql_export(uuid,bigint,boolean) to service_role;
