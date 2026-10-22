import { readFileSync } from "node:fs"
import { setupNativeCcinfo, literal } from "./native-postgres-ccinfo.mjs"
import { phonebookSql, companyId, initialVersion } from "./phonebook-company-save-sql.mjs"
export { literal, companyId, initialVersion }
export const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
export const migrationPath = "supabase/migrations/20261022104741_nonretryable_phonebook_taiwan_save_conflicts.sql"
export const json = value => `${literal(JSON.stringify(value))}::jsonb`
export const change = (id = 2, content = "NEW NOTICE", old = "OLD", exists = true) => ({ id, expected: { id, exists, content: old }, content })
export const companySql = (version = initialVersion, name = "RENAMED COMPANY", id = companyId) => `select public.save_phonebook_company(${literal(id)}::uuid,${literal(version)}::timestamptz,${json({ name })});`
export const remarksSql = changes => `select public.save_taiwan_remarks(${json(changes)});`
export const signatures = ["public.save_phonebook_company(uuid,timestamptz,jsonb)", "public.save_taiwan_remarks(jsonb)"]

export async function setupSaveConflicts({ repaired = process.env.SAVE_CONFLICT_TEST_BASELINE !== "1" } = {}) {
  const f = await setupNativeCcinfo(`${phonebookSql()}
    reset role;
    create table public.remarks(id integer primary key,content text);
    create table public.ports(id integer primary key,hsfo numeric,vlsfo numeric,mgo numeric,updated_at date);
    create table public.price_history(id integer primary key,recorded_at date,hsfo numeric);
    create table public.office_calendar_store(key text primary key,payload jsonb);
    alter table public.remarks enable row level security;
    grant select,insert,update,delete on public.remarks to service_role;
    select set_config('request.headers','{}',false);
    insert into public.remarks values(1,'OLD'),(2,'OLD'),(101,'UNCHANGED PUBLISHED REMARK');
    insert into public.ports values(1,600,800,1000,'2026-10-08');
    insert into public.price_history values(1,'2026-10-08',600);
    insert into public.office_calendar_store values('published-taiwan','{"reportDate":"2026-10-08","remark":"UNCHANGED PUBLISHED REMARK"}');
    ${source("supabase/migrations/20261016033635_atomic_taiwan_remarks_save.sql")}
    select public.audit_enable_table('public.remarks');
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.remarks for each statement execute function private.record_bunker_map_backup_mutation();
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.audit_logs for each statement execute function private.record_bunker_map_backup_mutation();
  `)
  try {
    const oids = signatures.map(sig => `${literal(sig)}::regprocedure::oid`).join(",")
    f.identities = () => f.owner.one(`select jsonb_agg(jsonb_build_object('oid',p.oid,'name',p.oid::regprocedure::text,'owner',pg_get_userbyid(proowner),'invoker',not prosecdef,'config',proconfig,'volatility',provolatile,'parallel',proparallel,'acl',proacl::text,'anon',has_function_privilege('anon',p.oid,'execute'),'authenticated',has_function_privilege('authenticated',p.oid,'execute'),'service',has_function_privilege('service_role',p.oid,'execute')) order by p.oid) from pg_proc p where oid=any(array[${oids}]);`)
    f.bodies = () => f.owner.one(`select jsonb_object_agg(proname,prosrc) from pg_proc where oid=any(array[${oids}]);`)
    f.beforeIdentities = await f.identities()
    f.beforeBodies = await f.bodies()
    if (repaired) await f.owner.query(`begin; ${source(migrationPath)} commit;`)
    f.snapshot = () => f.owner.one(`select jsonb_build_object(
      'companies',(select jsonb_agg(to_jsonb(t) order by id) from public.phonebook_companies t),
      'contacts',(select jsonb_agg(to_jsonb(t) order by id) from public.phonebook_contacts t),
      'queue',(select coalesce(jsonb_agg(to_jsonb(t) order by contact_id),'[]') from public.phonebook_carddav_queue t),
      'remarks',(select jsonb_agg(to_jsonb(t) order by id) from public.remarks t),
      'ports',(select jsonb_agg(to_jsonb(t) order by id) from public.ports t),
      'history',(select jsonb_agg(to_jsonb(t) order by id) from public.price_history t),
      'publications',(select jsonb_agg(to_jsonb(t) order by key) from public.office_calendar_store t),
      'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t),
      'fence',public.get_bunker_map_backup_export_fence());`)
    f.execute = async sql => {
      const session = await f.session("save-conflict")
      try { await session.begin("SYNTHETIC EDITOR"); const result = await session.one(sql); await session.query("commit;"); return result }
      finally { await session.close() }
    }
    return f
  } catch (error) { await f.close(); throw error }
}
