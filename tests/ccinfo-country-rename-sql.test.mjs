import assert from "node:assert/strict"
import test from "node:test"
import { countryId, otherCountryId, thirdCountryId, managedPortId, legacyPortId, foreignPortId, mismatchPortId, initialVersion, fixtureSql } from "./fixtures/ccinfo-country-rename-sql.mjs"

const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
async function fixture() { const db = new PGlite(); try { await db.exec(fixtureSql()); return db } catch (error) { await db.close(); throw error } }
const rename = (db, name = "SYNTHETIC NEW", version = initialVersion, id = countryId) => db.query("select public.rename_ccinfo_country($1::uuid,$2::timestamptz,$3::text) as record", [id, version, name])
const rows = async db => (await db.query("select jsonb_build_object('countries',(select jsonb_agg(to_jsonb(c) order by id) from public.cc_countries c),'ports',(select jsonb_agg(to_jsonb(p) order by id) from public.cc_ports p),'audit',(select jsonb_agg(to_jsonb(a) order by id) from public.audit_logs a),'backup',(select jsonb_agg(to_jsonb(m) order by mutation_id) from private.bunker_map_backup_mutations m)) as snapshot")).rows[0].snapshot

test("atomic country rename preserves all content, IDs, file links, unrelated linked names and historical aliases", async () => {
  const db = await fixture()
  try {
    await db.exec("reset role")
    const before = await rows(db)
    await db.exec("set role service_role")
    const record = (await rename(db, " côte d'ivoire ")).rows[0].record
    assert.deepEqual(record, { id: countryId, name: "CÔTE D'IVOIRE", updated_at: "2099-10-12T00:00:00.123457+00:00" })
    await db.exec("reset role")
    const after = await rows(db)
    const scrub = row => { const { name, country_name, updated_at, ...rest } = row; return rest }
    assert.deepEqual(after.countries.map(scrub), before.countries.map(scrub))
    assert.deepEqual(after.ports.map(scrub), before.ports.map(scrub))
    for (const portId of [managedPortId, legacyPortId]) {
      const port = after.ports.find(row => row.id === portId)
      assert.equal(port.country_name, record.name)
      assert.equal(port.updated_at, record.updated_at)
    }
    for (const portId of [foreignPortId, mismatchPortId]) assert.deepEqual(after.ports.find(row => row.id === portId), before.ports.find(row => row.id === portId))
    assert.equal((await db.query("select file_id from public.cc_entry_files where entry_id=$1", [countryId])).rows[0].file_id, "SYNTHETIC DRIVE ID")
    assert.equal((await db.query("select folder_path from public.cc_entry_folders where entry_id=$1", [countryId])).rows[0].folder_path, "UNCHANGED PATH")
    assert.equal(after.audit.length - (before.audit?.length || 0), 3)
    assert.ok(after.audit.every(log => log.request_context.action === "ccinfo_country_rename"))
    assert.equal(new Set(after.audit.map(log => log.request_context.correlationId)).size, 1)
    assert.equal(after.backup.length - before.backup.length, 1, "one committed transaction marker, not one per affected port")
    const settings = (await db.query("select public.audit_json_setting('request.headers') as headers, public.audit_json_setting('app.audit_context') as context, public.audit_text_setting('app.ccinfo_country_rename') as flag")).rows[0]
    assert.equal(settings.headers['x-bunker-audit-action'], "ordinary_update")
    assert.deepEqual(settings.context, {})
    assert.equal(settings.flag, null)
  } finally { await db.close() }
})

test("failures at country/first-port/second-port and audit boundaries roll back rows, audit and backup markers", async () => {
  for (const [table, timing, condition] of [["cc_countries", "before", "true"], ["cc_ports", "before", `new.id='${managedPortId}'::uuid`], ["cc_ports", "after", `new.id='${legacyPortId}'::uuid`], ["audit_logs", "before", "true"]]) {
    const db = await fixture()
    try {
      await db.exec("reset role")
      const before = await rows(db)
      await db.exec(`create function public.inject_rename_failure() returns trigger language plpgsql as $$ begin if ${condition} then raise exception 'SYNTHETIC FAILURE'; end if; return new; end; $$;
        create trigger inject_rename_failure ${timing} ${table === 'audit_logs' ? 'insert' : 'update'} on public.${table} for each row execute function public.inject_rename_failure(); set role service_role;`)
      await assert.rejects(rename(db), /SYNTHETIC FAILURE/)
      await db.exec("reset role")
      assert.deepEqual(await rows(db), before, `${table}/${timing} must not leave a partially renamed country`)
    } finally { await db.close() }
  }
})

test("stale/deleted/duplicate/invalid and ambiguous legacy requests fail without any successful rename", async () => {
  const db = await fixture()
  try {
    for (const [name, version, id, pattern] of [["NEW", "2099-10-12T00:00:00.123455Z", countryId, /changed or was removed/], ["NEW", initialVersion, "99999999-9999-4999-8999-999999999999", /changed or was removed/], ["other country", initialVersion, countryId, /already uses/], ["", initialVersion, countryId, /valid country/], ["X".repeat(201), initialVersion, countryId, /valid country/], ["BAD\nNAME", initialVersion, countryId, /valid country/], ["SYNTHETIC OLD", initialVersion, countryId, /different country/]]) {
      await assert.rejects(rename(db, name, version, id), pattern)
    }
    await db.query("insert into public.cc_countries(name) values('SYNTHETIC OLD')")
    await assert.rejects(rename(db), /ambiguous country/)
    assert.equal((await db.query("select name from public.cc_countries where id=$1", [countryId])).rows[0].name, "SYNTHETIC OLD")
    assert.equal((await db.query("select count(*)::int as count from public.audit_logs where request_context->>'action'='ccinfo_country_rename'")).rows[0].count, 0)
  } finally { await db.close() }
})

test("new/reparented linked ports use current country label but content-only saves preserve unrelated historical labels", async () => {
  const db = await fixture()
  try {
    await rename(db)
    const inserted = (await db.query("insert into public.cc_ports(name,country_id,country_name) values('STALE BROWSER PORT',$1,'SYNTHETIC OLD') returning country_name", [countryId])).rows[0]
    assert.equal(inserted.country_name, "SYNTHETIC NEW")
    const moved = (await db.query("update public.cc_ports set country_id=$1,country_name='OLD CACHED COUNTRY' where id=$2 returning country_name", [countryId, foreignPortId])).rows[0]
    assert.equal(moved.country_name, "SYNTHETIC NEW")
    await db.query("update public.cc_ports set notes='NEW NOTES',country_id=$1,country_name='HISTORICAL ALIAS' where id=$2", [thirdCountryId, mismatchPortId])
    assert.equal((await db.query("select country_name from public.cc_ports where id=$1", [mismatchPortId])).rows[0].country_name, "HISTORICAL ALIAS")
    await assert.rejects(db.query("insert into public.cc_ports(name,country_id) values('MISSING COUNTRY','99999999-9999-4999-8999-999999999999')"), /no longer exists/)
    // FK SET NULL during ordinary country deletion is still supported.
    await db.query("delete from public.cc_countries where id=$1", [otherCountryId])
  } finally { await db.close() }
})

test("old direct UPDATE/upsert and partial country/port audit undo cannot bypass atomic rename", async () => {
  const db = await fixture()
  try {
    await assert.rejects(db.query("update public.cc_countries set name='BYPASS' where id=$1", [countryId]), /Use CCINFO Rename/)
    await assert.rejects(db.query("insert into public.cc_countries(id,name) values($1,'UPSERT BYPASS') on conflict(id) do update set name=excluded.name", [countryId]), /Use CCINFO Rename/)
    await rename(db)
    const logs = (await db.query("select id,table_name from public.audit_logs where request_context->>'action'='ccinfo_country_rename'")).rows
    assert.equal(logs.length, 3)
    for (const log of logs) await assert.rejects(db.query("select public.undo_audit_log($1::uuid,'SYNTHETIC UNDO','Synthetic Undo')", [log.id]), /Use CCINFO Rename/)
    await db.query("update public.cc_ports set notes='NORMAL CONTENT SAVE' where id=$1", [managedPortId])
    const normal = (await db.query("select id from public.audit_logs where table_name='cc_ports' and after_row->>'notes'='NORMAL CONTENT SAVE'")).rows[0]
    await db.query("select public.undo_audit_log($1::uuid,'SYNTHETIC UNDO','Synthetic Undo')", [normal.id])
    assert.equal((await db.query("select notes,country_name from public.cc_ports where id=$1", [managedPortId])).rows[0].notes, "PORT NOTES")
  } finally { await db.close() }
})

test("RPC is service-only invoker with empty search_path and refuses unaudited service calls", async () => {
  const db = await fixture()
  try {
    const acl = (await db.query("select prosecdef,proconfig,has_function_privilege('anon',oid,'execute') as anon,has_function_privilege('authenticated',oid,'execute') as authenticated,has_function_privilege('service_role',oid,'execute') as service from pg_proc where proname='rename_ccinfo_country'")).rows[0]
    assert.deepEqual(acl, { prosecdef: false, proconfig: ['search_path=""'], anon: false, authenticated: false, service: true })
    await db.exec("select set_config('request.headers','{}',false)")
    await assert.rejects(rename(db), /audit actor is required/)
    await db.exec("set role anon")
    await assert.rejects(rename(db), /permission denied/)
  } finally { await db.close() }
})
