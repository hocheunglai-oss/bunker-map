import { readFileSync } from "node:fs"
export const recordPagesMigration = "supabase/migrations/20261016125653_complete_spc_record_pages.sql"
export function recordPagesFixtureSql({ includeBusinessConflictFix = true } = {}) {
 const baseline=readFileSync(new URL("../../supabase/spc_schema.sql",import.meta.url),"utf8")
 const writer=baseline.match(/create or replace function public\.set_spc_updated_at\(\)[\s\S]*?\n\$\$;/)?.[0]
 if(!writer)throw Error("Canonical writer trigger source unavailable")
 const audit=readFileSync(new URL("../../supabase/audit_log.sql",import.meta.url),"utf8")
 const auditStart=audit.indexOf("create table if not exists public.audit_logs (")
 const auditEnd=audit.indexOf("$$;",audit.indexOf("create or replace function public.audit_enable_table(p_table regclass)"))+3
 const backup=readFileSync(new URL("../../supabase/migrations/20260723101257_add_backup_export_epoch.sql",import.meta.url),"utf8")
 return `create role anon;create role authenticated;create role service_role bypassrls;
 ${audit.slice(auditStart,auditEnd)}
 ${backup.slice(0,backup.indexOf("\ndo $$"))}
 grant usage on schema private,public to service_role;
 create table public.spc_enquiries(id uuid primary key,enquiry_number text not null,title text not null,vessel_name text,port text,product text,quantity text,delivery_date date,supplier_name text,status text not null,notes text,created_by_username text not null,created_by_display_name text not null,created_at timestamptz not null,updated_at timestamptz not null);
 create table public.spc_fixtures(id uuid primary key,enquiry_id uuid not null references public.spc_enquiries(id),fixture_status text not null,fixture_date date,supplier_trader_display_name text not null,buyer_trader_display_name text not null,vessel_name text,vessel_imo text check(vessel_imo is null or vessel_imo~'^[0-9]{7}$'),supplier_name text,price text,barging text,completed_at timestamptz,created_at timestamptz not null);
 create unique index spc_fixtures_enquiry_id_key on public.spc_fixtures(enquiry_id);
 create index spc_fixtures_vessel_imo_idx on public.spc_fixtures(vessel_imo) where vessel_imo is not null;
 alter table public.spc_enquiries enable row level security;alter table public.spc_fixtures enable row level security;
 grant select on public.spc_enquiries,public.spc_fixtures to service_role;
 ${writer}
 create trigger set_spc_enquiries_updated_at before update on public.spc_enquiries for each row execute function public.set_spc_updated_at();
 ${["spc_enquiries","spc_fixtures"].map(name=>`select public.audit_enable_table('public.${name}');
 create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.${name} for each statement execute function private.record_bunker_map_backup_mutation();`).join("\n")}
 begin;${readFileSync(new URL("../../"+recordPagesMigration,import.meta.url),"utf8")}commit;
 ${includeBusinessConflictFix ? "begin;" + readFileSync(new URL("../../supabase/migrations/20261022094634_stop_spc_record_page_business_conflict_retries.sql", import.meta.url), "utf8") + "commit;" : ""}`
}
export function seedRecordPagesSql(count=251,status="cancelled") {
 return `insert into public.spc_enquiries select md5('record-'||n)::uuid,'SYNTHETIC-'||n,'SYNTHETIC VESSEL '||n,'SYNTHETIC VESSEL '||n,'SINGAPORE','VLSFO','500',null,null,'${status}',
 'Synthetic notes'||chr(10)||'---SPC_META---'||chr(10)||json_build_object('imo',to_char(1000000+n,'FM0000000'))::text,'synthetic@example.test','Synthetic Trader',
 (statement_timestamp() at time zone 'Asia/Hong_Kong')::date::timestamp at time zone 'Asia/Hong_Kong'+interval '1 hour'+n*interval '1 millisecond',statement_timestamp() from generate_series(1,${count})n;`
}
export const recordPagesStateSql=`select jsonb_build_object('enquiries',(select md5(coalesce(string_agg(to_jsonb(e)::text||e.ctid::text,'' order by e.id),'')) from public.spc_enquiries e),'fixtures',(select md5(coalesce(string_agg(to_jsonb(f)::text||f.ctid::text,'' order by f.id),'')) from public.spc_fixtures f),'audit',(select md5(coalesce(string_agg(to_jsonb(a)::text||a.ctid::text,'' order by a.id),'')) from public.audit_logs a),'epochs',(select md5(coalesce(string_agg(to_jsonb(m)::text||m.ctid::text,'' order by m.mutation_id),'')) from private.bunker_map_backup_mutations m));`
