import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
export const migrationPath = "supabase/migrations/20261014102506_atomic_phonebook_company_save.sql"
export const companyId = "11111111-1111-4111-8111-111111111111"
export const otherId = "22222222-2222-4222-8222-222222222222"
export const contactId = n => `33333333-3333-4333-8333-${String(n).padStart(12,"0")}`
export const initialVersion = "2026-10-14T00:00:00.123456+00:00"
export const companyFields = ["name","other_name","phone","address","country","tel_country","tel_area","tel_no_1","tel_no_2","tel_speed_dial","fax_no_1","website","email","contact_type","stem_management","company_status","company_info","seller_term","seller_credit_limit","seller_credit_limit_flexibility","seller_classification","seller_remark_1","seller_remark_2","seller_remark_3","seller_remark_4","buyer_term","buyer_credit_limit","buyer_credit_limit_flexibility","buyer_classification","buyer_remark_1","buyer_remark_2","buyer_remark_3","buyer_remark_4","notes"]
const contactFields = ["full_name","company","mobile_phone","pager","business_phone","business_phone_2","other_phone","email_1","email_2","notes","search_text","company_source_id","title","name_remark","position","department","tel_ext","direct_line","mobile_area","mobile_1","mobile_2","personal_email","general_email","private_email","instant_messaging","others","area_of_responsibility"]

export function phonebookSql() {
  const audit = source("supabase/audit_log.sql")
  const start = audit.indexOf("create table if not exists public.audit_logs (")
  const enable = audit.indexOf("create or replace function public.audit_enable_table(p_table regclass)")
  const end = audit.indexOf("$$;",enable)+3
  assert.ok(start>=0 && end>enable)
  const backup=source("supabase/migrations/20260723101257_add_backup_export_epoch.sql")
  return `
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to service_role;
    ${audit.slice(start,end)}
    create table public.phonebook_companies(id uuid primary key default gen_random_uuid(),source_key text not null unique,
      created_at timestamptz not null default now(),updated_at timestamptz not null default now(),${companyFields.map(f=>`${f} text${f==="name"?" not null":""}`).join(",")});
    create table public.phonebook_contacts(id uuid primary key default gen_random_uuid(),source_key text not null unique,
      favorite boolean not null default false,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),${contactFields.map(f=>`${f} text${f==="full_name"?" not null":""}`).join(",")});
    create function public.set_ccinfo_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
    create trigger set_phonebook_companies_updated_at before update on public.phonebook_companies for each row execute function public.set_ccinfo_updated_at();
    create trigger set_phonebook_contacts_updated_at before update on public.phonebook_contacts for each row execute function public.set_ccinfo_updated_at();
    ${backup.slice(0,backup.indexOf("\ndo $$"))}
    ${["phonebook_companies","phonebook_contacts"].map(t=>`alter table public.${t} enable row level security;
      grant select,insert,update,delete on public.${t} to service_role;
      select public.audit_enable_table('public.${t}');
      create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.${t} for each statement execute function private.record_bunker_map_backup_mutation();`).join("\n")}
    ${source("supabase/migrations/20260930074908_phonebook_carddav_authoritative_reconciliation.sql")}
    insert into public.phonebook_companies(id,name,source_key,phone,tel_country,tel_no_1,notes,updated_at) values
      ('${companyId}','OLD COMPANY','stable-company-key','12345678','852','12345678','UNCHANGED COMPANY NOTE','${initialVersion}'),
      ('${otherId}','OTHER COMPANY','other-company-key','87654321','852','87654321','OTHER NOTE','${initialVersion}');
    insert into public.phonebook_contacts(id,full_name,company,company_source_id,source_key,mobile_1,notes,search_text) values
      ('${contactId(1)}','STABLE CONTACT','OLD COMPANY','stable-company-key','contact-1','+85290000001','KEEP NOTE','stable old company'),
      ('${contactId(2)}','LEGACY CONTACT',' old company ','legacy-original-id','contact-2','+85290000002','KEEP LEGACY','legacy old company'),
      ('${contactId(3)}','LINKED ALIAS','OLD ALIAS','stable-company-key','contact-3','+85290000003','KEEP ALIAS','linked old alias'),
      ('${contactId(4)}','OTHER CONTACT','OTHER COMPANY','other-company-key','contact-4','+85290000004','KEEP OTHER','other company');
    truncate public.phonebook_carddav_queue,public.audit_logs,private.bunker_map_backup_mutations;
    ${source(migrationPath)}
    set role service_role;
    select set_config('request.headers','{"x-bunker-admin-user":"SYNTHETIC EDITOR","x-bunker-admin-page-id":"phonebook"}',false);
  `
}
