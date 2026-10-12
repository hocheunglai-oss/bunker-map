import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { fixtureSql, countryId, otherCountryId, managedPortId, legacyPortId, foreignPortId, mismatchPortId, initialVersion } from "./fixtures/ccinfo-country-rename-sql.mjs"
import { setupNativeCcinfo, waitForBlock, literal } from "./fixtures/native-postgres-ccinfo.mjs"

const renameSql = (id = countryId, name = "SYNTHETIC NEW") => `select public.rename_ccinfo_country('${id}','${initialVersion}'::timestamptz,${literal(name)});`
const settle = promise => promise.then(value => ({ value }), error => ({ error }))
const port = (state, id) => state.ports.find(row => row.id === id)
const country = (state, id = countryId) => state.countries.find(row => row.id === id)
const fence = session => session.one("select public.get_bunker_map_backup_export_fence();")
const except = (row, fields) => Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)))
const nativeFixtureSql = fixtureSql()

async function isolated(t, name, work) {
  await t.test(name, async t => {
    const f = await setupNativeCcinfo(nativeFixtureSql)
    t.diagnostic(`Owned native cluster ${f.root}; runtime ${f.version}; executable SHA-256 ${f.runtimeSha256}; fixture SHA-256 ${f.fixtureSha256}`)
    try { await work(f, t) }
    finally { await f.close(); t.diagnostic("All owned native sessions closed and server stopped.") }
  })
}

function unchangedContent(before, after) {
  assert.deepEqual(after.files, before.files)
  assert.deepEqual(after.folders, before.folders)
  assert.deepEqual(port(after, mismatchPortId), port(before, mismatchPortId), "unrelated historical country labels must not be rewritten")
  assert.deepEqual(except(country(after), ["name", "updated_at"]), except(country(before), ["name", "updated_at"]))
  for (const id of [managedPortId, legacyPortId]) {
    assert.deepEqual(except(port(after, id), ["country_id", "country_name", "updated_at"]), except(port(before, id), ["country_id", "country_name", "updated_at"]))
  }
}

test("native PostgreSQL 17.6: atomic CCINFO country rename races and backup fencing", { timeout: 120000 }, async t => {
  await isolated(t, "distinct service-role backends; rename changes only reviewed labels/versions and commits one backup epoch", async f => {
    const a = await f.session("rename-a"), b = await f.session("reader-b"), observer = await f.session("observer")
    assert.equal(new Set([a.pid, b.pid, observer.pid]).size, 3)
    const metadata = await f.owner.one("select jsonb_build_object('serviceBypass',(select rolbypassrls from pg_roles where rolname='service_role'),'serviceRename',has_function_privilege('service_role','public.rename_ccinfo_country(uuid,timestamptz,text)','execute'),'anonRename',has_function_privilege('anon','public.rename_ccinfo_country(uuid,timestamptz,text)','execute'),'authenticatedRename',has_function_privilege('authenticated','public.rename_ccinfo_country(uuid,timestamptz,text)','execute'),'definer',(select prosecdef from pg_proc where oid='public.rename_ccinfo_country(uuid,timestamptz,text)'::regprocedure));")
    assert.deepEqual(metadata, { serviceBypass: true, serviceRename: true, anonRename: false, authenticatedRename: false, definer: false })
    const before = await f.state(), priorFence = await fence(b)
    await a.begin()
    const renamed = await a.one(renameSql())
    assert.equal(renamed.id, countryId)
    assert.equal(renamed.name, "SYNTHETIC NEW")
    assert.equal(renamed.updated_at, "2099-10-12T00:00:00.123457+00:00", "native CAS version must preserve and advance microseconds, not JS millisecond precision")
    assert.deepEqual(await f.state(), before, "other backends cannot see a half-renamed country or ports")
    assert.deepEqual(await fence(b), { schema: "bunker-map.backup-export-fence/v1", ready: false, epoch: null })
    await a.query("commit;")
    const after = await f.state()
    unchangedContent(before, after)
    assert.equal(country(after).name, "SYNTHETIC NEW")
    assert.equal(port(after, managedPortId).country_name, "SYNTHETIC NEW")
    assert.equal(port(after, legacyPortId).country_name, "SYNTHETIC NEW")
    assert.deepEqual(port(after, foreignPortId), port(before, foreignPortId), "same text linked to a different ID must not be captured")
    assert.equal(after.epochs.length, before.epochs.length + 1)
    const logs = after.audit.filter(row => !before.audit.some(old => old.id === row.id))
    assert.equal(logs.length, 3)
    assert.ok(logs.every(row => row.request_context.action === "ccinfo_country_rename" && row.request_context.countryId === countryId))
    const nextFence = await fence(b)
    assert.equal(nextFence.ready, true)
    assert.ok(Number(nextFence.epoch) > Number(priorFence.epoch))
  })

  await isolated(t, "insert-first: native pending cached-ID and legacy-name inserts are included before rename commits", async (f, t) => {
    const writer = await f.session("insert-first"), renamer = await f.session("rename-second"), observer = await f.session("insert-observer")
    const id = randomUUID(), legacy = randomUUID()
    await writer.begin()
    await writer.query(`insert into public.cc_ports(id,name,country_id,country_name,notes) values ('${id}','NEW ID PORT','${countryId}','SYNTHETIC OLD','PRESERVE INSERT'),('${legacy}','NEW LEGACY PORT',null,'SYNTHETIC OLD','PRESERVE LEGACY');`)
    await renamer.begin()
    const pending = settle(renamer.one(renameSql()))
    const blocked = await waitForBlock(observer, renamer, writer, "relation", "cc_ports")
    t.diagnostic(`Rename waits for real prior port INSERT: ${JSON.stringify(blocked)}`)
    await writer.query("commit;")
    assert.equal((await pending).error, undefined)
    await renamer.query("commit;")
    const after = await f.state()
    assert.equal(port(after, id).country_name, "SYNTHETIC NEW")
    assert.equal(port(after, legacy).country_name, "SYNTHETIC NEW")
    assert.equal(port(after, id).notes, "PRESERVE INSERT")
    assert.equal(port(after, legacy).notes, "PRESERVE LEGACY")
  })

  await isolated(t, "rename-first: a cached old label with stable country ID resumes as the new canonical label", async (f, t) => {
    const renamer = await f.session("rename-first"), writer = await f.session("cached-insert-second"), observer = await f.session("cached-insert-observer")
    const id = randomUUID()
    await renamer.begin(); await renamer.one(renameSql())
    await writer.begin()
    const pending = settle(writer.query(`insert into public.cc_ports(id,name,country_id,country_name,notes) values ('${id}','CACHED ID PORT','${countryId}','SYNTHETIC OLD','KEEP NOTES');`))
    const blocked = await waitForBlock(observer, writer, renamer, "relation", "cc_ports")
    t.diagnostic(`Cached INSERT waits for rename: ${JSON.stringify(blocked)}`)
    await renamer.query("commit;")
    assert.equal((await pending).error, undefined)
    await writer.query("commit;")
    const after = await f.state()
    assert.equal(port(after, id).country_id, countryId)
    assert.equal(port(after, id).country_name, "SYNTHETIC NEW")
    assert.equal(port(after, id).notes, "KEEP NOTES")
    // A post-rename null-ID/old-name insert has no stable identity to map.
    // This test deliberately does not invent an alias or assign it by guess.
  })

  for (const direction of ["into", "away"]) {
    for (const first of ["reparent", "rename"]) {
      await isolated(t, `${first}-first: port reparent ${direction} the country is serializable and retains unrelated content`, async (f, t) => {
        const renamer = await f.session("reparent-renamer"), writer = await f.session("reparent-writer"), observer = await f.session("reparent-observer")
        const before = await f.state()
        const id = direction === "into" ? foreignPortId : managedPortId
        const target = direction === "into" ? countryId : otherCountryId
        const cachedLabel = direction === "into" ? "SYNTHETIC OLD" : "OTHER COUNTRY"
        const update = `update public.cc_ports set country_id='${target}',country_name='${cachedLabel}' where id='${id}';`
        if (first === "reparent") {
          await writer.begin(); await writer.query(update)
          await renamer.begin()
          const pending = settle(renamer.one(renameSql()))
          t.diagnostic(JSON.stringify(await waitForBlock(observer, renamer, writer, "relation", "cc_ports")))
          await writer.query("commit;")
          assert.equal((await pending).error, undefined)
          await renamer.query("commit;")
        } else {
          await renamer.begin(); await renamer.one(renameSql())
          await writer.begin()
          const pending = settle(writer.query(update))
          t.diagnostic(JSON.stringify(await waitForBlock(observer, writer, renamer, "relation", "cc_ports")))
          await renamer.query("commit;")
          assert.equal((await pending).error, undefined)
          await writer.query("commit;")
        }
        const after = await f.state()
        unchangedContent(before, after)
        assert.equal(port(after, id).country_id, target)
        assert.equal(port(after, id).country_name, direction === "into" ? "SYNTHETIC NEW" : "OTHER COUNTRY")
        assert.deepEqual(except(port(after, id), ["country_id", "country_name", "updated_at"]), except(port(before, id), ["country_id", "country_name", "updated_at"]))
      })
    }
  }

  await isolated(t, "delete-first: country removal wins; blocked rename fails without any partial label/audit/epoch writes", async (f, t) => {
    const remover = await f.session("delete-first"), renamer = await f.session("rename-after-delete"), observer = await f.session("delete-observer")
    await remover.begin(); await remover.query(`delete from public.cc_countries where id='${countryId}';`)
    await renamer.begin()
    const pending = settle(renamer.one(renameSql()))
    t.diagnostic(JSON.stringify(await waitForBlock(observer, renamer, remover, "relation", "cc_countries")))
    await remover.query("commit;")
    const afterDelete = await f.state(), outcome = await pending
    assert.equal(outcome.error?.code, "40001")
    assert.equal(country(afterDelete), undefined)
    assert.equal(port(afterDelete, managedPortId).country_id, null)
    assert.equal(port(afterDelete, managedPortId).country_name, "SYNTHETIC OLD")
    assert.deepEqual(await f.state(), afterDelete)
  })

  await isolated(t, "rename-first: subsequent country removal waits, then preserves renamed legacy labels without deadlock", async (f, t) => {
    const renamer = await f.session("rename-before-delete"), remover = await f.session("delete-second"), observer = await f.session("delete-second-observer")
    await renamer.begin(); await renamer.one(renameSql())
    await remover.begin()
    const pending = settle(remover.query(`delete from public.cc_countries where id='${countryId}';`))
    t.diagnostic(JSON.stringify(await waitForBlock(observer, remover, renamer, "relation", "cc_countries")))
    await renamer.query("commit;")
    assert.equal((await pending).error, undefined)
    await remover.query("commit;")
    const after = await f.state()
    assert.equal(country(after), undefined)
    assert.equal(port(after, managedPortId).country_id, null)
    assert.equal(port(after, managedPortId).country_name, "SYNTHETIC NEW")
    assert.equal(port(after, legacyPortId).country_name, "SYNTHETIC NEW")
  })

  await isolated(t, "same-target rename race: exactly one country gets the name and losing transaction writes nothing", async (f, t) => {
    const a = await f.session("same-name-a"), b = await f.session("same-name-b"), observer = await f.session("same-name-observer")
    const before = await f.state()
    await a.begin(); await a.one(renameSql(countryId, "SHARED NEW NAME"))
    await b.begin()
    const pending = settle(b.one(renameSql(otherCountryId, "shared new name")))
    t.diagnostic(JSON.stringify(await waitForBlock(observer, b, a, "relation", "cc_countries")))
    await a.query("commit;")
    const winner = await f.state(), outcome = await pending
    assert.equal(outcome.error?.code, "23505")
    assert.equal(winner.countries.filter(row => row.name === "SHARED NEW NAME").length, 1)
    assert.deepEqual(country(winner, otherCountryId), country(before, otherCountryId))
    assert.deepEqual(port(winner, foreignPortId), port(before, foreignPortId))
    assert.deepEqual(await f.state(), winner)
  })

  await isolated(t, "backup-exclusive-first: rename waits before tables; pending rename keeps the shared backup fence closed", async (f, t) => {
    const backup = await f.session("backup-owner"), renamer = await f.session("backup-blocked-renamer"), observer = await f.session("backup-observer")
    const before = await f.state()
    await backup.begin(); await backup.query("select pg_advisory_xact_lock(730261052372033133::bigint);")
    await renamer.begin()
    const pending = settle(renamer.one(renameSql()))
    t.diagnostic(JSON.stringify(await waitForBlock(observer, renamer, backup, "advisory")))
    assert.deepEqual(await f.state(), before)
    await backup.query("commit;")
    assert.equal((await pending).error, undefined)
    assert.deepEqual(await f.state(), before)
    assert.equal((await fence(observer)).ready, false)
    await renamer.query("commit;")
    assert.equal((await fence(observer)).ready, true)
    assert.equal(country(await f.state()).name, "SYNTHETIC NEW")
  })

  await isolated(t, "native five-second country-table lock timeout rolls back all rename, audit, and backup state", async (f, t) => {
    const holder = await f.session("country-lock-holder"), renamer = await f.session("timed-out-renamer"), observer = await f.session("timeout-observer")
    const before = await f.state()
    await holder.begin(); await holder.query(`update public.cc_countries set notes='UNCOMMITTED HOLDER' where id='${countryId}';`)
    await renamer.begin()
    const started = Date.now(), pending = settle(renamer.one(renameSql()))
    t.diagnostic(JSON.stringify(await waitForBlock(observer, renamer, holder, "relation", "cc_countries")))
    const outcome = await pending, elapsed = Date.now() - started
    assert.equal(outcome.error?.code, "55P03")
    assert.ok(elapsed >= 4500 && elapsed < 12000, `Expected bounded 5-second lock timeout, got ${elapsed}ms`)
    assert.deepEqual(await f.state(), before)
    await holder.query("rollback;")
    assert.deepEqual(await f.state(), before)
    assert.equal((await fence(observer)).ready, true)
    t.diagnostic(`Actual native lock timeout SQLSTATE 55P03 after ${elapsed}ms; complete rollback verified.`)
  })

  await isolated(t, "whole-schema/data native pg_dump and psql restore preserve historical labels, versions, file links, audit, ACLs and triggers", async (f, t) => {
    const renamer = await f.session("pre-recovery-renamer")
    await renamer.begin(); await renamer.one(renameSql()); await renamer.query("commit;")
    const before = await f.state()
    const metadataSql = `select jsonb_build_object(
      'schemas',(select jsonb_agg(jsonb_build_object('name',n.nspname,'acl',coalesce(n.nspacl,acldefault('n',n.nspowner)),'owner',pg_get_userbyid(n.nspowner)) order by n.nspname) from pg_namespace n where n.nspname in ('public','private')),
      'tables',(select jsonb_agg(jsonb_build_object('name',c.oid::regclass::text,'rls',c.relrowsecurity,'acl',coalesce(c.relacl,acldefault('r',c.relowner))) order by c.oid::regclass::text) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind='r'),
      'constraints',(select jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid)) order by c.conrelid::regclass::text,c.conname) from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace where n.nspname in ('public','private')),
      'triggers',(select jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,'type',t.tgtype::integer,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) order by t.tgrelid::regclass::text,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('public','private')),
      'functions',(select jsonb_agg(jsonb_build_object('identity',p.oid::regprocedure::text,'definer',p.prosecdef,'config',p.proconfig,'acl',coalesce(p.proacl,acldefault('f',p.proowner)),'definition',pg_get_functiondef(p.oid)) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')));`
    const metadata = await f.owner.one(metadataSql)
    const recovery = await f.dumpAndRestore()
    t.diagnostic(`Owned whole-fixture pg_dump/psql recovery ${recovery.file}; SHA-256 ${recovery.sha256}`)
    assert.deepEqual(await f.state(recovery.owner), before)
    assert.deepEqual(await recovery.owner.one(metadataSql), metadata)
    assert.equal(port(await f.state(recovery.owner), foreignPortId).country_name, "SYNTHETIC OLD", "post-data trigger restoration must not canonicalize unrelated historical labels")
    assert.equal(port(await f.state(recovery.owner), mismatchPortId).country_name, "HISTORICAL ALIAS")
    assert.deepEqual(await fence(recovery.service), await fence(renamer))
    const acl = await recovery.service.one("select jsonb_build_object('rename',has_function_privilege(current_user,'public.rename_ccinfo_country(uuid,timestamptz,text)','execute'),'anonRename',has_function_privilege('anon','public.rename_ccinfo_country(uuid,timestamptz,text)','execute'),'authenticatedRename',has_function_privilege('authenticated','public.rename_ccinfo_country(uuid,timestamptz,text)','execute'),'privateMarkerRead',has_table_privilege(current_user,'private.bunker_map_backup_mutations','select'));")
    assert.deepEqual(acl, { rename: true, anonRename: false, authenticatedRename: false, privateMarkerRead: false })
    const id = randomUUID()
    await recovery.service.begin()
    await recovery.service.query(`insert into public.cc_ports(id,name,country_id,country_name) values('${id}','RECOVERY CACHED PORT','${countryId}','SYNTHETIC OLD');`)
    await recovery.service.query("commit;")
    assert.equal(port(await f.state(recovery.owner), id).country_name, "SYNTHETIC NEW", "restored canonicalization trigger remains active for new writes")
    assert.deepEqual(await f.state(), before, "recovery verification must not mutate the source fixture database")
  })
})
