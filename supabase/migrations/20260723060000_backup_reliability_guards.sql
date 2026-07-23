-- Serialize verified Drive backups and expose a read-only registry of the live
-- public tables plus the actual applied migration head. The backup producer
-- fails closed when a future table is not explicitly backed up or excluded.

create table if not exists public.bunker_map_backup_lock (
  lock_name text primary key,
  run_id uuid not null,
  acquired_at timestamptz not null,
  expires_at timestamptz not null,
  constraint bunker_map_backup_lock_name
    check (lock_name <> '' and position(E'\n' in lock_name) = 0),
  constraint bunker_map_backup_lock_expiry
    check (expires_at > acquired_at)
);

alter table public.bunker_map_backup_lock enable row level security;
revoke all on public.bunker_map_backup_lock
  from public, anon, authenticated, service_role;

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

create or replace function public.release_bunker_map_backup_lock(
  p_lock_name text,
  p_run_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if nullif(btrim(p_lock_name), '') is null or p_run_id is null then
    return false;
  end if;

  delete from public.bunker_map_backup_lock
  where lock_name = p_lock_name
    and run_id = p_run_id;
  return found;
end;
$$;

create or replace function public.get_bunker_map_backup_inventory()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'bunker-map.backup-inventory/v1',
    'migrationHead', (
      select max(migration.version)
      from supabase_migrations.schema_migrations as migration
    ),
    'tables', coalesce(
      (
        select jsonb_agg(tables.relname order by tables.relname)
        from pg_catalog.pg_class as tables
        join pg_catalog.pg_namespace as schemas
          on schemas.oid = tables.relnamespace
        where schemas.nspname = 'public'
          and tables.relkind in ('r', 'p')
          and tables.relpersistence = 'p'
      ),
      '[]'::jsonb
    )
  );
$$;

revoke all on function public.claim_bunker_map_backup_lock(text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_bunker_map_backup_lock(text, uuid)
  from public, anon, authenticated;
revoke all on function public.get_bunker_map_backup_inventory()
  from public, anon, authenticated;

grant execute on function public.claim_bunker_map_backup_lock(text, uuid, integer)
  to service_role;
grant execute on function public.release_bunker_map_backup_lock(text, uuid)
  to service_role;
grant execute on function public.get_bunker_map_backup_inventory()
  to service_role;
