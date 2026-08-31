create table if not exists public.spc_lost_reason_options (
  id uuid primary key default gen_random_uuid(),
  audience text not null check (audience in ('BUYER TRADER', 'SUPPLIER TRADER')),
  reason text not null check (char_length(btrim(reason)) between 1 and 160),
  sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create unique index if not exists spc_lost_reason_options_audience_reason_key
  on public.spc_lost_reason_options(audience, reason);

create index if not exists spc_lost_reason_options_active_order_idx
  on public.spc_lost_reason_options(audience, sort_order, reason)
  where is_active;

create or replace function private.set_spc_lost_reason_option_updated_at()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function private.set_spc_lost_reason_option_updated_at() from public, anon, authenticated;
grant execute on function private.set_spc_lost_reason_option_updated_at() to service_role;

drop trigger if exists set_spc_lost_reason_option_updated_at on public.spc_lost_reason_options;
create trigger set_spc_lost_reason_option_updated_at
before update on public.spc_lost_reason_options
for each row execute function private.set_spc_lost_reason_option_updated_at();

insert into public.spc_lost_reason_options (audience, reason, sort_order)
values
  ('BUYER TRADER', 'MINIMUM MARGIN', 0),
  ('BUYER TRADER', 'CREDIT OR PAYMENT TERMS', 1),
  ('BUYER TRADER', 'COVERAGE (SUPPLIER NOT COVERED)', 2),
  ('BUYER TRADER', 'COVERAGE (LIMITED BY CUSTOMER)', 3),
  ('BUYER TRADER', 'NOT TIMELY OFFERED', 4),
  ('BUYER TRADER', 'DOUBLE TRADING', 5),
  ('BUYER TRADER', 'T&C', 6),
  ('BUYER TRADER', 'UNKNOWN', 7),
  ('SUPPLIER TRADER', 'SUPPLIER NO AVAILS', 0),
  ('SUPPLIER TRADER', 'SUPPLIER LATE RESPONSE', 1),
  ('SUPPLIER TRADER', 'LIMITED SUPPLIER POOL - SIZE', 2),
  ('SUPPLIER TRADER', 'LIMITED SUPPLIER POOL - SPECS', 3),
  ('SUPPLIER TRADER', 'LIMITED SUPPLIER POOL - SPECIAL REQUIREMENTS', 4),
  ('SUPPLIER TRADER', 'UNABLE TO MEET REQUIRED OFFER TIMING', 5),
  ('SUPPLIER TRADER', 'SUPPLIER WITHDREW', 6),
  ('SUPPLIER TRADER', 'CREDIT OR COMPLIANCE', 7),
  ('SUPPLIER TRADER', 'OTHER', 8)
on conflict (audience, reason) do update
set sort_order = excluded.sort_order,
    is_active = true,
    updated_at = clock_timestamp();

create or replace function public.replace_spc_lost_reason_options(
  p_audience text,
  p_reasons text[]
)
returns table (reason text)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  normalized_audience text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_audience, '')));
begin
  if normalized_audience not in ('BUYER TRADER', 'SUPPLIER TRADER') then
    raise exception 'Valid lost reason audience is required.';
  end if;

  if pg_catalog.cardinality(p_reasons) is null
    or pg_catalog.cardinality(p_reasons) < 1
    or pg_catalog.cardinality(p_reasons) > 50
  then
    raise exception 'Between 1 and 50 lost reasons are required.';
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(p_reasons) as values_to_check(value)
    where pg_catalog.char_length(
      pg_catalog.btrim(
        pg_catalog.regexp_replace(coalesce(values_to_check.value, ''), '[[:space:]]+', ' ', 'g')
      )
    ) not between 1 and 160
  ) then
    raise exception 'Each lost reason must contain between 1 and 160 characters.';
  end if;

  if normalized_audience = 'SUPPLIER TRADER' and not exists (
    select 1
    from pg_catalog.unnest(p_reasons) as supplier_values(value)
    where pg_catalog.upper(
      pg_catalog.btrim(
        pg_catalog.regexp_replace(supplier_values.value, '[[:space:]]+', ' ', 'g')
      )
    ) = 'OTHER'
  ) then
    raise exception 'Supplier lost reasons must include OTHER.';
  end if;

  update public.spc_lost_reason_options as options
  set is_active = false
  where options.audience = normalized_audience;

  insert into public.spc_lost_reason_options (
    audience,
    reason,
    sort_order,
    is_active
  )
  select
    normalized_audience,
    normalized.normalized_reason,
    normalized.sort_order,
    true
  from (
    select
      pg_catalog.upper(
        pg_catalog.btrim(
          pg_catalog.regexp_replace(reason_values.value, '[[:space:]]+', ' ', 'g')
        )
      ) as normalized_reason,
      (pg_catalog.min(reason_values.position) - 1)::integer as sort_order
    from pg_catalog.unnest(p_reasons) with ordinality as reason_values(value, position)
    group by 1
  ) as normalized
  order by normalized.sort_order
  on conflict (audience, reason) do update
  set sort_order = excluded.sort_order,
      is_active = true;

  return query
  select options.reason
  from public.spc_lost_reason_options as options
  where options.audience = normalized_audience
    and options.is_active
  order by options.sort_order, options.reason;
end;
$$;

revoke all on function public.replace_spc_lost_reason_options(text, text[])
  from public, anon, authenticated;
grant execute on function public.replace_spc_lost_reason_options(text, text[])
  to service_role;

alter table public.spc_lost_reason_options enable row level security;
drop policy if exists spc_lost_reason_options_no_public_access on public.spc_lost_reason_options;
create policy spc_lost_reason_options_no_public_access
  on public.spc_lost_reason_options
  for all
  using (false)
  with check (false);

revoke all privileges on table public.spc_lost_reason_options from public, anon, authenticated;
grant select, insert, update, delete on table public.spc_lost_reason_options to service_role;

do $$
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is not null then
    perform public.audit_enable_table('public.spc_lost_reason_options'::regclass);
  end if;
end;
$$;

drop trigger if exists bunker_map_backup_epoch_fence
  on public.spc_lost_reason_options;
create trigger bunker_map_backup_epoch_fence
after insert or update or delete or truncate on public.spc_lost_reason_options
for each statement
execute function private.record_bunker_map_backup_mutation();

comment on table public.spc_lost_reason_options is
  'Administrator-managed buyer and supplier lost-reason dictionaries for SPC outcomes.';
