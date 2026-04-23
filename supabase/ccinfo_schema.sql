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

create table if not exists public.cc_entry_files (
  id uuid primary key default gen_random_uuid(),
  entry_kind text not null,
  entry_id uuid not null,
  folder_path text default '',
  file_name text not null,
  file_type text,
  drive_file_id text,
  drive_url text,
  original_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cc_entry_files
add column if not exists folder_path text default '';

create unique index if not exists cc_company_files_company_path_key
on public.cc_company_files(company_id, original_path);

create unique index if not exists cc_entry_files_entry_path_key
on public.cc_entry_files(entry_kind, entry_id, original_path);

create table if not exists public.cc_entry_folders (
  id uuid primary key default gen_random_uuid(),
  entry_kind text not null,
  entry_id uuid not null,
  folder_path text not null default '',
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists cc_entry_folders_entry_path_key
on public.cc_entry_folders(entry_kind, entry_id, folder_path, name);

create table if not exists public.phonebook_contacts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  company text,
  company_source_id text,
  title text,
  name_remark text,
  position text,
  department text,
  tel_ext text,
  direct_line text,
  mobile_area text,
  mobile_1 text,
  mobile_2 text,
  personal_email text,
  general_email text,
  private_email text,
  instant_messaging text,
  others text,
  area_of_responsibility text,
  mobile_phone text,
  pager text,
  business_phone text,
  business_phone_2 text,
  other_phone text,
  email_1 text,
  email_2 text,
  notes text,
  favorite boolean not null default false,
  source_key text not null,
  search_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.phonebook_contacts add column if not exists company_source_id text;
alter table public.phonebook_contacts add column if not exists title text;
alter table public.phonebook_contacts add column if not exists name_remark text;
alter table public.phonebook_contacts add column if not exists position text;
alter table public.phonebook_contacts add column if not exists department text;
alter table public.phonebook_contacts add column if not exists tel_ext text;
alter table public.phonebook_contacts add column if not exists direct_line text;
alter table public.phonebook_contacts add column if not exists mobile_area text;
alter table public.phonebook_contacts add column if not exists mobile_1 text;
alter table public.phonebook_contacts add column if not exists mobile_2 text;
alter table public.phonebook_contacts add column if not exists personal_email text;
alter table public.phonebook_contacts add column if not exists general_email text;
alter table public.phonebook_contacts add column if not exists private_email text;
alter table public.phonebook_contacts add column if not exists instant_messaging text;
alter table public.phonebook_contacts add column if not exists others text;
alter table public.phonebook_contacts add column if not exists area_of_responsibility text;

create unique index if not exists phonebook_contacts_source_key_key
on public.phonebook_contacts(source_key);

create table if not exists public.phonebook_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  other_name text,
  phone text,
  address text,
  country text,
  tel_country text,
  tel_area text,
  tel_no_1 text,
  tel_no_2 text,
  tel_speed_dial text,
  fax_no_1 text,
  website text,
  email text,
  contact_type text,
  stem_management text,
  company_status text,
  company_info text,
  seller_term text,
  seller_credit_limit text,
  seller_credit_limit_flexibility text,
  seller_classification text,
  seller_remark_1 text,
  seller_remark_2 text,
  seller_remark_3 text,
  seller_remark_4 text,
  buyer_term text,
  buyer_credit_limit text,
  buyer_credit_limit_flexibility text,
  buyer_classification text,
  buyer_remark_1 text,
  buyer_remark_2 text,
  buyer_remark_3 text,
  buyer_remark_4 text,
  notes text,
  source_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.phonebook_companies add column if not exists other_name text;
alter table public.phonebook_companies add column if not exists country text;
alter table public.phonebook_companies add column if not exists tel_country text;
alter table public.phonebook_companies add column if not exists tel_area text;
alter table public.phonebook_companies add column if not exists tel_no_1 text;
alter table public.phonebook_companies add column if not exists tel_no_2 text;
alter table public.phonebook_companies add column if not exists tel_speed_dial text;
alter table public.phonebook_companies add column if not exists fax_no_1 text;
alter table public.phonebook_companies add column if not exists website text;
alter table public.phonebook_companies add column if not exists contact_type text;
alter table public.phonebook_companies add column if not exists stem_management text;
alter table public.phonebook_companies add column if not exists company_status text;
alter table public.phonebook_companies add column if not exists company_info text;
alter table public.phonebook_companies add column if not exists seller_term text;
alter table public.phonebook_companies add column if not exists seller_credit_limit text;
alter table public.phonebook_companies add column if not exists seller_credit_limit_flexibility text;
alter table public.phonebook_companies add column if not exists seller_classification text;
alter table public.phonebook_companies add column if not exists seller_remark_1 text;
alter table public.phonebook_companies add column if not exists seller_remark_2 text;
alter table public.phonebook_companies add column if not exists seller_remark_3 text;
alter table public.phonebook_companies add column if not exists seller_remark_4 text;
alter table public.phonebook_companies add column if not exists buyer_term text;
alter table public.phonebook_companies add column if not exists buyer_credit_limit text;
alter table public.phonebook_companies add column if not exists buyer_credit_limit_flexibility text;
alter table public.phonebook_companies add column if not exists buyer_classification text;
alter table public.phonebook_companies add column if not exists buyer_remark_1 text;
alter table public.phonebook_companies add column if not exists buyer_remark_2 text;
alter table public.phonebook_companies add column if not exists buyer_remark_3 text;
alter table public.phonebook_companies add column if not exists buyer_remark_4 text;

create unique index if not exists phonebook_companies_source_key_key
on public.phonebook_companies(source_key);

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

drop trigger if exists set_cc_entry_files_updated_at on public.cc_entry_files;
create trigger set_cc_entry_files_updated_at
before update on public.cc_entry_files
for each row
execute function public.set_ccinfo_updated_at();

drop trigger if exists set_cc_entry_folders_updated_at on public.cc_entry_folders;
create trigger set_cc_entry_folders_updated_at
before update on public.cc_entry_folders
for each row
execute function public.set_ccinfo_updated_at();

drop trigger if exists set_phonebook_contacts_updated_at on public.phonebook_contacts;
create trigger set_phonebook_contacts_updated_at
before update on public.phonebook_contacts
for each row
execute function public.set_ccinfo_updated_at();

drop trigger if exists set_phonebook_companies_updated_at on public.phonebook_companies;
create trigger set_phonebook_companies_updated_at
before update on public.phonebook_companies
for each row
execute function public.set_ccinfo_updated_at();
