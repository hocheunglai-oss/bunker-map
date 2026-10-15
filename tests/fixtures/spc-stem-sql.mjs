import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { buyerId, supplierId, secondSupplierId, users } from "./spc-stem-api.mjs"
import { literal } from "./native-postgres-ccinfo.mjs"

export const stemMigrationPath = "supabase/migrations/20261014112636_atomic_spc_stem_fixture.sql"
const source = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
export function spcStemFixtureSql() {
  const schema = source("supabase/spc_schema.sql")
  const table = name => {
    const start = schema.indexOf(`create table if not exists public.${name} (`)
    const end = schema.indexOf("\n);", start) + 3
    assert.ok(start >= 0 && end > start)
    return schema.slice(start, end)
  }
  const audit = source("supabase/audit_log.sql")
  const start = audit.indexOf("create table if not exists public.audit_logs (")
  const enable = audit.indexOf("create or replace function public.audit_enable_table(p_table regclass)")
  const end = audit.indexOf("$$;", enable) + 3
  const backup = source("supabase/migrations/20260723101257_add_backup_export_epoch.sql")
  const clockStart = schema.indexOf("create or replace function public.set_spc_updated_at()")
  const clockEnd = schema.indexOf("$$;", clockStart) + 3
  const routing = source("supabase/migrations/20260821080000_route_spc_enquiries_only_when_assigned.sql")
  const transaction = name => {
    const start = routing.indexOf(`create or replace function public.${name}(`)
    const end = routing.indexOf("$$;", start) + 3
    assert.ok(start >= 0 && end > start)
    return `${routing.slice(start, end)}\ngrant execute on function public.${name}(${name.startsWith("amend") ? "uuid,text,text,jsonb,text,jsonb,text" : "uuid,text,text,jsonb,text,jsonb,text,text"}) to service_role;`
  }
  return `set time zone 'UTC';
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to service_role;
    ${audit.slice(start, end)}
    ${backup.slice(0, backup.indexOf("\ndo $$"))}
    create sequence public.spc_enquiry_number_seq;
    ${["spc_delivery_routes", "spc_users", "spc_enquiries", "spc_fixtures", "spc_group_dispatchers", "spc_group_delivery_jobs"].map(table).join("\n")}
    create unique index spc_users_username_lower_key on public.spc_users(lower(username));
    create unique index spc_fixtures_enquiry_id_key on public.spc_fixtures(enquiry_id);
    ${clockStart >= 0 ? schema.slice(clockStart, clockEnd) : ""}
    ${["spc_enquiries", "spc_fixtures"].map(name => `
      alter table public.${name} enable row level security;
      grant select,insert,update,delete on public.${name} to service_role;
      select public.audit_enable_table('public.${name}');
      create trigger set_${name}_updated_at before update on public.${name} for each row execute function public.set_spc_updated_at();
      create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.${name} for each statement execute function private.record_bunker_map_backup_mutation();
    `).join("\n")}
    grant select,insert,update,delete on public.spc_users to service_role;
    insert into public.spc_users(id,username,display_name,role,password_hash) values
      ('${buyerId}',${literal(users[0].username)},${literal(users[0].displayName)},'buyer_trader','synthetic-not-a-credential'),
      ('${supplierId}',${literal(users[1].username)},${literal(users[1].displayName)},'supplier_trader','synthetic-not-a-credential'),
      ('${secondSupplierId}',${literal(users[2].username)},${literal(users[2].displayName)},'supplier_trader','synthetic-not-a-credential');
    ${source(stemMigrationPath)}
    ${source("supabase/migrations/20261015073258_atomic_spc_fixture_edits.sql")}
    ${transaction("amend_spc_enquiry_with_group_delivery")}
    ${transaction("reoffer_spc_enquiry_with_group_delivery")}
  `
}
