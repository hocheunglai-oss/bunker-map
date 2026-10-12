import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

export const countryId = "11111111-1111-4111-8111-111111111111"
export const otherCountryId = "22222222-2222-4222-8222-222222222222"
export const thirdCountryId = "33333333-3333-4333-8333-333333333333"
export const managedPortId = "44444444-4444-4444-8444-444444444444"
export const legacyPortId = "55555555-5555-4555-8555-555555555555"
export const foreignPortId = "66666666-6666-4666-8666-666666666666"
export const mismatchPortId = "77777777-7777-4777-8777-777777777777"
export const initialVersion = "2099-10-12T00:00:00.123456+00:00"
export const renameMigration = "supabase/migrations/20261012111112_atomic_ccinfo_country_rename.sql"
const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")

export function fixtureSql() {
  const audit = source("supabase/audit_log.sql")
  const start = audit.indexOf("create table if not exists public.audit_logs (")
  const enable = audit.indexOf("create or replace function public.audit_enable_table(p_table regclass)")
  const end = audit.indexOf("$$;", enable) + 3
  assert.ok(start >= 0 && enable > start && end > enable)
  const backup = source("supabase/migrations/20260723101257_add_backup_export_epoch.sql")
  const backupEnd = backup.indexOf("\ndo $$")
  assert.ok(backupEnd > 0)
  // Match the hosted credential-safe undo wrapper and its current CAS body,
  // rather than testing only the older standalone audit_log.sql helper.
  const undo = source("supabase/migrations/20260806202000_complete_spc_audit_enforcement.sql")
  const undoStart = undo.indexOf("create or replace function public.audit_undo_context(p_log_id uuid)")
  const undoEnd = undo.indexOf("\ndo $$", undoStart)
  assert.ok(undoStart >= 0 && undoEnd > undoStart)
  return `
    set time zone 'UTC';
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to service_role;
    ${audit.slice(start, end)}
    ${undo.slice(undoStart, undoEnd)}
    create table public.cc_countries(id uuid primary key default gen_random_uuid(),name text not null,region text,summary text,notes text,tags text[],status text,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
    create table public.cc_ports(id uuid primary key default gen_random_uuid(),name text not null,country_id uuid references public.cc_countries(id) on delete set null,country_name text,summary text,notes text,tags text[],status text,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
    create index cc_ports_country_id_idx on public.cc_ports(country_id);
    create table public.cc_companies(id uuid primary key default gen_random_uuid(),name text not null,summary text,notes text,updated_at timestamptz not null default now());
    create table public.cc_entry_files(id uuid primary key default gen_random_uuid(),entry_id uuid,file_id text);
    create table public.cc_entry_folders(id uuid primary key default gen_random_uuid(),entry_id uuid,folder_path text);
    ${["cc_countries", "cc_ports", "cc_companies"].map(table => `
      alter table public.${table} enable row level security;
      grant select,insert,update,delete on public.${table} to service_role;
      select public.audit_enable_table('public.${table}');
    `).join("\n")}
    ${source("supabase/migrations/20261012102317_advance_ccinfo_record_versions.sql")}
    ${backup.slice(0, backupEnd)}
    ${["cc_countries", "cc_ports", "audit_logs"].map(table => `create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.${table} for each statement execute function private.record_bunker_map_backup_mutation();`).join("\n")}
    insert into public.cc_countries(id,name,region,summary,notes,tags,status,created_at,updated_at) values
      ('${countryId}','SYNTHETIC OLD','UNCHANGED REGION','COUNTRY SUMMARY','COUNTRY NOTES',array['COUNTRY TAG'],'active','${initialVersion}','${initialVersion}'),
      ('${otherCountryId}','OTHER COUNTRY',null,null,null,null,'active','${initialVersion}','${initialVersion}'),
      ('${thirdCountryId}','THIRD COUNTRY',null,null,null,null,'active','${initialVersion}','${initialVersion}');
    insert into public.cc_ports(id,name,country_id,country_name,summary,notes,tags,status,created_at,updated_at) values
      ('${managedPortId}','MANAGED PORT','${countryId}','SYNTHETIC OLD','PORT SUMMARY','PORT NOTES',array['PORT TAG'],'active','${initialVersion}','${initialVersion}'),
      ('${legacyPortId}','LEGACY PORT',null,'SYNTHETIC OLD','LEGACY SUMMARY','LEGACY NOTES',null,'active','${initialVersion}','${initialVersion}'),
      ('${foreignPortId}','FOREIGN LINKED PORT','${otherCountryId}','SYNTHETIC OLD','FOREIGN SUMMARY','FOREIGN NOTES',null,'active','${initialVersion}','${initialVersion}'),
      ('${mismatchPortId}','EXISTING MISMATCH','${thirdCountryId}','HISTORICAL ALIAS',null,'DO NOT REWRITE',null,'active','${initialVersion}','${initialVersion}');
    insert into public.cc_entry_files(entry_id,file_id) values('${countryId}','SYNTHETIC DRIVE ID');
    insert into public.cc_entry_folders(entry_id,folder_path) values('${countryId}','UNCHANGED PATH');
    ${source(renameMigration)}
    set role service_role;
    select set_config('request.headers','{"x-bunker-admin-user":"SYNTHETIC EDITOR","x-bunker-admin-page-id":"ccinfo","x-bunker-audit-action":"ordinary_update"}',false);
  `
}
