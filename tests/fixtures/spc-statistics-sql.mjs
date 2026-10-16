import { readFileSync } from "node:fs"

export const statisticsMigrationPath = "supabase/migrations/20261016050243_snapshot_consistent_spc_statistics.sql"
export const statisticsBounds = { firstFixtureYear: 2025, lastFixtureYear: 2026, windowStart: "2026-07-18T16:00:00.000Z", windowEnd: "2026-10-16T15:59:59.000Z" }
export const statisticsCall = "public.read_spc_statistics_source(2025,2026,'2026-07-18T16:00:00Z','2026-10-16T15:59:59Z')"
export function statisticsFixtureSql() {
  return `set time zone 'UTC';
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to service_role;
    create table public.spc_users(id uuid primary key,username text not null,display_name text,role text not null,is_active boolean not null,password_hash text);
    create table public.spc_enquiries(id uuid primary key,enquiry_number text not null,title text not null,created_by_username text not null,created_by_display_name text not null,created_at timestamptz not null,notes text);
    create table public.spc_fixtures(id uuid primary key,enquiry_id uuid not null references public.spc_enquiries(id),fixture_status text not null,fixture_date date,
      supplier_trader_username text not null,supplier_trader_display_name text not null,buyer_trader_username text not null,buyer_trader_display_name text not null,
      account text,vessel_name text,hsfo text,vlsfo text,lsmgo text,supplier_name text,supplier_key text,created_at timestamptz not null,price text);
    create table public.audit_logs(id uuid primary key,actor_id text,table_schema text not null,table_name text not null,operation text not null,after_row jsonb,request_context jsonb not null);
    create table public.office_calendar_store(key text primary key,payload jsonb not null);
    ${["spc_users", "spc_enquiries", "spc_fixtures", "audit_logs", "office_calendar_store"].map(table => `alter table public.${table} enable row level security; grant select on public.${table} to service_role;`).join("\n")}
    insert into public.spc_users values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','buyer@example.test','Synthetic Buyer','buyer_trader',true,'DO-NOT-EXPORT-PASSWORD'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','supplier@example.test','Synthetic Supplier','supplier_trader',true,'DO-NOT-EXPORT-PASSWORD');
    insert into public.office_calendar_store values('spc-permission-groups','{"groups":[{"permissions":"DO-NOT-EXPORT-PERMISSIONS"}],"userRoles":[],"userProfiles":[{"userId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","username":"buyer@example.test","office":"HONG KONG","mustChangePassword":true,"isSupplierTrader":true}],"unrelated":"DO-NOT-EXPORT-IDENTITY"}');
    ${readFileSync(new URL(`../../${statisticsMigrationPath}`, import.meta.url), "utf8")}`
}
export const seedStatisticsSql = (count = 1) => `
  insert into public.spc_enquiries select md5('enquiry-'||n)::uuid,'SPC-SYNTHETIC-'||n,'Synthetic Vessel','buyer@example.test','Synthetic Buyer','2026-10-16T04:50:00Z','DO-NOT-EXPORT-NOTES' from generate_series(1,${count}) n;
  insert into public.spc_fixtures select md5('fixture-'||n)::uuid,md5('enquiry-'||n)::uuid,'completed','2026-10-16','supplier@example.test','Synthetic Supplier','buyer@example.test','Synthetic Buyer','HONG KONG','Synthetic Vessel','100',null,null,'SYNTHETIC SUPPLIER','SYNTHETICSUPPLIER','2026-10-16T04:50:00Z','DO-NOT-EXPORT-PRICE' from generate_series(1,${count}) n;
  insert into public.audit_logs select md5('audit-'||n)::uuid,'spc:buyer@example.test','public','spc_enquiries','INSERT',jsonb_build_object('enquiry_number','SPC-SYNTHETIC-'||n,'private','DO-NOT-EXPORT-AUDIT'),'{"pageId":"spc-buyer-enquiries","private":"DO-NOT-EXPORT-CONTEXT"}' from generate_series(1,${count}) n;`
export const statisticsStateSql = `select jsonb_object_agg(name,value) as state from (
  ${["spc_users", "spc_enquiries", "spc_fixtures", "audit_logs", "office_calendar_store"].map(table => `select '${table}' as name,md5(coalesce(string_agg(to_jsonb(t)::text||t.ctid::text,'' order by to_jsonb(t)::text),'')) as value from public.${table} t`).join(" union all ")}
) snapshots;`
