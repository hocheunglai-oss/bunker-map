import assert from "node:assert/strict"
import test from "node:test"
import { setupNativeCcinfo, literal, waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"
import { gapFixtureSql, observation, due, epoch, inventory, gap, h1, h2, c1, c2 } from "./fixtures/backup-protection-gaps-sql.mjs"

const call = (time = observation, gaps = [inventory()], complete = true, domain = "database") =>
  `select public.reconcile_backup_protection_gaps(${literal(domain)},${literal(time)}::timestamptz,${literal(JSON.stringify(gaps))}::jsonb,${complete});`
const previewCall = (...args) => call(...args).replace("public.reconcile_backup_protection_gaps", "public.preview_backup_protection_gaps")
const state = f => f.owner.one(`select jsonb_build_object(
  'parents',(select coalesce(jsonb_agg(to_jsonb(t) order by domain),'[]') from private.backup_protection_observations t),
  'gaps',(select coalesce(jsonb_agg(to_jsonb(t) order by domain,gap_key),'[]') from private.backup_protection_gaps t));`)

test("native PostgreSQL durable backup-gap transactions serialize observations and roll back failures", { timeout: 120000 }, async t => {
  const f = await setupNativeCcinfo(gapFixtureSql())
  try {
    await t.test("a trigger-altered initial parent timestamp rolls back without saving parent or child clocks", async () => {
      await f.owner.query(`create function private.alter_initial_gap_observation() returns trigger language plpgsql as $$ begin
        new.last_observed_at := new.last_observed_at + interval '1 hour'; return new; end $$;
        create trigger alter_initial_gap_observation before insert on private.backup_protection_observations
          for each row execute function private.alter_initial_gap_observation();`)
      const before = await state(f), writer = await f.session("altered-initial-gap-observation")
      await assert.rejects(writer.one(call(observation, [gap("opaque-file")], true, "drive-file")), error => error.code === "P0001" && error.message.includes("BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED"))
      assert.deepEqual(await state(f), before)
      await f.owner.query("drop trigger alter_initial_gap_observation on private.backup_protection_observations;")
    })
    await t.test("simultaneous first observations share one clock and cannot postpone the first deadline", async () => {
      const first = await f.session("first-gap-writer"), second = await f.session("second-gap-writer"), observer = await f.session("gap-lock-observer")
      await first.begin()
      const opened = await first.one(call())
      const next = second.one(call("2026-10-14T01:00:00Z", [inventory("2026-10-15T00:00:00Z")]))
      await waitForBlock(observer, second, first)
      await first.query("commit;")
      const result = await next
      assert.equal(result.accepted, true)
      assert.deepEqual(result.gaps, opened.gaps)
      assert.equal(epoch(result.observedAt), epoch("2026-10-14T01:00:00Z"))
      assert.equal((await state(f)).parents.length, 1); assert.equal((await state(f)).gaps.length, 1)
    })
    await t.test("a delayed stale complete observation waits, then cannot clear a newer incomplete clock", async () => {
      const first = await f.session("newer-gap-writer"), stale = await f.session("held-stale-complete"), observer = await f.session("stale-gap-observer")
      await first.begin()
      const newer = await first.one(call("2026-10-14T03:00:00Z", [gap("availability")], false))
      const pending = stale.one(call("2026-10-14T02:00:00Z", [], true))
      await waitForBlock(observer, stale, first)
      await first.query("commit;")
      const before = await state(f), rejected = await pending
      assert.equal(rejected.accepted, false); assert.deepEqual(rejected.gaps, newer.gaps)
      assert.equal(epoch(rejected.observedAt), epoch("2026-10-14T03:00:00Z"))
      assert.deepEqual(await state(f), before)
    })
    await t.test("a held database observation does not block the independent drive-file domain", async () => {
      const database = await f.session("held-database-domain"), drive = await f.session("independent-drive-domain")
      await database.begin()
      await database.one(call("2026-10-14T04:00:00Z", [], false))
      const result = await drive.one(call(observation, [gap("opaque-abc")], true, "drive-file"))
      assert.equal(result.accepted, true); assert.equal(result.domain, "drive-file")
      await database.query("commit;")
      assert.equal((await state(f)).parents.length, 2)
    })
    await t.test("a late SQL failure rolls back gap and parent ordering state together", async () => {
      await f.owner.query(`create function private.inject_gap_failure() returns trigger language plpgsql as $$ begin
        if new.gap_key='fail-key' then raise exception 'SYNTHETIC GAP FAILURE'; end if;return new;end $$;
        create trigger inject_gap_failure before insert on private.backup_protection_gaps for each row execute function private.inject_gap_failure();`)
      const before = await state(f), writer = await f.session("failed-gap-write")
      await assert.rejects(writer.one(call("2026-10-14T05:00:00Z", [gap("fail-key")])), /SYNTHETIC GAP FAILURE/)
      assert.deepEqual(await state(f), before)
      await f.owner.query("drop trigger inject_gap_failure on private.backup_protection_gaps;")
    })
    await t.test("suppressed required INSERT/UPDATE/DELETE operations cannot acknowledge partial clock state", async () => {
      for (const [table, operation] of [
        ["backup_protection_gaps", "insert"], ["backup_protection_gaps", "delete"], ["backup_protection_observations", "update"],
      ]) {
        await f.owner.query(`create or replace function private.suppress_gap_write() returns trigger language plpgsql as $$ begin return null;end $$;
          create trigger suppress_gap_write before ${operation} on private.${table} for each row execute function private.suppress_gap_write();`)
        const before = await state(f), writer = await f.session(`suppressed-${operation}`)
        const gaps = operation === "insert" ? [gap("suppressed-key")] : operation === "delete" ? [] : [inventory()]
        await assert.rejects(writer.one(call("2026-10-14T06:00:00Z", gaps)), error => error.code === "P0001" && error.message.includes("BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED"))
        assert.deepEqual(await state(f), before)
        await f.owner.query(`drop trigger suppress_gap_write on private.${table};`)
      }
    })
    await t.test("suppressed verified reset UPDATE rolls back exact time, due, requirement and parent acknowledgement", async () => {
      await f.owner.query(`create or replace function private.suppress_gap_write() returns trigger language plpgsql as $$ begin return null;end $$;
        create trigger suppress_gap_write before update on private.backup_protection_gaps for each row execute function private.suppress_gap_write();`)
      const before = await state(f), writer = await f.session("suppressed-verified-reset")
      await assert.rejects(writer.one(call("2026-10-14T06:30:00Z", [inventory("2026-10-16T18:00:00Z", {
        requiredVersion: h2, requiredFingerprint: c2, coveredThroughAt: "2026-10-13T23:30:00Z", coveredVersion: h1, coveredFingerprint: c1,
      })], false)), error => error.code === "P0001" && error.message.includes("BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED"))
      assert.deepEqual(await state(f), before)
      await f.owner.query("drop trigger suppress_gap_write on private.backup_protection_gaps;")
    })
    await t.test("native validation returns stable 22023 without parent or gap changes", async () => {
      const invalid = [
        [observation, null], [observation, [null]], [observation, [gap("availability", due, { requiredSinceAt: null })]],
        [observation, [gap("availability", due, { requiredSinceAt: "2026-02-30T00:00:00Z" })]],
        [observation, [inventory("2026-10-14T00:00:00+99:99")]],
        [observation, [gap("availability", due, { requiredSinceAt: "2026-10-14T00:00:00-16:00" })]],
        [observation, [gap("availability", due, { coveredThroughAt: "2026-10-14T00:00:00+16:00" })]],
        [observation, [gap("availability", due, { coveredThroughAt: "2026-10-14T09:00:00Z" })]],
        [observation, [inventory(due, { requiredSinceAt: observation })]], [observation, [inventory(), inventory()]],
        [observation, Array.from({ length: 10001 }, (_, i) => gap(`oversize-${i}`))], ["infinity", []], ["2999-01-01T00:00:00Z", []],
        [observation, [], null], [observation, [], true, "database-schema"],
      ]
      const before = await state(f)
      for (const [index, args] of invalid.entries()) {
        const writer = await f.session(`invalid-gap-${index}`)
        await assert.rejects(writer.one(call(...args)), error => error.code === "22023")
        assert.deepEqual(await state(f), before)
      }
    })
    await t.test("service invocation is authorized but anonymous and authenticated roles cannot execute or read", async () => {
      const flags = await f.owner.one(`select jsonb_build_object('invoker',not prosecdef,'config',proconfig,
        'anon',has_function_privilege('anon',oid,'execute'),'authenticated',has_function_privilege('authenticated',oid,'execute'),
        'service',has_function_privilege('service_role',oid,'execute')) from pg_proc
        where oid='public.reconcile_backup_protection_gaps(text,timestamptz,jsonb,boolean)'::regprocedure;`)
      assert.deepEqual(flags, { invoker: true, config: ['search_path=""'], anon: false, authenticated: false, service: true })
      for (const role of ["anon", "authenticated"]) {
        const denied = await f.session(`denied-gap-${role}`, false)
        await denied.query(`set role ${role};`)
        await assert.rejects(denied.one(call()), error => error.code === "42501")
        const reader = await f.session(`denied-gap-read-${role}`, false)
        await reader.query(`set role ${role};`)
        await assert.rejects(reader.query("select * from private.backup_protection_gaps;"), error => error.code === "42501")
      }
      const service = await f.session("accepted-gap-service")
      assert.equal((await service.one(call("2026-10-14T07:00:00Z", [], false))).accepted, true)
    })
    await t.test("verified intervening coverage resets only its current key and survives dump/restore", async () => {
      const service = await f.session("verified-gap-proof")
      const renewed = await service.one(call("2026-10-14T08:30:00Z", [inventory("2026-10-16T18:00:00Z", { requiredVersion: h2, requiredFingerprint: c2, coveredThroughAt: "2026-10-14T07:30:00Z", coveredVersion: h1, coveredFingerprint: c1 })], false))
      assert.equal(epoch(renewed.gaps.find(gap => gap.key === "inventory").firstUncoveredAt), epoch("2026-10-14T08:30:00Z"))
      const before = await state(f), recovery = await f.dumpAndRestore()
      assert.equal(before.gaps.find(gap => gap.gap_key === "inventory").required_version, h2)
      assert.equal(before.gaps.find(gap => gap.gap_key === "inventory").required_fingerprint, c2)
      assert.deepEqual(await state({ owner: recovery.owner }), before)
      const stale = await recovery.service.one(call("2026-10-14T08:00:00Z", [], true))
      assert.equal(stale.accepted, false); assert.deepEqual(stale.gaps, renewed.gaps)
      assert.deepEqual(await state({ owner: recovery.owner }), before)
      assert.match(recovery.sha256, /^[a-f0-9]{64}$/)
    })
    await t.test("repeated complete max-size batches keep all clocks and use one-pass anti joins", async () => {
      const service = await f.session("repeated-maximum-gap-batch")
      await service.query("set statement_timeout='10s';")
      const large = Array.from({ length: 10000 }, (_, i) => gap(`opaque-${i}`, "2026-10-20T00:00:00Z"))
      const first = await service.one(call("2026-10-14T10:00:00Z", large, true, "drive-file"))
      assert.equal(first.gaps.length, 10000)
      const physical = await service.one("select jsonb_agg(jsonb_build_array(gap_key,ctid::text) order by gap_key) from private.backup_protection_gaps where domain='drive-file';")
      const timings = []
      for (const time of ["2026-10-14T11:00:00Z", "2026-10-14T12:00:00Z"]) {
        const started = performance.now(), repeated = await service.one(call(time, large, true, "drive-file"))
        timings.push(Math.round(performance.now() - started))
        assert.deepEqual(repeated.gaps, first.gaps)
      }
      assert.deepEqual(await service.one("select jsonb_agg(jsonb_build_array(gap_key,ctid::text) order by gap_key) from private.backup_protection_gaps where domain='drive-file';"), physical)
      const beforePreview = await state(f), previewStarted = performance.now()
      await service.query("begin read only;")
      assert.deepEqual((await service.one(previewCall("2026-10-14T13:00:00Z", large, true, "drive-file"))).gaps, first.gaps)
      await service.query("commit;")
      const previewMs = Math.round(performance.now() - previewStarted)
      assert.deepEqual(await state(f), beforePreview)
      assert.deepEqual(await service.one("select jsonb_agg(jsonb_build_array(gap_key,ctid::text) order by gap_key) from private.backup_protection_gaps where domain='drive-file';"), physical)
      const clauses = `from private.backup_protection_gaps as gaps where gaps.domain='drive-file' and not exists (
        select 1 from pg_catalog.jsonb_array_elements(${literal(JSON.stringify(large))}::jsonb) as item where item->>'key'=gaps.gap_key)`
      for (const statement of [`delete ${clauses}`, `select exists(select 1 ${clauses})`]) {
        const plan = JSON.parse((await service.query(`explain (analyze,buffers,format json) ${statement};`)).join("\n"))[0]
        const nodes = [], collect = node => { nodes.push(node); for (const child of node.Plans || []) collect(child) }
        collect(plan.Plan)
        assert.ok(nodes.some(node => node["Node Type"] === "Hash Join" && node["Join Type"] === "Anti"), "the membership check hashes the input instead of rescanning it per existing gap")
        const scans = nodes.filter(node => node["Node Type"] === "Function Scan" && node["Function Name"] === "jsonb_array_elements")
        assert.equal(scans.length, 1); assert.equal(scans[0]["Actual Loops"], 1); assert.equal(scans[0]["Actual Rows"], 10000)
        assert.equal(plan.Plan["Temp Written Blocks"], 0)
      }
      t.diagnostic(`Native repeated complete 10k RPC durations: ${timings.join(", ")} ms; READ ONLY 10k preview ${previewMs} ms; unchanged clock state/child ctid and single-pass hash anti joins verified.`)
    })
  } finally { await f.close() }
})

test("native read-only backup-gap preview shares policy without ordering writes or row locks", { timeout: 120000 }, async t => {
  const f = await setupNativeCcinfo(gapFixtureSql())
  const physical = () => f.owner.one(`select jsonb_build_object(
    'parents',(select coalesce(jsonb_agg(jsonb_build_array(domain,ctid::text) order by domain),'[]') from private.backup_protection_observations),
    'gaps',(select coalesce(jsonb_agg(jsonb_build_array(domain,gap_key,ctid::text) order by domain,gap_key),'[]') from private.backup_protection_gaps));`)
  try {
    await t.test("healthy and new-gap previews work in READ ONLY transactions without creating either clock table row", async () => {
      const reader = await f.session("read-only-first-gap-preview"), before = await state(f), ids = await physical()
      await reader.query("begin read only;")
      assert.deepEqual((await reader.one(previewCall(observation, []))).gaps, [])
      assert.equal((await reader.one(previewCall())).gaps.length, 1)
      await reader.query("commit;")
      assert.deepEqual(await state(f), before); assert.deepEqual(await physical(), ids)
      const writer = await f.session("read-only-reconcile-refusal")
      await writer.query("begin read only;")
      await assert.rejects(writer.one(call()), error => error.code === "25006")
      assert.deepEqual(await state(f), before)
    })
    await t.test("overdue, recovery, late coverage and incomplete projections match reconcile from the same initial transaction snapshot", async () => {
      const service = await f.session("preview-parity-service")
      await service.one(call(observation, [inventory(), gap("availability")]))
      await service.one(call(observation, [gap("opaque-file", due, { requiredSinceAt: "2026-10-13T07:00:00Z" })], true, "drive-file"))
      const before = await state(f), ids = await physical(), observed = "2026-10-14T09:00:00Z"
      const cases = [
        [[], true, "database"], [[], false, "database"], [[inventory("2026-10-20T00:00:00Z")], false, "database"],
        [[gap("new-gap")], false, "database"],
        [[inventory("2026-10-20T00:00:00Z", { requiredVersion: h2, requiredFingerprint: c2, coveredThroughAt: "2026-10-13T08:00:00Z", coveredVersion: h1, coveredFingerprint: c1 })], false, "database"],
        [[gap("opaque-file", "2026-10-20T00:00:00Z", { requiredSinceAt: "2026-10-14T08:00:00Z", coveredThroughAt: "2026-10-13T08:00:00Z" })], false, "drive-file"],
      ]
      for (const [gaps, complete, domain] of cases) {
        await service.query("begin read only;")
        const projected = await service.one(previewCall(observed, gaps, complete, domain))
        await service.query("commit;")
        assert.deepEqual(await state(f), before); assert.deepEqual(await physical(), ids)
        await service.query("begin;")
        assert.deepEqual(await service.one(call(observed, gaps, complete, domain)), projected)
        await service.query("rollback;")
        assert.deepEqual(await state(f), before)
      }
    })
    await t.test("preview does not wait for a held parent observation lock and stale input remains a projection", async () => {
      const writer = await f.session("held-observation-for-preview"), reader = await f.session("lock-free-gap-preview")
      const before = await state(f)
      await writer.begin()
      await writer.one(call("2026-10-14T10:00:00Z", [inventory()], false))
      await reader.query("set statement_timeout='1s'; begin read only;")
      const projected = await reader.one(previewCall("2026-10-13T23:00:00Z", [], false))
      assert.equal(projected.accepted, true); assert.equal(epoch(projected.observedAt), epoch("2026-10-13T23:00:00Z"))
      assert.equal(epoch(projected.gaps[0].firstUncoveredAt), epoch(observation))
      const locks = await f.owner.one(`select coalesce(jsonb_agg(mode),'[]') from pg_locks where pid=${reader.pid}
        and relation in ('private.backup_protection_gaps'::regclass,'private.backup_protection_observations'::regclass);`)
      assert.ok(locks.every(mode => mode === "AccessShareLock"))
      await reader.query("commit;"); await writer.query("rollback;")
      assert.deepEqual(await state(f), before)
    })
    await t.test("preview and private shared helpers are STABLE service-only invokers, and malformed input stays 22023", async () => {
      const metadata = await f.owner.one(`select jsonb_agg(jsonb_build_object('stable',provolatile='s','invoker',not prosecdef,'config',proconfig,
        'anon',has_function_privilege('anon',oid,'execute'),'authenticated',has_function_privilege('authenticated',oid,'execute'),
        'service',has_function_privilege('service_role',oid,'execute'))) from pg_proc where oid in (
        'public.preview_backup_protection_gaps(text,timestamptz,jsonb,boolean)'::regprocedure,
        'private.validate_backup_protection_gaps(text,timestamptz,jsonb,boolean)'::regprocedure,
        'private.backup_protection_gap_is_covered(text,text,timestamptz,text,text,jsonb)'::regprocedure);`)
      assert.equal(metadata.length, 3)
      for (const flags of metadata) assert.deepEqual(flags, { stable: true, invoker: true, config: ['search_path=""'], anon: false, authenticated: false, service: true })
      const before = await state(f), ids = await physical()
      for (const role of ["anon", "authenticated"]) {
        const denied = await f.session(`preview-denied-${role}`, false)
        await denied.query(`set role ${role};`)
        await assert.rejects(denied.one(previewCall()), error => error.code === "42501")
      }
      for (const gaps of [[inventory(), inventory()], [gap("bad", due, { requiredSinceAt: "2026-10-14T00:00:00+99:99" })], [gap("bad", due, { coveredThroughAt: "2026-10-15T00:00:00Z" })]]) {
        const invalid = await f.session("invalid-preview-input")
        await assert.rejects(invalid.one(previewCall(observation, gaps)), error => error.code === "22023")
        assert.deepEqual(await state(f), before); assert.deepEqual(await physical(), ids)
      }
    })
  } finally { await f.close() }
})
