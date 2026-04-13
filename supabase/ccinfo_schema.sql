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

drop trigger if exists set_cc_documents_updated_at on public.cc_documents;
create trigger set_cc_documents_updated_at
before update on public.cc_documents
for each row
execute function public.set_ccinfo_updated_at();
