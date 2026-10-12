// Run with PGLITE_MODULE_PATH pointing to an isolated @electric-sql/pglite install.
// No hosted database, credentials or business data are used.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
const source = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
const migration = "supabase/migrations/20261012102317_advance_ccinfo_record_versions.sql"
const tables = ["cc_companies", "cc_countries", "cc_ports"]
const id = "11111111-1111-4111-8111-111111111111"
const original = "2099-10-12T00:00:00.123456+00:00"

async function fixture() {
  const db = new PGlite()
  const audit = source("supabase/audit_log.sql")
  const start = audit.indexOf("create table if not exists public.audit_logs (")
  const enable = audit.indexOf("create or replace function public.audit_enable_table(p_table regclass)")
  const end = audit.indexOf("$$;", enable) + 3
  assert.ok(start >= 0 && enable > start && end > enable)
  await db.exec(`
    set time zone 'UTC';
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to service_role;
    ${audit.slice(start, end)}
    create function public.set_ccinfo_updated_at() returns trigger language plpgsql as $$begin new.updated_at := now(); return new; end;$$;
    ${tables.map(table => `
      create table public.${table}(id uuid primary key, name text not null, summary text, notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      alter table public.${table} enable row level security;
      grant select,insert,update,delete on public.${table} to service_role;
      create trigger set_${table}_updated_at before update on public.${table} for each row execute function public.set_ccinfo_updated_at();
      select public.audit_enable_table('public.${table}');
    `).join("\n")}
    ${source(migration)}
    set role service_role;
    select set_config('request.headers','{"x-bunker-admin-user":"SYNTHETIC EDITOR","x-bunker-admin-page-id":"ccinfo"}',false);
  `)
  for (const table of tables) await db.query(`insert into public.${table}(id,name,summary,notes,created_at,updated_at) values($1,'SYNTHETIC','ORIGINAL SUMMARY','ORIGINAL NOTES',$2::timestamptz,$2::timestamptz)`, [id, original])
  return db
}

test("all three actual CCINFO UPDATE-only triggers preserve restore inserts and serialize same-token writes", async () => {
  const db = await fixture()
  try {
    await db.exec("begin")
    for (const table of tables) {
      assert.equal((await db.query(`select to_jsonb(item)->>'updated_at' as version from public.${table} item`)).rows[0].version, original)
      const first = await db.query(`update public.${table} set summary='FIRST WINNER' where id=$1 and updated_at=$2::timestamptz returning to_jsonb(${table})->>'updated_at' as version`, [id, original])
      const stale = await db.query(`update public.${table} set summary='STALE LOSER' where id=$1 and updated_at=$2::timestamptz returning id`, [id, original])
      assert.equal(first.rows[0].version, "2099-10-12T00:00:00.123457+00:00")
      assert.equal(stale.rows.length, 0)
      const next = await db.query(`update public.${table} set notes='QUEUED NEXT' where id=$1 and updated_at=$2::timestamptz returning to_jsonb(${table})->>'updated_at' as version`, [id, first.rows[0].version])
      assert.equal(next.rows[0].version, "2099-10-12T00:00:00.123458+00:00", "same-transaction versions cannot reuse now()")
      const row = (await db.query(`select summary,notes from public.${table}`)).rows[0]
      assert.deepEqual(row, { summary: "FIRST WINNER", notes: "QUEUED NEXT" })
    }
    await db.exec("commit")
  } finally { await db.close() }
})

test("actual audit undo advances each version instead of resurrecting a stale editing token", async () => {
  const db = await fixture()
  try {
    for (const table of tables) {
      await db.query(`update public.${table} set summary='CHANGED SUMMARY' where id=$1`, [id])
      const log = (await db.query("select id from public.audit_logs where table_name=$1 and operation='UPDATE' order by occurred_at desc limit 1", [table])).rows[0]
      assert.ok(log)
      await db.query("select public.undo_audit_log($1::uuid,'SYNTHETIC UNDO','Synthetic Undo')", [log.id])
      const row = (await db.query(`select to_jsonb(item) as row from public.${table} item`)).rows[0].row
      assert.equal(row.summary, "ORIGINAL SUMMARY")
      assert.equal(row.updated_at, "2099-10-12T00:00:00.123458+00:00")
      const audit = (await db.query("select after_row->>'updated_at' as version from public.audit_logs where undo_of_log_id=$1::uuid", [log.id])).rows[0]
      assert.equal(audit.version, row.updated_at)
      const stale = await db.query(`update public.${table} set notes='STALE' where id=$1 and updated_at=$2::timestamptz returning id`, [id, original])
      assert.equal(stale.rows.length, 0)
    }
  } finally { await db.close() }
})

test("new trigger is invoker-only, not publicly executable, and does not change other CCINFO trigger targets", async () => {
  const db = await fixture()
  try {
    const acl = (await db.query("select prosecdef,has_function_privilege('anon',oid,'execute') as anon,has_function_privilege('authenticated',oid,'execute') as authenticated from pg_proc where proname='advance_ccinfo_record_version'")).rows[0]
    assert.deepEqual(acl, { prosecdef: false, anon: false, authenticated: false })
    const triggers = (await db.query("select tgrelid::regclass::text as table from pg_trigger where tgfoid='public.advance_ccinfo_record_version()'::regprocedure order by 1")).rows.map(row => row.table)
    assert.deepEqual(triggers, [...tables].sort())
    const legacy = (await db.query("select pg_get_functiondef('public.set_ccinfo_updated_at()'::regprocedure) as body")).rows[0].body
    assert.match(legacy, /new.updated_at := now\(\)/)
    await db.exec("set role anon")
    await assert.rejects(db.query("select public.advance_ccinfo_record_version()"), /permission denied/)
  } finally { await db.close() }
})
