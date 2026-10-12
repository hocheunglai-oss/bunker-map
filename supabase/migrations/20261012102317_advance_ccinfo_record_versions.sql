-- Only CCINFO entry versions change here. File/folder/phonebook timestamp
-- behavior remains untouched, and restored INSERT timestamps are preserved.
create or replace function public.advance_ccinfo_record_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := greatest(pg_catalog.clock_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$;

revoke all on function public.advance_ccinfo_record_version() from public, anon, authenticated;

drop trigger if exists set_cc_companies_updated_at on public.cc_companies;
create trigger set_cc_companies_updated_at before update on public.cc_companies
for each row execute function public.advance_ccinfo_record_version();

drop trigger if exists set_cc_countries_updated_at on public.cc_countries;
create trigger set_cc_countries_updated_at before update on public.cc_countries
for each row execute function public.advance_ccinfo_record_version();

drop trigger if exists set_cc_ports_updated_at on public.cc_ports;
create trigger set_cc_ports_updated_at before update on public.cc_ports
for each row execute function public.advance_ccinfo_record_version();
