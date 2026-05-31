create extension if not exists "pgcrypto";

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  display_name text,
  role text not null default 'user',
  password_hash text not null,
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_users
drop constraint if exists admin_users_role_check;

alter table public.admin_users
drop column if exists is_active;

create unique index if not exists admin_users_username_lower_key
on public.admin_users(lower(username));

drop index if exists public.admin_users_active_idx;

create or replace function public.set_admin_users_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_admin_users_updated_at on public.admin_users;
create trigger set_admin_users_updated_at
before update on public.admin_users
for each row
execute function public.set_admin_users_updated_at();

alter table public.admin_users enable row level security;

drop policy if exists "admin_users_no_public_access" on public.admin_users;
create policy "admin_users_no_public_access"
  on public.admin_users
  for all
  using (false)
  with check (false);

do $$
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is not null then
    perform public.audit_enable_table('public.admin_users'::regclass);
  end if;
end $$;
