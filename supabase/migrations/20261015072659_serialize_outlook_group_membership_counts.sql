-- Serialize derived counts with the parent version used by the group editor.
-- Retry this entire transactional migration if a writer or backup is active;
-- never wait while holding only part of the source/backup lock set.
set local lock_timeout = '1s';
set local statement_timeout = '30s';
do $$
begin
  if not pg_catalog.pg_try_advisory_xact_lock_shared(730261052372033133::bigint) then
    raise exception using errcode = '55P03',
      message = 'Backup export is active; retry the group-count migration.';
  end if;
end;
$$;
lock table public.shared_addressbook_groups,
  public.shared_addressbook_group_members
  in share row exclusive mode nowait;

create or replace function public.outlook_addressbook_refresh_member_count()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  affected_ids text[];
  affected_group_id text;
begin
  if tg_table_schema <> 'public'
    or tg_table_name <> 'shared_addressbook_group_members'
    or tg_when <> 'AFTER' or tg_level <> 'ROW'
    or tg_op not in ('INSERT', 'UPDATE', 'DELETE')
  then
    raise exception 'Member-count function requires its canonical row trigger.';
  end if;

  select pg_catalog.array_agg(affected.group_id order by affected.group_id)
  into affected_ids
  from (
    select distinct group_id
    from (values
      (case when tg_op in ('UPDATE', 'DELETE') then old.group_id else null end),
      (case when tg_op in ('INSERT', 'UPDATE') then new.group_id else null end)
    ) as candidates(group_id)
    where group_id is not null
  ) as affected;

  -- Acquire every affected parent in one deterministic order before counting.
  -- NO KEY UPDATE is deliberately compatible with the FK's KEY SHARE locks:
  -- FOR UPDATE would create a lock-upgrade deadlock between parallel inserts.
  perform groups.id
  from public.shared_addressbook_groups as groups
  where groups.id = any(affected_ids)
  order by groups.id
  for no key update of groups;

  foreach affected_group_id in array affected_ids loop
    -- A separate command in this VOLATILE function obtains a fresh READ
    -- COMMITTED snapshot after any parent-lock wait. Computing this count in
    -- the locking statement or before it loses concurrent committed members.
    -- Always UPDATE: even a same-count identity/source-book change must advance
    -- updated_at so a stale group Save/Delete cannot acknowledge old members.
    update public.shared_addressbook_groups as groups
    set member_count = (
      select pg_catalog.count(*)::integer
      from public.shared_addressbook_group_members as members
      where members.group_id = affected_group_id
    )
    where groups.id = affected_group_id;
    -- A parent already deleted by an FK cascade is intentionally absent.
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- The verified writer roles (service_role/postgres) already have parent
-- SELECT/UPDATE and bypass RLS. Do not add grants or elevate the trigger.
-- Existing triggers execute without a callable RPC/CREATE TRIGGER privilege.
revoke all on function public.outlook_addressbook_refresh_member_count()
  from public, anon, authenticated, service_role;

-- Writers are excluded by the NOWAIT table locks above. Repair only mismatched
-- rows; if every count is correct, issue no UPDATE and no backup-epoch write.
-- Existing audit/outbox triggers exclude derived count-only changes.
do $$
declare
  mismatched record;
begin
  for mismatched in
    select groups.id
    from public.shared_addressbook_groups as groups
    where groups.member_count is distinct from (
      select pg_catalog.count(*)::integer
      from public.shared_addressbook_group_members as members
      where members.group_id = groups.id
    )
    order by groups.id
    for no key update of groups
  loop
    update public.shared_addressbook_groups as groups
    set member_count = (
      select pg_catalog.count(*)::integer
      from public.shared_addressbook_group_members as members
      where members.group_id = mismatched.id
    )
    where groups.id = mismatched.id;
  end loop;
end;
$$;
