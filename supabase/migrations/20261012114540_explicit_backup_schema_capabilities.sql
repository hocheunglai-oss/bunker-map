-- Add exact sparse-migration and physical receipt-schema evidence. Preserve the
-- current inventory/catalog/fence behavior; no business rows are changed.
-- Missing tables or recovery columns after their exact migration remain errors.
CREATE OR REPLACE FUNCTION public.get_bunker_map_backup_inventory()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
            'admin_sessions',
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
  ) || pg_catalog.jsonb_build_object(
    'appliedMigrations', coalesce(
      (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'version', migration.version, 'name', migration.name
       ) order by migration.version)
       from supabase_migrations.schema_migrations as migration),
      '[]'::jsonb
    ),
    'receiptColumns', coalesce(
      (select pg_catalog.jsonb_agg(
         pg_catalog.jsonb_build_object(
           'name', columns.attname,
           'type', pg_catalog.format_type(columns.atttypid, columns.atttypmod),
           'nullable', not columns.attnotnull
         ) order by columns.attname
       )
       from pg_catalog.pg_attribute as columns
       where columns.attrelid = pg_catalog.to_regclass('public.price_setter_creation_receipts')
         and columns.attnum > 0 and not columns.attisdropped),
      '[]'::jsonb
    )
  );
$function$;
revoke all on function public.get_bunker_map_backup_inventory()
  from public, anon, authenticated;
grant execute on function public.get_bunker_map_backup_inventory()
  to service_role;
