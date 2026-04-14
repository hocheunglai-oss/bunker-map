create extension if not exists "pgcrypto";

create table if not exists public.cc_countries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  region text,
  summary text,
  notes text,
  ports text,
  tags text[] default '{}',
  status text default 'active',
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cc_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text,
  category text,
  summary text,
  notes text,
  contacts text,
  tags text[] default '{}',
  status text default 'active',
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cc_ports (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country_id uuid references public.cc_countries(id) on delete set null,
  country_name text,
  summary text,
  notes text,
  tags text[] default '{}',
  status text default 'active',
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cc_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_root text,
  source_folder text,
  file_type text,
  archive_path text,
  extracted_text text,
  related_country text,
  related_company text,
  tags text[] default '{}',
  review_status text default 'pending',
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cc_company_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.cc_companies(id) on delete cascade,
  file_name text not null,
  file_type text,
  drive_file_id text,
  drive_url text,
  original_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists cc_company_files_company_path_key
on public.cc_company_files(company_id, original_path);

create or replace function public.set_ccinfo_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_cc_countries_updated_at on public.cc_countries;
create trigger set_cc_countries_updated_at
before update on public.cc_countries
for each row
execute function public.set_ccinfo_updated_at();

drop trigger if exists set_cc_companies_updated_at on public.cc_companies;
create trigger set_cc_companies_updated_at
before update on public.cc_companies
for each row
execute function public.set_ccinfo_updated_at();

drop trigger if exists set_cc_ports_updated_at on public.cc_ports;
create trigger set_cc_ports_updated_at
before update on public.cc_ports
for each row
execute function public.set_ccinfo_updated_at();

drop trigger if exists set_cc_documents_updated_at on public.cc_documents;
create trigger set_cc_documents_updated_at
before update on public.cc_documents
for each row
execute function public.set_ccinfo_updated_at();

drop trigger if exists set_cc_company_files_updated_at on public.cc_company_files;
create trigger set_cc_company_files_updated_at
before update on public.cc_company_files
for each row
execute function public.set_ccinfo_updated_at();
