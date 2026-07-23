-- Fence the paged JSON export against concurrent committed writes without
-- serializing normal writers. Tracked write transactions share an advisory
-- transaction lock and append one commit-visible marker. The backup captures
-- the marker while briefly holding the exclusive form of that lock before and
-- after all reads; it fails closed if a writer is active or the marker changes.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.bunker_map_backup_mutations (
  mutation_id bigint generated always as identity primary key,
  transaction_id xid8 not null unique,
  recorded_at timestamptz not null default clock_timestamp()
);

alter table private.bunker_map_backup_mutations enable row level security;
revoke all on private.bunker_map_backup_mutations
  from public, anon, authenticated, service_role;

create or replace function private.record_bunker_map_backup_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Shared transaction locks are mutually compatible, so ordinary writers do
  -- not serialize one another. The backup's fence RPC takes the exclusive form.
  perform pg_catalog.pg_advisory_xact_lock_shared(
    730261052372033133::bigint
  );

  insert into private.bunker_map_backup_mutations (transaction_id)
  values (pg_catalog.pg_current_xact_id())
  on conflict (transaction_id) do nothing;

  return null;
end;
$$;

revoke all on function private.record_bunker_map_backup_mutation()
  from public, anon, authenticated, service_role;

create or replace function public.get_bunker_map_backup_export_fence()
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  fence_acquired boolean;
  committed_epoch bigint;
begin
  fence_acquired :=
    pg_catalog.pg_try_advisory_xact_lock(730261052372033133::bigint);

  if not fence_acquired then
    return pg_catalog.jsonb_build_object(
      'schema', 'bunker-map.backup-export-fence/v1',
      'ready', false,
      'epoch', null
    );
  end if;

  select coalesce(max(mutations.mutation_id), 0)
  into committed_epoch
  from private.bunker_map_backup_mutations as mutations;

  return pg_catalog.jsonb_build_object(
    'schema', 'bunker-map.backup-export-fence/v1',
    'ready', true,
    'epoch', committed_epoch
  );
end;
$$;

revoke all on function public.get_bunker_map_backup_export_fence()
  from public, anon, authenticated;
grant execute on function public.get_bunker_map_backup_export_fence()
  to service_role;

do $$
declare
  target record;
begin
  for target in
    select tables.relname as table_name
    from pg_catalog.pg_class as tables
    join pg_catalog.pg_namespace as schemas
      on schemas.oid = tables.relnamespace
    where schemas.nspname = 'public'
      and tables.relkind in ('r', 'p')
      and tables.relpersistence = 'p'
      and tables.relname not in (
        'bunker_map_backup_lock',
        'outlook_exchange_sync_lock'
      )
    order by tables.relname
  loop
    execute format(
      'drop trigger if exists bunker_map_backup_epoch_fence on public.%I',
      target.table_name
    );
    execute format(
      'create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.%I for each statement execute function private.record_bunker_map_backup_mutation()',
      target.table_name
    );
  end loop;
end;
$$;

create or replace function public.get_bunker_map_backup_inventory()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.jsonb_build_object(
    'schema', 'bunker-map.backup-inventory/v1',
    'migrationHead', (
      select max(migration.version)
      from supabase_migrations.schema_migrations as migration
    ),
    'tables', coalesce(
      (
        select pg_catalog.jsonb_agg(tables.relname order by tables.relname)
        from pg_catalog.pg_class as tables
        join pg_catalog.pg_namespace as schemas
          on schemas.oid = tables.relnamespace
        where schemas.nspname = 'public'
          and tables.relkind in ('r', 'p')
          and tables.relpersistence = 'p'
      ),
      '[]'::jsonb
    ),
    'unfencedTables', coalesce(
      (
        select pg_catalog.jsonb_agg(tables.relname order by tables.relname)
        from pg_catalog.pg_class as tables
        join pg_catalog.pg_namespace as schemas
          on schemas.oid = tables.relnamespace
        where schemas.nspname = 'public'
          and tables.relkind in ('r', 'p')
          and tables.relpersistence = 'p'
          and tables.relname not in (
            'bunker_map_backup_lock',
            'outlook_exchange_sync_lock'
          )
          and not exists (
            select 1
            from pg_catalog.pg_trigger as triggers
            where triggers.tgrelid = tables.oid
              and triggers.tgname = 'bunker_map_backup_epoch_fence'
              and not triggers.tgisinternal
              and triggers.tgenabled in ('O', 'A')
              and triggers.tgfoid =
                'private.record_bunker_map_backup_mutation()'::regprocedure
              and (triggers.tgtype::integer & 1) = 0
              and (triggers.tgtype::integer & 2) = 0
              and (triggers.tgtype::integer & 64) = 0
              and (triggers.tgtype::integer & 60) = 60
          )
      ),
      '[]'::jsonb
    ),
    'catalogSha256', (
      select pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(
            coalesce(
              pg_catalog.string_agg(
                pg_catalog.jsonb_build_array(
                  tables.relname,
                  tables.relkind,
                  columns.attnum,
                  columns.attname,
                  pg_catalog.format_type(
                    columns.atttypid,
                    columns.atttypmod
                  ),
                  columns.attnotnull,
                  columns.attidentity,
                  columns.attgenerated,
                  columns.attcollation,
                  coalesce(
                    pg_catalog.pg_get_expr(
                      defaults.adbin,
                      defaults.adrelid
                    ),
                    ''
                  )
                )::text,
                E'\n'
                order by tables.relname, columns.attnum
              ),
              ''
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
      from pg_catalog.pg_class as tables
      join pg_catalog.pg_namespace as schemas
        on schemas.oid = tables.relnamespace
      join pg_catalog.pg_attribute as columns
        on columns.attrelid = tables.oid
      left join pg_catalog.pg_attrdef as defaults
        on defaults.adrelid = tables.oid
        and defaults.adnum = columns.attnum
      where schemas.nspname = 'public'
        and tables.relkind in ('r', 'p')
        and tables.relpersistence = 'p'
        and columns.attnum > 0
        and not columns.attisdropped
    )
  );
$$;

revoke all on function public.get_bunker_map_backup_inventory()
  from public, anon, authenticated;
grant execute on function public.get_bunker_map_backup_inventory()
  to service_role;
