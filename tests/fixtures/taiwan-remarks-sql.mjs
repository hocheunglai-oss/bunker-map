import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
export const taiwanRemarksMigration = readFileSync(new URL("../../supabase/migrations/20261016033635_atomic_taiwan_remarks_save.sql", import.meta.url), "utf8")
export const change = (id = 2, content = "NEW\nNOTICE", old = "OLD", exists = true) => ({ id, expected: { id, exists, content: old }, content })
export async function setupTaiwanRemarks() {
  const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
  const db = new PGlite()
  const audit = readFileSync(new URL("../../supabase/audit_log.sql", import.meta.url), "utf8")
  const start = audit.indexOf("create table if not exists public.audit_logs (")
  const enable = audit.indexOf("create or replace function public.audit_enable_table(p_table regclass)")
  const end = audit.indexOf("$$;", enable) + 3
  assert.ok(start >= 0 && enable > start && end > enable)
  const epoch = readFileSync(new URL("../../supabase/migrations/20260723101257_add_backup_export_epoch.sql", import.meta.url), "utf8").split("\ndo $$")[0]
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table public.remarks(id integer primary key,content text);
    create table public.office_calendar_store(key text primary key,payload jsonb);
    grant usage on schema public to service_role;
    grant select,insert,update,delete on public.remarks to service_role;
    alter table public.remarks enable row level security;
    insert into remarks values(1,'OLD'),(2,'OLD'),(101,'UNCHANGED PUBLICATION');
    ${audit.slice(start,end)} ${epoch} ${taiwanRemarksMigration}
    select public.audit_enable_table('public.remarks'::regclass);
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.remarks for each statement execute function private.record_bunker_map_backup_mutation();
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.audit_logs for each statement execute function private.record_bunker_map_backup_mutation();
    set role service_role;select set_config('request.headers','{"x-bunker-admin-user":"SYNTHETIC EDITOR","x-bunker-admin-page-id":"taiwan-remarks"}',false);`)
  const call = async changes => (await db.query("select public.save_taiwan_remarks($1::jsonb) result", [JSON.stringify(changes)])).rows[0].result
  const state = async () => (await db.query(`select
    (select jsonb_agg(to_jsonb(t) order by id) from public.remarks t) as remarks,
    (select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t) as audit,
    public.get_bunker_map_backup_export_fence() as fence`)).rows[0]
  return { db, call, state }
}
