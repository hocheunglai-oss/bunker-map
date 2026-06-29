create extension if not exists "pgcrypto";

create sequence if not exists public.spc_enquiry_number_seq;

create table if not exists public.spc_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  display_name text,
  role text not null default 'buyer_trader'
    check (role in ('buyer_trader', 'supplier_trader')),
  password_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists spc_users_username_lower_key
on public.spc_users(lower(username));

create table if not exists public.spc_enquiries (
  id uuid primary key default gen_random_uuid(),
  enquiry_number text not null default (
    'SPC-' ||
    to_char(now() at time zone 'Asia/Hong_Kong', 'YYYYMMDD') ||
    '-' ||
    lpad(nextval('public.spc_enquiry_number_seq')::text, 4, '0')
  ),
  title text not null,
  vessel_name text,
  port text,
  product text,
  quantity text,
  delivery_date date,
  supplier_name text,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'quoted', 'closed', 'cancelled')),
  notes text,
  created_by_username text not null,
  created_by_display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists spc_enquiries_enquiry_number_key
on public.spc_enquiries(enquiry_number);

create index if not exists spc_enquiries_created_at_idx
on public.spc_enquiries(created_at desc);

create index if not exists spc_enquiries_created_by_idx
on public.spc_enquiries(created_by_username, created_at desc);

create or replace function public.set_spc_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_spc_users_updated_at on public.spc_users;
create trigger set_spc_users_updated_at
before update on public.spc_users
for each row
execute function public.set_spc_updated_at();

drop trigger if exists set_spc_enquiries_updated_at on public.spc_enquiries;
create trigger set_spc_enquiries_updated_at
before update on public.spc_enquiries
for each row
execute function public.set_spc_updated_at();

alter table public.spc_users enable row level security;
alter table public.spc_enquiries enable row level security;

drop policy if exists "spc_users_no_public_access" on public.spc_users;
create policy "spc_users_no_public_access"
  on public.spc_users
  for all
  using (false)
  with check (false);

drop policy if exists "spc_enquiries_no_public_access" on public.spc_enquiries;
create policy "spc_enquiries_no_public_access"
  on public.spc_enquiries
  for all
  using (false)
  with check (false);

revoke all on table public.spc_users from anon, authenticated;
revoke all on table public.spc_enquiries from anon, authenticated;
revoke all on sequence public.spc_enquiry_number_seq from anon, authenticated;

grant select, insert, update, delete on table public.spc_users to service_role;
grant select, insert, update, delete on table public.spc_enquiries to service_role;
grant usage, select on sequence public.spc_enquiry_number_seq to service_role;

do $$
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is not null then
    perform public.audit_enable_table('public.spc_users'::regclass);
    perform public.audit_enable_table('public.spc_enquiries'::regclass);
  end if;
end $$;
