import { readFileSync } from "node:fs"
import { fixtureSql as countryFixtureSql } from "./ccinfo-country-rename-sql.mjs"
export { countryId, otherCountryId, thirdCountryId, managedPortId, legacyPortId, foreignPortId, mismatchPortId, initialVersion } from "./ccinfo-country-rename-sql.mjs"
export const companyId = "88888888-8888-4888-8888-888888888888"
export const companyFileId = "99999999-9999-4999-8999-999999999999"
export const deleteMigration = "supabase/migrations/20261016072727_atomic_ccinfo_record_delete.sql"
export function fixtureSql() {
  return `${countryFixtureSql()}
    reset role;
    create table public.cc_company_files(id uuid primary key,company_id uuid not null references public.cc_companies(id) on delete cascade,file_name text not null,original_path text,drive_file_id text,deleted_at timestamptz,updated_at timestamptz not null default now());
    alter table public.cc_company_files enable row level security;
    grant select,insert,update,delete on public.cc_company_files to service_role;
    select public.audit_enable_table('public.cc_company_files');
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.cc_company_files for each statement execute function private.record_bunker_map_backup_mutation();
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.cc_companies for each statement execute function private.record_bunker_map_backup_mutation();
    insert into public.cc_companies(id,name,notes,updated_at) values('${companyId}','SYNTHETIC COMPANY','UNCHANGED COMPANY','2099-10-12T00:00:00.123456Z');
    insert into public.cc_company_files(id,company_id,file_name,original_path,drive_file_id) values('${companyFileId}','${companyId}','SYNTHETIC.txt','UNCHANGED PATH','SYNTHETIC DRIVE REFERENCE');
    insert into public.cc_entry_files(entry_id,file_id) values('${companyId}','POLYMORPHIC FILE LEFT BY EXISTING POLICY');
    insert into public.cc_entry_folders(entry_id,folder_path) values('${companyId}','POLYMORPHIC FOLDER LEFT BY EXISTING POLICY');
    ${readFileSync(new URL(`../../${deleteMigration}`,import.meta.url),'utf8')}
    set role service_role;
    select set_config('request.headers','{"x-bunker-admin-user":"SYNTHETIC DELETE EDITOR","x-bunker-admin-display-name":"Synthetic Delete Editor","x-bunker-admin-page-id":"ccinfo"}',false);
  `
}
export const stateSql = `select jsonb_build_object(
  'countries',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.cc_countries r),
  'ports',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.cc_ports r),
  'companies',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.cc_companies r),
  'companyFiles',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.cc_company_files r),
  'files',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.cc_entry_files r),
  'folders',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.cc_entry_folders r),
  'audit',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.audit_logs r),
  'epochs',(select coalesce(jsonb_agg(to_jsonb(r) order by mutation_id),'[]') from private.bunker_map_backup_mutations r)) as state;`
