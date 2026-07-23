begin;
select plan(10);

select has_table(
  'public',
  'bunker_map_backup_lock',
  'serialized backup lease table exists'
);

select ok(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.bunker_map_backup_lock'::regclass
  )
  and not has_table_privilege(
    'service_role',
    'public.bunker_map_backup_lock',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'public.bunker_map_backup_lock',
    'INSERT'
  ),
  'backup lease state is private and cannot be forged directly'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.claim_bunker_map_backup_lock(text,uuid,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.release_bunker_map_backup_lock(text,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.get_bunker_map_backup_inventory()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_bunker_map_backup_lock(text,uuid,integer)',
    'EXECUTE'
  ),
  'only the hosted service worker can use backup reliability RPCs'
);

select ok(
  public.claim_bunker_map_backup_lock(
    'pg-tap-backup',
    '11111111-1111-4111-8111-111111111111',
    300
  ),
  'the first backup worker acquires the lease'
);

select ok(
  not public.claim_bunker_map_backup_lock(
    'pg-tap-backup',
    '22222222-2222-4222-8222-222222222222',
    300
  ),
  'a second backup worker cannot acquire an active lease'
);

select ok(
  public.claim_bunker_map_backup_lock(
    'pg-tap-backup',
    '11111111-1111-4111-8111-111111111111',
    300
  ),
  'the lease owner can renew its lease idempotently'
);

select ok(
  not public.release_bunker_map_backup_lock(
    'pg-tap-backup',
    '22222222-2222-4222-8222-222222222222'
  ),
  'a non-owner cannot release the backup lease'
);

select ok(
  public.release_bunker_map_backup_lock(
    'pg-tap-backup',
    '11111111-1111-4111-8111-111111111111'
  ),
  'the lease owner can release the backup lease'
);

select ok(
  public.claim_bunker_map_backup_lock(
    'pg-tap-backup',
    '22222222-2222-4222-8222-222222222222',
    300
  ),
  'a released backup lease is reusable by another worker'
);

select ok(
  public.get_bunker_map_backup_inventory() ->> 'schema'
    = 'bunker-map.backup-inventory/v1'
  and public.get_bunker_map_backup_inventory() ->> 'migrationHead'
    ~ '^[0-9]{14}$'
  and public.get_bunker_map_backup_inventory() -> 'tables'
    @> '["bunker_map_backup_lock","shared_addressbook_contacts"]'::jsonb,
  'backup inventory reports the applied migration head and live public tables'
);

select * from finish();
rollback;
