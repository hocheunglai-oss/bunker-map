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

create table if not exists public.spc_fixtures (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid not null,
  fixture_status text not null default 'pending'
    check (fixture_status in ('pending', 'completed', 'cancelled')),
  fixture_date date default ((now() at time zone 'Asia/Hong_Kong')::date),
  supplier_trader_user_id uuid,
  supplier_trader_username text not null,
  supplier_trader_display_name text not null,
  buyer_trader_user_id uuid,
  buyer_trader_username text not null,
  buyer_trader_display_name text not null,
  account text,
  commission text,
  earliest_eta text,
  vessel_name text,
  hsfo text,
  vlsfo text,
  lsmgo text,
  supplier_name text,
  supplier_key text,
  price text,
  barging text,
  completed_at timestamptz,
  completed_by_username text,
  completed_by_display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spc_fixtures_enquiry_id_fkey
    foreign key (enquiry_id) references public.spc_enquiries(id) on delete cascade,
  constraint spc_fixtures_supplier_trader_user_id_fkey
    foreign key (supplier_trader_user_id) references public.spc_users(id) on delete set null,
  constraint spc_fixtures_buyer_trader_user_id_fkey
    foreign key (buyer_trader_user_id) references public.spc_users(id) on delete set null
);

create unique index if not exists spc_fixtures_enquiry_id_key
on public.spc_fixtures(enquiry_id);

create index if not exists spc_fixtures_status_created_idx
on public.spc_fixtures(fixture_status, created_at desc);

create index if not exists spc_fixtures_supplier_key_idx
on public.spc_fixtures(supplier_key);

create index if not exists spc_fixtures_supplier_trader_user_id_idx
on public.spc_fixtures(supplier_trader_user_id);

create index if not exists spc_fixtures_buyer_trader_user_id_idx
on public.spc_fixtures(buyer_trader_user_id);

create index if not exists spc_fixtures_traders_idx
on public.spc_fixtures(supplier_trader_username, buyer_trader_username);

create table if not exists public.spc_suppliers (
  key text primary key,
  name text not null,
  aliases text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_username text,
  updated_by_username text
);

create index if not exists spc_suppliers_name_idx
on public.spc_suppliers(name);

create table if not exists public.spc_presentation_chunks (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  sort_order integer not null default 0,
  section_label text not null default 'CHAPTER',
  title text not null,
  summary text not null default '',
  narration text not null default '',
  key_points text[] not null default '{}',
  q_and_a_prompt text not null default '',
  visual_kind text not null default 'video',
  video_path text,
  video_mime_type text,
  video_bytes bigint,
  narration_path text,
  narration_mime_type text,
  narration_bytes bigint,
  duration_seconds integer,
  media_version integer not null default 1,
  revision integer not null default 1,
  status text not null default 'draft'
    check (status in ('draft', 'published')),
  created_by_username text,
  updated_by_username text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spc_presentation_chunks_duration_check
    check (duration_seconds is null or duration_seconds between 0 and 3600),
  constraint spc_presentation_chunks_media_version_check
    check (media_version > 0),
  constraint spc_presentation_chunks_revision_check
    check (revision > 0)
);

create unique index if not exists spc_presentation_chunks_slug_key
on public.spc_presentation_chunks(lower(slug));

create index if not exists spc_presentation_chunks_status_order_idx
on public.spc_presentation_chunks(status, sort_order, created_at);

create or replace function public.set_spc_updated_at()
returns trigger
language plpgsql
set search_path = public
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

drop trigger if exists set_spc_fixtures_updated_at on public.spc_fixtures;
create trigger set_spc_fixtures_updated_at
before update on public.spc_fixtures
for each row
execute function public.set_spc_updated_at();

drop trigger if exists set_spc_suppliers_updated_at on public.spc_suppliers;
create trigger set_spc_suppliers_updated_at
before update on public.spc_suppliers
for each row
execute function public.set_spc_updated_at();

drop trigger if exists set_spc_presentation_chunks_updated_at on public.spc_presentation_chunks;
create trigger set_spc_presentation_chunks_updated_at
before update on public.spc_presentation_chunks
for each row
execute function public.set_spc_updated_at();

alter table public.spc_users enable row level security;
alter table public.spc_enquiries enable row level security;
alter table public.spc_fixtures enable row level security;
alter table public.spc_suppliers enable row level security;
alter table public.spc_presentation_chunks enable row level security;

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

drop policy if exists "spc_fixtures_no_public_access" on public.spc_fixtures;
create policy "spc_fixtures_no_public_access"
  on public.spc_fixtures
  for all
  using (false)
  with check (false);

drop policy if exists "spc_suppliers_no_public_access" on public.spc_suppliers;
create policy "spc_suppliers_no_public_access"
  on public.spc_suppliers
  for all
  using (false)
  with check (false);

drop policy if exists "spc_presentation_chunks_no_public_access" on public.spc_presentation_chunks;
create policy "spc_presentation_chunks_no_public_access"
  on public.spc_presentation_chunks
  for all
  using (false)
  with check (false);

revoke all on table public.spc_users from anon, authenticated;
revoke all on table public.spc_enquiries from anon, authenticated;
revoke all on table public.spc_fixtures from anon, authenticated;
revoke all on table public.spc_suppliers from anon, authenticated;
revoke all on table public.spc_presentation_chunks from anon, authenticated;
revoke all on sequence public.spc_enquiry_number_seq from anon, authenticated;

grant select, insert, update, delete on table public.spc_users to service_role;
grant select, insert, update, delete on table public.spc_enquiries to service_role;
grant select, insert, update, delete on table public.spc_fixtures to service_role;
grant select, insert, update, delete on table public.spc_suppliers to service_role;
grant select, insert, update, delete on table public.spc_presentation_chunks to service_role;
grant usage, select on sequence public.spc_enquiry_number_seq to service_role;

do $$
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is not null then
    perform public.audit_enable_table('public.spc_users'::regclass);
    perform public.audit_enable_table('public.spc_enquiries'::regclass);
    perform public.audit_enable_table('public.spc_fixtures'::regclass);
    perform public.audit_enable_table('public.spc_suppliers'::regclass);
    perform public.audit_enable_table('public.spc_presentation_chunks'::regclass);
  end if;
end $$;
