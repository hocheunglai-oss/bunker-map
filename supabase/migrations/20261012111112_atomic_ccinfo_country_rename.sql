-- Country labels and their existing ports must change together, or not at all.
-- This adds no tables and keeps the existing audit/backup/version triggers.
create or replace function private.guard_ccinfo_country_rename()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  undo_id uuid;
begin
  undo_id := public.audit_uuid_setting('app.audit_undo_of_log_id');
  if undo_id is not null and exists (
    select 1 from public.audit_logs as log
    where log.id = undo_id and log.table_schema = 'public'
      and log.table_name in ('cc_countries', 'cc_ports')
      and log.request_context ->> 'action' = 'ccinfo_country_rename'
  ) then
    raise exception using errcode = '23514',
      message = 'Use CCINFO Rename to reverse a country rename. Its ports cannot be undone separately.';
  end if;
  if tg_table_name = 'cc_countries' and tg_op = 'UPDATE'
    and new.name is distinct from old.name
    and pg_catalog.current_setting('app.ccinfo_country_rename', true) is distinct from old.id::text
  then
    raise exception using errcode = '23514',
      message = 'Use CCINFO Rename to change a country name and its ports together.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.guard_ccinfo_country_rename() from public, anon, authenticated, service_role;

create or replace function private.canonicalize_ccinfo_port_country()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  canonical_name text;
begin
  -- Do not rewrite unrelated historical labels during ordinary content saves.
  if tg_op = 'UPDATE' and new.country_id is not distinct from old.country_id
    and new.country_name is not distinct from old.country_name then
    return new;
  end if;
  if new.country_id is not null then
    select country.name into canonical_name
    from public.cc_countries as country where country.id = new.country_id
    for key share;
    if not found then
      raise exception using errcode = '23503', message = 'The selected country no longer exists. Reopen the port.';
    end if;
    -- A cached browser may supply the pre-rename label. The stable ID wins.
    new.country_name := canonical_name;
  end if;
  return new;
end;
$$;
revoke all on function private.canonicalize_ccinfo_port_country() from public, anon, authenticated, service_role;

drop trigger if exists guard_ccinfo_country_rename on public.cc_countries;
create trigger guard_ccinfo_country_rename before insert or update or delete on public.cc_countries
for each row execute function private.guard_ccinfo_country_rename();
drop trigger if exists guard_ccinfo_country_rename on public.cc_ports;
create trigger guard_ccinfo_country_rename before insert or update or delete on public.cc_ports
for each row execute function private.guard_ccinfo_country_rename();
drop trigger if exists canonicalize_ccinfo_port_country on public.cc_ports;
create trigger canonicalize_ccinfo_port_country before insert or update of country_id, country_name on public.cc_ports
for each row execute function private.canonicalize_ccinfo_port_country();

create or replace function public.rename_ccinfo_country(
  p_id uuid, p_expected_updated_at timestamptz, p_name text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  country public.cc_countries%rowtype;
  renamed public.cc_countries%rowtype;
  next_name text;
  prior_timeout text;
  prior_context jsonb;
  prior_headers jsonb;
  prior_rename text;
begin
  if coalesce(nullif(pg_catalog.btrim(public.audit_text_setting('app.audit_actor_id')), ''),
    nullif(pg_catalog.btrim(public.audit_request_header('x-bunker-admin-user')), '')) is null then
    raise exception using errcode = '42501', message = 'A signed-in audit actor is required.';
  end if;
  next_name := pg_catalog.upper(pg_catalog.btrim(p_name));
  if p_id is null or p_expected_updated_at is null or not pg_catalog.isfinite(p_expected_updated_at)
    or next_name is null or next_name = '' or pg_catalog.char_length(next_name) > 200
    or next_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'A valid country, saved version and country name are required.';
  end if;

  prior_timeout := pg_catalog.current_setting('lock_timeout');
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  -- Match the existing shared backup fence before any table/row locks.
  perform pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);
  -- Lock in country -> port order, before taking row locks. This prevents two
  -- renames choosing the same name and includes in-flight legacy-name inserts.
  -- ROW SHARE FK lookups remain compatible; normal writers resume at commit.
  lock table public.cc_countries in share row exclusive mode;
  lock table public.cc_ports in share row exclusive mode;
  select * into country from public.cc_countries where id = p_id for no key update;
  if not found or country.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = '40001', message = 'The country changed or was removed. Reopen it before renaming.';
  end if;
  if country.name = next_name then
    raise exception using errcode = '22023', message = 'Enter a different country name.';
  end if;
  if exists (select 1 from public.cc_countries where id <> p_id and pg_catalog.upper(pg_catalog.btrim(name)) = next_name) then
    raise exception using errcode = '23505', message = 'Another country already uses this name.';
  end if;
  if exists (select 1 from public.cc_ports where country_id is null and country_name = country.name)
    and exists (select 1 from public.cc_countries where id <> p_id and name = country.name) then
    raise exception using errcode = '23514', message = 'Some ports have an ambiguous country name. Review them before renaming.';
  end if;

  prior_context := public.audit_json_setting('app.audit_context');
  prior_headers := public.audit_json_setting('request.headers');
  prior_rename := pg_catalog.current_setting('app.ccinfo_country_rename', true);
  perform pg_catalog.set_config('app.ccinfo_country_rename', p_id::text, true);
  -- Standard audit capture merges headers last. Mark even direct, trusted
  -- service calls intrinsically, then restore their original request context.
  perform pg_catalog.set_config('request.headers', (prior_headers ||
    pg_catalog.jsonb_build_object('x-bunker-audit-action', 'ccinfo_country_rename'))::text, true);
  perform pg_catalog.set_config('app.audit_context', (
    prior_context || pg_catalog.jsonb_build_object(
      'action', 'ccinfo_country_rename', 'countryId', p_id
    )
  )::text, true);
  update public.cc_countries set name = next_name where id = p_id returning * into renamed;
  update public.cc_ports set country_name = next_name
  where (country_id = p_id or (country_id is null and country_name = country.name))
    and country_name is distinct from next_name;

  perform pg_catalog.set_config('app.ccinfo_country_rename', coalesce(prior_rename, ''), true);
  perform pg_catalog.set_config('app.audit_context', prior_context::text, true);
  perform pg_catalog.set_config('request.headers', prior_headers::text, true);
  perform pg_catalog.set_config('lock_timeout', prior_timeout, true);
  return pg_catalog.jsonb_build_object('id', renamed.id, 'name', renamed.name,
    'updated_at', pg_catalog.to_jsonb(renamed) ->> 'updated_at');
end;
$$;
revoke all on function public.rename_ccinfo_country(uuid,timestamptz,text) from public, anon, authenticated;
grant execute on function public.rename_ccinfo_country(uuid,timestamptz,text) to service_role;
