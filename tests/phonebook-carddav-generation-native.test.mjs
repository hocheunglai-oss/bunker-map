import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { setupNativeCcinfo, literal, waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const migration = source("supabase/migrations/20261103092756_retire_legacy_phonebook_carddav_writer.sql")
const initial = `create role anon; create role authenticated; create role service_role bypassrls;
  grant usage on schema public to service_role;
  create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text);
  ${source("supabase/migrations/20260723080340_backup_reliability_guards.sql")}`
const first = "00000000-0000-4000-8000-000000000001", second = "00000000-0000-4000-8000-000000000002"
const legacy = "phonebook-carddav-writes", current = "phonebook-carddav-writes-hetzner-v1"
const claim = (name, owner = first, seconds = 360) => `select to_jsonb(public.claim_bunker_map_backup_lock(${literal(name)},'${owner}',${seconds}));`
const release = (name, owner = first) => `select to_jsonb(public.release_bunker_map_backup_lock(${literal(name)},'${owner}'));`

test("native retirement rejects existing owners, expired and absent legacy leases; owner release remains valid", async () => {
  const db = await setupNativeCcinfo(initial)
  try {
    const writer = await db.session("legacy-holder")
    assert.equal(await writer.one(claim(legacy, first, 3600)), true)
    await db.owner.query(migration)
    for (const owner of [first, second]) {
      const denied = await db.session(`retired-${owner}`)
      await assert.rejects(denied.one(claim(legacy, owner)), { code: "55000", message: /writer generation has been retired/ })
    }
    await db.owner.query(`update public.bunker_map_backup_lock set acquired_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' where lock_name=${literal(legacy)};`)
    const expired = await db.session("retired-expired")
    await assert.rejects(expired.one(claim(legacy)), { code: "55000" })
    assert.equal(await writer.one(release(legacy, second)), false)
    assert.equal(await writer.one(release(legacy)), true)
    const absent = await db.session("retired-absent")
    await assert.rejects(absent.one(claim(legacy)), { code: "55000" })
    assert.equal(await db.owner.one("select count(*)::integer from public.bunker_map_backup_lock;"), 0)
  } finally { await db.close() }
})

test("native new-generation claims serialize across backends and preserve renewal and owner-only release", async () => {
  const db = await setupNativeCcinfo(initial + migration)
  try {
    const one = await db.session("generation-one"), two = await db.session("generation-two")
    await one.begin(); assert.equal(await one.one(claim(current)), true)
    await two.begin()
    const pending = two.one(claim(current, second)); pending.catch(() => undefined)
    await waitForBlock(db.owner, two, one)
    await one.query("commit;")
    assert.equal(await pending, false); await two.query("commit;")
    assert.equal(await two.one(release(current, second)), false)
    assert.equal(await one.one(claim(current)), true)
    assert.equal(await two.one(claim(current, second)), false)
    assert.equal(await one.one(release(current)), true)
    assert.equal(await two.one(claim(current, second)), true)
  } finally { await db.close() }
})

test("native backup lock expiry, argument validation and restricted privileges are unchanged", async () => {
  const db = await setupNativeCcinfo(initial + migration)
  try {
    const writer = await db.session("backup-writer"), name = "daily-backup"
    assert.equal(await writer.one(claim(name)), true)
    assert.equal(await writer.one(claim(name, second)), false)
    await db.owner.query(`update public.bunker_map_backup_lock set acquired_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' where lock_name=${literal(name)};`)
    assert.equal(await writer.one(claim(name, second)), true)
    assert.equal(await writer.one(release(name)), false)
    assert.equal(await writer.one(release(name, second)), true)
    const invalid = await db.session("backup-invalid")
    await assert.rejects(invalid.one(claim(name, first, 59)), /lease from 60 to 3600 seconds/)
    const privileges = await db.owner.one(`select jsonb_build_object(
      'anon',has_function_privilege('anon','public.claim_bunker_map_backup_lock(text,uuid,integer)','execute'),
      'authenticated',has_function_privilege('authenticated','public.claim_bunker_map_backup_lock(text,uuid,integer)','execute'),
      'service',has_function_privilege('service_role','public.claim_bunker_map_backup_lock(text,uuid,integer)','execute'),
      'directTable',has_table_privilege('service_role','public.bunker_map_backup_lock','insert'),
      'rls',(select relrowsecurity from pg_class where oid='public.bunker_map_backup_lock'::regclass),
      'definer',(select prosecdef from pg_proc where oid='public.claim_bunker_map_backup_lock(text,uuid,integer)'::regprocedure),
      'config',(select proconfig from pg_proc where oid='public.claim_bunker_map_backup_lock(text,uuid,integer)'::regprocedure));`)
    assert.deepEqual(privileges, { anon: false, authenticated: false, service: true, directTable: false, rls: true,
      definer: true, config: ["search_path=pg_catalog, pg_temp"] })
  } finally { await db.close() }
})
