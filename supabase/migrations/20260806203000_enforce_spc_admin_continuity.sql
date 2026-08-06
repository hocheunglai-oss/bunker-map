-- Make SPC user rows and their role/profile metadata one atomic security
-- boundary. The advisory lock serializes every affected write, while the
-- deferred triggers protect equivalent direct writes and audit-log undo.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.normalise_spc_effective_role(raw_role text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  with cleaned as (
    select pg_catalog.left(
      pg_catalog.upper(
        pg_catalog.regexp_replace(
          pg_catalog.regexp_replace(
            pg_catalog.btrim(coalesce(raw_role, '')),
            '[_-]+',
            ' ',
            'g'
          ),
          '[[:space:]]+',
          ' ',
          'g'
        )
      ),
      40
    ) as role
  )
  select case
    when role in ('', 'BUYER', 'BUYER TRADER') then 'BUYER TRADER'
    when role in ('SUPPLIER', 'SUPPLIER TRADER') then 'SUPPLIER TRADER'
    when role in ('ADMIN', 'ADMINISTRATOR') then 'ADMIN'
    else role
  end
  from cleaned;
$$;

create or replace function private.spc_effective_role(
  p_user_id uuid,
  p_username text,
  p_database_role text,
  p_store_payload jsonb
)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  with assignments as (
    select assignment.value, assignment.ordinality
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(p_store_payload -> 'userRoles') = 'array'
          then p_store_payload -> 'userRoles'
        else '[]'::jsonb
      end
    ) with ordinality as assignment(value, ordinality)
  ), selected_role as (
    select assignment.value ->> 'role' as role
    from assignments as assignment
    where assignment.value ->> 'userId' = p_user_id::text
    order by assignment.ordinality desc
    limit 1
  ), selected_username_role as (
    select assignment.value ->> 'role' as role
    from assignments as assignment
    where pg_catalog.lower(assignment.value ->> 'username') =
      pg_catalog.lower(p_username)
    order by assignment.ordinality desc
    limit 1
  )
  select private.normalise_spc_effective_role(
    coalesce(
      (select role from selected_role),
      (select role from selected_username_role),
      p_database_role
    )
  );
$$;

create or replace function private.lock_spc_user_administration()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_table_name = 'office_calendar_store'
    and coalesce(to_jsonb(new) ->> 'key', '') <> 'spc-permission-groups'
    and coalesce(to_jsonb(old) ->> 'key', '') <> 'spc-permission-groups'
  then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('spc-user-administration', 0)
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.assert_spc_active_admin()
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  store_payload jsonb := '{}'::jsonb;
begin
  select store.payload
  into store_payload
  from public.office_calendar_store as store
  where store.key = 'spc-permission-groups';

  if not exists (
    select 1
    from public.spc_users as users
    where users.is_active
      and private.spc_effective_role(
        users.id,
        users.username,
        users.role,
        coalesce(store_payload, '{}'::jsonb)
      ) = 'ADMIN'
  ) then
    raise exception
      'The final active ADMIN cannot be demoted, deactivated, or deleted.';
  end if;
end;
$$;

create or replace function private.enforce_spc_active_admin_continuity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_table_name = 'office_calendar_store'
    and coalesce(to_jsonb(new) ->> 'key', '') <> 'spc-permission-groups'
    and coalesce(to_jsonb(old) ->> 'key', '') <> 'spc-permission-groups'
  then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  perform private.assert_spc_active_admin();

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists lock_spc_user_administration
  on public.spc_users;
create trigger lock_spc_user_administration
before insert or update or delete on public.spc_users
for each row
execute function private.lock_spc_user_administration();

drop trigger if exists enforce_spc_active_admin_continuity
  on public.spc_users;
create constraint trigger enforce_spc_active_admin_continuity
after insert or update or delete on public.spc_users
deferrable initially deferred
for each row
execute function private.enforce_spc_active_admin_continuity();

drop trigger if exists lock_spc_permission_store_administration
  on public.office_calendar_store;
create trigger lock_spc_permission_store_administration
before insert or update or delete on public.office_calendar_store
for each row
execute function private.lock_spc_user_administration();

drop trigger if exists enforce_spc_permission_store_admin_continuity
  on public.office_calendar_store;
create constraint trigger enforce_spc_permission_store_admin_continuity
after insert or update or delete on public.office_calendar_store
deferrable initially deferred
for each row
execute function private.enforce_spc_active_admin_continuity();

create or replace function public.save_spc_user_with_admin_continuity(
  p_user_id uuid,
  p_username text,
  p_display_name text,
  p_whatsapp_phone text,
  p_database_role text,
  p_effective_role text,
  p_office text,
  p_must_change_password boolean,
  p_is_supplier_trader boolean,
  p_password_hash text,
  p_is_active boolean
)
returns table (
  id uuid,
  username text,
  display_name text,
  whatsapp_phone text,
  role text,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_time_value constant timestamptz := pg_catalog.clock_timestamp();
  target_id uuid := p_user_id;
  is_new constant boolean := p_user_id is null;
  existing_user public.spc_users%rowtype;
  previous_username text;
  clean_username text := pg_catalog.btrim(coalesce(p_username, ''));
  clean_display_name text;
  clean_database_role text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_database_role, '')));
  clean_effective_role text := private.normalise_spc_effective_role(p_effective_role);
  clean_office text;
  store_payload jsonb := '{}'::jsonb;
  role_assignments jsonb := '[]'::jsonb;
  profile_assignments jsonb := '[]'::jsonb;
  office_assignments jsonb := '[]'::jsonb;
  previous_profile jsonb;
  effective_must_change_password boolean;
  effective_supplier_trader boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('spc-user-administration', 0)
  );

  if clean_username = '' then
    raise exception 'Username is required.';
  end if;
  if pg_catalog.length(clean_username) > 320 then
    raise exception 'Username must contain no more than 320 characters.';
  end if;
  if clean_database_role not in ('buyer_trader', 'supplier_trader') then
    raise exception 'Select a valid permission group.';
  end if;
  if clean_effective_role = '' then
    raise exception 'Select a valid permission group.';
  end if;
  if p_whatsapp_phone is not null
    and p_whatsapp_phone !~ '^[1-9][0-9]{7,14}$'
  then
    raise exception 'WhatsApp phone must include a valid country code.';
  end if;
  if p_password_hash is not null
    and p_password_hash !~ '^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$'
  then
    raise exception 'The password credential is invalid.';
  end if;
  if is_new and p_password_hash is null then
    raise exception 'Password is required for a new user.';
  end if;

  if not is_new then
    select users.*
    into existing_user
    from public.spc_users as users
    where users.id = p_user_id
    for update;

    if not found then
      raise exception 'User not found.';
    end if;
    previous_username := existing_user.username;
  else
    previous_username := clean_username;
  end if;

  select store.payload
  into store_payload
  from public.office_calendar_store as store
  where store.key = 'spc-permission-groups'
  for update;

  if not found or pg_catalog.jsonb_typeof(store_payload) <> 'object' then
    store_payload := '{}'::jsonb;
  end if;

  select profile.value
  into previous_profile
  from pg_catalog.jsonb_array_elements(
    case
      when pg_catalog.jsonb_typeof(store_payload -> 'userProfiles') = 'array'
        then store_payload -> 'userProfiles'
      else '[]'::jsonb
    end
  ) with ordinality as profile(value, ordinality)
  where profile.value ->> 'userId' = target_id::text
    or pg_catalog.lower(profile.value ->> 'username') =
      pg_catalog.lower(previous_username)
  order by
    (profile.value ->> 'userId' = target_id::text) desc,
    profile.ordinality desc
  limit 1;

  clean_display_name := coalesce(
    nullif(pg_catalog.btrim(p_display_name), ''),
    clean_username
  );
  if pg_catalog.length(clean_display_name) > 256 then
    raise exception 'Display name must contain no more than 256 characters.';
  end if;
  clean_office := pg_catalog.upper(
    pg_catalog.regexp_replace(
      pg_catalog.btrim(coalesce(p_office, previous_profile ->> 'office', '')),
      '[[:space:]]+',
      ' ',
      'g'
    )
  );
  if clean_office = '' then clean_office := 'ITALY'; end if;
  if pg_catalog.length(clean_office) > 128 then
    raise exception 'Office must contain no more than 128 characters.';
  end if;

  effective_must_change_password := case
    when is_new then true
    when p_must_change_password is not null then p_must_change_password
    else coalesce(previous_profile ->> 'mustChangePassword', 'false') = 'true'
  end;
  effective_supplier_trader := case
    when clean_effective_role = 'SUPPLIER TRADER' then true
    when p_is_supplier_trader is not null then p_is_supplier_trader
    else coalesce(previous_profile ->> 'isSupplierTrader', 'false') = 'true'
  end;

  if is_new then
    insert into public.spc_users (
      username,
      display_name,
      whatsapp_phone,
      role,
      password_hash,
      is_active,
      created_at,
      updated_at
    ) values (
      clean_username,
      clean_display_name,
      p_whatsapp_phone,
      clean_database_role,
      p_password_hash,
      coalesce(p_is_active, true),
      current_time_value,
      current_time_value
    )
    returning spc_users.id into target_id;
  else
    update public.spc_users as users
    set username = clean_username,
        display_name = clean_display_name,
        whatsapp_phone = p_whatsapp_phone,
        role = clean_database_role,
        password_hash = coalesce(p_password_hash, users.password_hash),
        is_active = coalesce(p_is_active, true),
        updated_at = current_time_value
    where users.id = target_id;
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(role_item.value order by role_item.ordinality),
    '[]'::jsonb
  )
  into role_assignments
  from pg_catalog.jsonb_array_elements(
    case
      when pg_catalog.jsonb_typeof(store_payload -> 'userRoles') = 'array'
        then store_payload -> 'userRoles'
      else '[]'::jsonb
    end
  ) with ordinality as role_item(value, ordinality)
  where role_item.value ->> 'userId' <> target_id::text
    and pg_catalog.lower(role_item.value ->> 'username') not in (
      pg_catalog.lower(previous_username),
      pg_catalog.lower(clean_username)
    );

  if clean_effective_role <>
    private.normalise_spc_effective_role(clean_database_role)
  then
    role_assignments := role_assignments || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'userId', target_id,
        'username', clean_username,
        'role', clean_effective_role,
        'updatedAt', current_time_value
      )
    );
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(profile_item.value order by profile_item.ordinality),
    '[]'::jsonb
  )
  into profile_assignments
  from pg_catalog.jsonb_array_elements(
    case
      when pg_catalog.jsonb_typeof(store_payload -> 'userProfiles') = 'array'
        then store_payload -> 'userProfiles'
      else '[]'::jsonb
    end
  ) with ordinality as profile_item(value, ordinality)
  where profile_item.value ->> 'userId' <> target_id::text
    and pg_catalog.lower(profile_item.value ->> 'username') not in (
      pg_catalog.lower(previous_username),
      pg_catalog.lower(clean_username)
    );

  profile_assignments := profile_assignments || pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'userId', target_id,
      'username', clean_username,
      'office', clean_office,
      'mustChangePassword', effective_must_change_password,
      'isSupplierTrader', effective_supplier_trader,
      'updatedAt', current_time_value
    )
  );

  office_assignments := case
    when pg_catalog.jsonb_typeof(store_payload -> 'offices') = 'array'
      and pg_catalog.jsonb_array_length(store_payload -> 'offices') > 0
      then store_payload -> 'offices'
    else '["ITALY","HONG KONG","SINGAPORE","MONACO","FRANCE","USA","KOREA","JAPAN","VIETNAM"]'::jsonb
  end;
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements_text(office_assignments) as office(value)
    where pg_catalog.upper(pg_catalog.btrim(office.value)) = clean_office
  ) then
    office_assignments := office_assignments || pg_catalog.to_jsonb(clean_office);
  end if;

  store_payload := pg_catalog.jsonb_set(store_payload, '{userRoles}', role_assignments, true);
  store_payload := pg_catalog.jsonb_set(store_payload, '{userProfiles}', profile_assignments, true);
  store_payload := pg_catalog.jsonb_set(store_payload, '{offices}', office_assignments, true);

  insert into public.office_calendar_store (key, payload, updated_at)
  values ('spc-permission-groups', store_payload, current_time_value)
  on conflict (key) do update
  set payload = excluded.payload,
      updated_at = excluded.updated_at;

  perform private.assert_spc_active_admin();

  return query
  select
    users.id,
    users.username,
    users.display_name,
    users.whatsapp_phone,
    users.role,
    users.is_active,
    users.created_at,
    users.updated_at
  from public.spc_users as users
  where users.id = target_id;
end;
$$;

create or replace function public.delete_spc_user_with_admin_continuity(
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  existing_user public.spc_users%rowtype;
  store_payload jsonb;
  role_assignments jsonb := '[]'::jsonb;
  profile_assignments jsonb := '[]'::jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('spc-user-administration', 0)
  );

  select users.*
  into existing_user
  from public.spc_users as users
  where users.id = p_user_id
  for update;

  if not found then
    raise exception 'User not found.';
  end if;

  select store.payload
  into store_payload
  from public.office_calendar_store as store
  where store.key = 'spc-permission-groups'
  for update;

  delete from public.spc_users as users
  where users.id = p_user_id;

  if found then
    select coalesce(
      pg_catalog.jsonb_agg(role_item.value order by role_item.ordinality),
      '[]'::jsonb
    )
    into role_assignments
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(store_payload -> 'userRoles') = 'array'
          then store_payload -> 'userRoles'
        else '[]'::jsonb
      end
    ) with ordinality as role_item(value, ordinality)
    where role_item.value ->> 'userId' <> p_user_id::text
      and pg_catalog.lower(role_item.value ->> 'username') <>
        pg_catalog.lower(existing_user.username);

    select coalesce(
      pg_catalog.jsonb_agg(profile_item.value order by profile_item.ordinality),
      '[]'::jsonb
    )
    into profile_assignments
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(store_payload -> 'userProfiles') = 'array'
          then store_payload -> 'userProfiles'
        else '[]'::jsonb
      end
    ) with ordinality as profile_item(value, ordinality)
    where profile_item.value ->> 'userId' <> p_user_id::text
      and pg_catalog.lower(profile_item.value ->> 'username') <>
        pg_catalog.lower(existing_user.username);

    store_payload := pg_catalog.jsonb_set(
      coalesce(store_payload, '{}'::jsonb),
      '{userRoles}',
      role_assignments,
      true
    );
    store_payload := pg_catalog.jsonb_set(
      store_payload,
      '{userProfiles}',
      profile_assignments,
      true
    );

    update public.office_calendar_store as store
    set payload = store_payload,
        updated_at = pg_catalog.clock_timestamp()
    where store.key = 'spc-permission-groups';
  end if;

  perform private.assert_spc_active_admin();
  return true;
end;
$$;

revoke all on function private.normalise_spc_effective_role(text)
  from public, anon, authenticated, service_role;
revoke all on function private.spc_effective_role(uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.lock_spc_user_administration()
  from public, anon, authenticated, service_role;
revoke all on function private.assert_spc_active_admin()
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_spc_active_admin_continuity()
  from public, anon, authenticated, service_role;

revoke all on function public.save_spc_user_with_admin_continuity(
  uuid, text, text, text, text, text, text, boolean, boolean, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.save_spc_user_with_admin_continuity(
  uuid, text, text, text, text, text, text, boolean, boolean, text, boolean
) to service_role;

revoke all on function public.delete_spc_user_with_admin_continuity(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_spc_user_with_admin_continuity(uuid)
  to service_role;

-- RLS and row triggers do not cover TRUNCATE. No application path requires it.
revoke truncate on table public.spc_users
  from public, anon, authenticated, service_role;
revoke truncate on table public.office_calendar_store
  from public, anon, authenticated, service_role;
