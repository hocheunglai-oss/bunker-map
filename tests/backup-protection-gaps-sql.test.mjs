import assert from "node:assert/strict"
import test from "node:test"
import { gapFixtureSql, observation, due, epoch, inventory, gap, h1, h2, h3, c1, c2, c3 } from "./fixtures/backup-protection-gaps-sql.mjs"

const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
async function fixture() {
  const db = new PGlite()
  try { await db.exec(gapFixtureSql()); await db.exec("set role service_role"); return db }
  catch (error) { await db.close(); throw error }
}
const reconcile = async (db, gaps = [inventory()], observed = observation, complete = true, domain = "database") =>
  (await db.query("select public.reconcile_backup_protection_gaps($1,$2::timestamptz,$3::jsonb,$4::boolean) as result", [domain, observed, JSON.stringify(gaps), complete])).rows[0].result
const preview = async (db, gaps = [inventory()], observed = observation, complete = true, domain = "database") =>
  (await db.query("select public.preview_backup_protection_gaps($1,$2::timestamptz,$3::jsonb,$4::boolean) as result", [domain, observed, JSON.stringify(gaps), complete])).rows[0].result
const snapshot = async db => (await db.query(`select jsonb_build_object(
  'parents',(select coalesce(jsonb_agg(to_jsonb(t) order by domain),'[]') from private.backup_protection_observations t),
  'gaps',(select coalesce(jsonb_agg(to_jsonb(t) order by domain,gap_key),'[]') from private.backup_protection_gaps t)) as state`)).rows[0].state

test("durable gaps retain first uncovered time and the earliest due time without rewriting unchanged gap rows", async () => {
  const db = await fixture()
  try {
    const first = await reconcile(db)
    assert.equal(first.schema, "fcuno.backup-protection-gaps/v1"); assert.equal(first.accepted, true)
    assert.equal(first.domain, "database"); assert.equal(epoch(first.observedAt), epoch(observation))
    const original = first.gaps[0], physical = (await db.query("select ctid::text as tid from private.backup_protection_gaps")).rows
    const later = await reconcile(db, [inventory("2026-10-15T18:00:00Z")], "2026-10-14T01:00:00Z")
    assert.deepEqual(later.gaps[0], original)
    assert.deepEqual((await db.query("select ctid::text as tid from private.backup_protection_gaps")).rows, physical)
    const earlier = await reconcile(db, [inventory("2026-10-12T18:00:00+00:00")], "2026-10-14T02:00:00Z")
    assert.equal(epoch(earlier.gaps[0].firstUncoveredAt), epoch(original.firstUncoveredAt))
    assert.equal(epoch(earlier.gaps[0].firstDueAt), epoch("2026-10-12T18:00:00Z"))
  } finally { await db.close() }
})

test("finite RFC3339 offsets and fractional timestamps normalize without rejecting future deadlines", async () => {
  const db = await fixture()
  try {
    const first = await reconcile(db, [inventory("2026-10-20t00:00:00.1234567z")])
    assert.match(first.gaps[0].firstDueAt, /123457/, "Postgres retains its native microsecond precision")
    const reset = await reconcile(db, [inventory("2026-10-21T08:00:00+08:00", {
      requiredVersion: h2, requiredFingerprint: c2, coveredThroughAt: "2026-10-14t00:00:00z", coveredVersion: h1, coveredFingerprint: c1,
    })], "2026-10-14T01:00:00Z")
    assert.equal(epoch(reset.gaps[0].firstDueAt), epoch("2026-10-21T00:00:00Z"))
  } finally { await db.close() }
})

test("unknown observations preserve open gaps, stale/equal complete observations cannot clear newer state", async () => {
  const db = await fixture()
  try {
    await reconcile(db)
    const unknown = await reconcile(db, [], "2026-10-14T02:00:00Z", false)
    assert.equal(unknown.gaps.length, 1)
    const before = await snapshot(db)
    for (const time of [observation, "2026-10-14T02:00:00Z"]) {
      const stale = await reconcile(db, [], time, true)
      assert.equal(stale.accepted, false); assert.equal(epoch(stale.observedAt), epoch("2026-10-14T02:00:00Z"))
      assert.deepEqual(stale.gaps, unknown.gaps); assert.deepEqual(await snapshot(db), before)
    }
  } finally { await db.close() }
})

test("complete empty observations close only their domain; a later new gap starts a fresh clock", async () => {
  const db = await fixture()
  try {
    await reconcile(db, [inventory(), gap("availability")])
    const drive = await reconcile(db, [gap("opaque-123")], observation, true, "drive-file")
    assert.equal((await reconcile(db, [inventory()], "2026-10-14T01:00:00Z")).gaps.length, 1)
    assert.deepEqual((await reconcile(db, [], "2026-10-14T02:00:00Z")).gaps, [])
    assert.deepEqual((await reconcile(db, [], observation, false, "drive-file")).gaps, drive.gaps)
    const reopened = await reconcile(db, [inventory()], "2026-10-14T03:00:00Z")
    assert.equal(epoch(reopened.gaps[0].firstUncoveredAt), epoch("2026-10-14T03:00:00Z"))
  } finally { await db.close() }
})

test("only verified per-key coverage reaching the old gap resets its clock, including incomplete observations", async () => {
  const db = await fixture()
  try {
    const first = await reconcile(db, [inventory(), gap("availability")])
    const other = first.gaps.find(gap => gap.key === "inventory")
    const beforeProof = await reconcile(db, [gap("availability", "2026-10-15T18:00:00Z", { coveredThroughAt: "2026-10-13T23:59:59Z" })], "2026-10-14T01:00:00Z", false)
    assert.deepEqual(beforeProof.gaps, first.gaps, "a snapshot before the gap cannot postpone it")
    const reset = await reconcile(db, [gap("availability", "2026-10-16T18:00:00Z", { requiredSinceAt: "2026-10-14T08:00:00Z", coveredThroughAt: "2026-10-14T02:00:00Z" })], "2026-10-14T08:30:00Z", false)
    const renewed = reset.gaps.find(gap => gap.key === "availability")
    assert.equal(epoch(renewed.firstUncoveredAt), epoch("2026-10-14T08:30:00Z"))
    assert.equal(epoch(renewed.firstDueAt), epoch("2026-10-16T18:00:00Z"))
    assert.deepEqual(reset.gaps.find(gap => gap.key === "inventory"), other, "per-key proof does not close another unknown gap")
    const repeated = await reconcile(db, [gap("availability", "2026-10-17T18:00:00Z", { requiredSinceAt: "2026-10-14T09:00:00Z", coveredThroughAt: "2026-10-14T02:00:00Z" })], "2026-10-14T09:30:00Z", false)
    assert.deepEqual(repeated.gaps, reset.gaps, "reusing old proof cannot reset the newly opened gap")
    const beforeStale = await snapshot(db)
    const stale = await reconcile(db, [gap("availability", "2026-10-20T18:00:00Z", { requiredSinceAt: "2026-10-14T08:00:00Z", coveredThroughAt: "2026-10-14T08:30:00Z" })], "2026-10-14T09:00:00Z", true)
    assert.equal(stale.accepted, false); assert.deepEqual(await snapshot(db), beforeStale, "even sufficient per-key proof cannot make a stale observation authoritative")
    const equal = await reconcile(db, [gap("availability", "2026-10-18T18:00:00Z", { requiredSinceAt: "2026-10-14T10:00:00Z", coveredThroughAt: "2026-10-14T08:00:00Z" })], "2026-10-14T10:30:00Z", false)
    assert.equal(epoch(equal.gaps.find(gap => gap.key === "availability").firstUncoveredAt), epoch("2026-10-14T10:30:00Z"))
    assert.equal(epoch(equal.gaps.find(gap => gap.key === "availability").firstDueAt), epoch("2026-10-18T18:00:00Z"))
  } finally { await db.close() }
})

test("late-published file coverage uses the first actual required generation, not first observation or a later edit", async () => {
  const db = await fixture()
  try {
    const first = await reconcile(db, [gap("opaque-file", "2026-10-15T06:15:00Z", { requiredSinceAt: "2026-10-13T07:00:00Z" })], "2026-10-13T08:30:00Z", true, "drive-file")
    const changed = await reconcile(db, [gap("opaque-file", "2026-10-16T06:15:00Z", { requiredSinceAt: "2026-10-14T08:00:00Z" })], "2026-10-14T08:30:00Z", false, "drive-file")
    assert.deepEqual(changed.gaps, first.gaps)
    assert.equal(epoch((await snapshot(db)).gaps[0].required_since_at), epoch("2026-10-13T07:00:00Z"))
    const renewed = await reconcile(db, [gap("opaque-file", "2026-10-16T06:15:00Z", {
      requiredSinceAt: "2026-10-14T08:00:00Z", coveredThroughAt: "2026-10-13T08:00:00Z",
    })], "2026-10-14T09:00:00Z", false, "drive-file")
    assert.equal(epoch(renewed.gaps[0].firstUncoveredAt), epoch("2026-10-14T09:00:00Z"))
    assert.equal(epoch(renewed.gaps[0].firstDueAt), epoch("2026-10-16T06:15:00Z"))
    assert.equal(epoch((await snapshot(db)).gaps[0].required_since_at), epoch("2026-10-14T08:00:00Z"))
    const repeated = await reconcile(db, [gap("opaque-file", "2026-10-17T06:15:00Z", {
      requiredSinceAt: "2026-10-15T08:00:00Z", coveredThroughAt: "2026-10-13T08:00:00Z",
    })], "2026-10-14T10:00:00Z", false, "drive-file")
    assert.deepEqual(repeated.gaps, renewed.gaps, "neither a later edit nor reused old coverage can postpone the new requirement")
    assert.deepEqual(Object.keys(repeated.gaps[0]).sort(), ["firstDueAt", "firstUncoveredAt", "key"])
  } finally { await db.close() }
})

test("future required timestamps are valid pending work and equality covers the pinned non-inventory requirement", async () => {
  const db = await fixture()
  try {
    const first = await reconcile(db, [gap("availability", "2026-10-15T06:15:00Z", { requiredSinceAt: "2026-10-15T02:00:00Z" })])
    assert.equal(first.accepted, true)
    const reset = await reconcile(db, [gap("availability", "2026-10-16T06:15:00Z", {
      requiredSinceAt: "2026-10-16T02:00:00Z", coveredThroughAt: "2026-10-15T02:00:00Z",
    })], "2026-10-15T03:00:00Z")
    assert.equal(epoch(reset.gaps[0].firstUncoveredAt), epoch("2026-10-15T03:00:00Z"))
    assert.equal(epoch(reset.gaps[0].firstDueAt), epoch("2026-10-16T06:15:00Z"))
  } finally { await db.close() }
})

test("inventory pins its first target and rejects fresh old-head or same-head/wrong-catalog coverage", async () => {
  const db = await fixture()
  try {
    const first = await reconcile(db, [inventory(), gap("availability")])
    for (const [hour, version, fingerprint] of [[1, h2, c2], [2, h3, c3]]) {
      const result = await reconcile(db, [inventory("2026-10-20T00:00:00Z", { requiredVersion: version, requiredFingerprint: fingerprint })], `2026-10-14T0${hour}:00:00Z`, false)
      assert.deepEqual(result.gaps, first.gaps)
      assert.equal((await snapshot(db)).gaps.find(gap => gap.gap_key === "inventory").required_version, h1)
    }
    for (const [hour, coveredVersion, coveredFingerprint] of [[3, "20261014000000", c3], [4, h1, c3]]) {
      const result = await reconcile(db, [inventory("2026-10-20T00:00:00Z", {
        requiredVersion: h2, requiredFingerprint: c2, coveredThroughAt: `2026-10-14T0${hour}:00:00Z`, coveredVersion, coveredFingerprint,
      })], `2026-10-14T0${hour}:30:00Z`, false)
      assert.deepEqual(result.gaps, first.gaps)
    }
    const reset = await reconcile(db, [inventory("2026-10-20T00:00:00Z", {
      requiredVersion: h2, requiredFingerprint: c2, coveredThroughAt: "2026-10-14T05:00:00Z", coveredVersion: h1, coveredFingerprint: c1.toUpperCase(),
    })], "2026-10-14T05:30:00Z", false)
    const renewedGap = reset.gaps.find(item => item.key === "inventory")
    assert.equal(epoch(renewedGap.firstUncoveredAt), epoch("2026-10-14T05:30:00Z"))
    assert.equal(epoch(renewedGap.firstDueAt), epoch("2026-10-20T00:00:00Z"))
    assert.deepEqual(Object.keys(renewedGap).sort(), ["firstDueAt", "firstUncoveredAt", "key"], "internal target metadata is not added to the response")
    const saved = (await snapshot(db)).gaps.find(item => item.gap_key === "inventory")
    assert.equal(saved.required_version, h2); assert.equal(saved.required_fingerprint, c2)
    assert.deepEqual(reset.gaps.find(item => item.key === "availability"), first.gaps.find(item => item.key === "availability"))
  } finally { await db.close() }
})

test("late-published verified inventory covers its pinned catalog, but future-head or reused old-head proof cannot reset", async () => {
  const db = await fixture()
  try {
    const first = await reconcile(db)
    const proof = { requiredVersion: h3, requiredFingerprint: c3, coveredVersion: h2, coveredFingerprint: c2 }
    const futureHead = await reconcile(db, [inventory("2026-10-20T00:00:00Z", { ...proof, requiredVersion: h1, coveredThroughAt: "2026-10-13T23:59:59Z" })], "2026-10-14T01:00:00Z", false)
    assert.deepEqual(futureHead.gaps, first.gaps, "a head beyond the current required target cannot repeatedly reset a restored target")
    const reset = await reconcile(db, [inventory("2026-10-20T00:00:00Z", { ...proof, coveredThroughAt: "2026-10-13T23:59:59Z" })], "2026-10-14T02:00:00Z", false)
    assert.equal(epoch(reset.gaps[0].firstUncoveredAt), epoch("2026-10-14T02:00:00Z"))
    assert.equal((await snapshot(db)).gaps[0].required_version, h3)
    const repeated = await reconcile(db, [inventory("2026-10-21T00:00:00Z", { ...proof, coveredThroughAt: "2026-10-14T03:00:00Z" })], "2026-10-14T04:00:00Z", false)
    assert.deepEqual(repeated.gaps, reset.gaps, "even newly timestamped old-head proof cannot cover the new H3 requirement")
    assert.equal((await snapshot(db)).gaps[0].required_version, h3)
  } finally { await db.close() }
})

test("all invalid input is rejected without creating or changing any state", async () => {
  const db = await fixture()
  try {
    const cases = [
      [null], [{}], [[null]], [[{ key: "UPPER", dueAt: due }]], [[{ key: "a/b", dueAt: due }]],
      [[{ key: "x".repeat(101), dueAt: due }]], [[inventory("infinity")]],
      [[inventory("2026-02-30T00:00:00Z")]], [[inventory("2026-10-13")]],
      [[inventory("2026-10-14T00:00:00+99:99")]], [[inventory("2026-10-14T00:00:00+24:00")]],
      [[inventory(due, { secret: "not-allowed" })]], [[inventory(), inventory()]],
      [[gap("availability", due, { coveredThroughAt: null })]],
      [[gap("availability", due, { coveredThroughAt: "infinity" })]],
      [[gap("availability", due, { coveredThroughAt: "2026-02-30T00:00:00Z" })]],
      [[gap("availability", due, { coveredThroughAt: "2026-10-14T00:00:00+16:00" })]],
      [[gap("availability", due, { coveredThroughAt: "2026-10-14T00:00:00.000001Z" })]],
      [[{ key: "availability", dueAt: due }]], [[gap("availability", due, { requiredSinceAt: null })]],
      [[gap("availability", due, { requiredSinceAt: "infinity" })]], [[gap("availability", due, { requiredSinceAt: "2026-02-30T00:00:00Z" })]],
      [[gap("availability", due, { requiredSinceAt: "2026-10-14T00:00:00-16:00" })]],
      [[{ key: "inventory", dueAt: due }]], [[inventory(due, { requiredVersion: "bad" })]],
      [[inventory(due, { requiredFingerprint: "bad" })]], [[inventory(due, { coveredThroughAt: observation })]],
      [[inventory(due, { requiredSinceAt: observation })]],
      [[inventory(due, { coveredVersion: h1, coveredFingerprint: c1 })]],
      [[inventory(due, { coveredThroughAt: observation, coveredVersion: h1, coveredFingerprint: "bad" })]],
      [[gap("availability", due, { requiredVersion: h1, requiredFingerprint: c1 })]],
      [[gap("opaque-a", due, { coveredVersion: h1, coveredFingerprint: c1 })], observation, true, "drive-file"],
      [Array.from({ length: 10001 }, (_, i) => gap(`x-${i}`))],
      [[], "infinity"], [[], "2999-01-01T00:00:00Z"], [[], observation, null], [[], observation, true, "database-schema"],
    ]
    for (const seeded of [false, true]) {
      if (seeded) await reconcile(db)
      const before = await snapshot(db)
      for (const args of cases) {
        for (const observer of [reconcile, preview]) {
          await assert.rejects(observer(db, ...args), error => error.code === "22023")
          assert.deepEqual(await snapshot(db), before)
        }
      }
    }
  } finally { await db.close() }
})

test("sparse healthy observations never materialize healthy file rows, and max-size batches are accepted", async () => {
  const db = await fixture()
  try {
    for (let hour = 0; hour < 6; hour++) await reconcile(db, [], `2026-10-14T0${hour}:00:00Z`, true, "drive-file")
    assert.equal((await snapshot(db)).parents.length, 1); assert.equal((await snapshot(db)).gaps.length, 0)
    const large = Array.from({ length: 10000 }, (_, i) => gap(`opaque-${i}`, "2026-10-20T00:00:00Z"))
    const saved = await reconcile(db, large, "2026-10-14T06:00:00Z", true, "drive-file")
    assert.equal(saved.gaps.length, 10000)
    const physical = (await db.query("select gap_key,ctid::text as tid from private.backup_protection_gaps order by gap_key")).rows
    assert.deepEqual((await reconcile(db, large, "2026-10-14T07:00:00Z", true, "drive-file")).gaps, saved.gaps)
    assert.deepEqual((await db.query("select gap_key,ctid::text as tid from private.backup_protection_gaps order by gap_key")).rows, physical)
    const beforePreview = await snapshot(db)
    assert.deepEqual((await preview(db, large, "2026-10-14T07:30:00Z", true, "drive-file")).gaps, saved.gaps)
    assert.deepEqual(await snapshot(db), beforePreview)
    assert.equal((await reconcile(db, [], "2026-10-14T08:00:00Z", true, "drive-file")).gaps.length, 0)
  } finally { await db.close() }
})

test("invoker RPC, private RLS tables and minimum grants deny anonymous/authenticated execution and direct access", async () => {
  const db = await fixture()
  try {
    const flags = (await db.query(`select p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') authenticated,
      has_function_privilege('service_role',p.oid,'execute') service
      from pg_proc p where p.oid='public.reconcile_backup_protection_gaps(text,timestamptz,jsonb,boolean)'::regprocedure`)).rows[0]
    assert.deepEqual(flags, { prosecdef: false, proconfig: ['search_path=""'], anon: false, authenticated: false, service: true })
    const readOnlyFlags = (await db.query(`select p.prosecdef,p.proconfig,p.provolatile,
      has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') authenticated,
      has_function_privilege('service_role',p.oid,'execute') service
      from pg_proc p where p.oid in (
        'public.preview_backup_protection_gaps(text,timestamptz,jsonb,boolean)'::regprocedure,
        'private.validate_backup_protection_gaps(text,timestamptz,jsonb,boolean)'::regprocedure,
        'private.backup_protection_gap_is_covered(text,text,timestamptz,text,text,jsonb)'::regprocedure)`)).rows
    assert.equal(readOnlyFlags.length, 3)
    for (const flag of readOnlyFlags) assert.deepEqual(flag, { prosecdef: false, proconfig: ['search_path=""'], provolatile: "s", anon: false, authenticated: false, service: true })
    await db.exec("reset role")
    assert.equal((await db.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in ('backup_protection_observations','backup_protection_gaps') and c.relrowsecurity")).rows[0].n, 2)
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`)
      await assert.rejects(reconcile(db), /permission denied/)
      await assert.rejects(preview(db), /permission denied/)
      await assert.rejects(db.query("select * from private.backup_protection_gaps"), /permission denied/)
      await db.exec("reset role")
    }
    await db.exec("set role service_role"); assert.equal((await reconcile(db)).accepted, true)
    await assert.rejects(db.query("delete from private.backup_protection_observations"), /permission denied/)
  } finally { await db.close() }
})

test("read-only preview projects healthy, new, overdue, recovery and incomplete evidence without materializing or rewriting state", async () => {
  const db = await fixture()
  try {
    const empty = await snapshot(db)
    assert.deepEqual((await preview(db, [])).gaps, [])
    assert.equal((await preview(db)).gaps.length, 1)
    assert.deepEqual(await snapshot(db), empty, "neither healthy nor new-gap preview creates a parent")
    await reconcile(db, [inventory(), gap("availability")])
    const before = await snapshot(db)
    const physical = (await db.query("select gap_key,ctid::text as tid from private.backup_protection_gaps order by gap_key")).rows
    const later = "2026-10-14T03:00:00Z"
    const retained = await preview(db, [inventory("2026-10-20T00:00:00Z")], later, false)
    assert.equal(retained.accepted, true); assert.equal(epoch(retained.observedAt), epoch(later))
    assert.equal(retained.gaps.length, 2)
    assert.equal(epoch(retained.gaps.find(item => item.key === "inventory").firstDueAt), epoch(due))
    assert.deepEqual((await preview(db, [], later, true)).gaps, [])
    assert.deepEqual((await preview(db, [], later, false)).gaps, retained.gaps)
    assert.deepEqual(await snapshot(db), before)
    assert.deepEqual((await db.query("select gap_key,ctid::text as tid from private.backup_protection_gaps order by gap_key")).rows, physical)
  } finally { await db.close() }
})

test("preview and reconcile produce identical projected clocks from cloned initial state across proof and completion cases", async () => {
  const db = await fixture()
  try {
    await reconcile(db, [inventory(), gap("availability")])
    await reconcile(db, [gap("opaque-file", due, { requiredSinceAt: "2026-10-13T07:00:00Z" })], observation, true, "drive-file")
    const before = await snapshot(db), observed = "2026-10-14T09:00:00Z"
    const cases = [
      [[], true, "database"], [[], false, "database"], [[inventory("2026-10-20T00:00:00Z")], true, "database"],
      [[gap("new-gap")], false, "database"], [[inventory("2026-10-12T00:00:00Z")], false, "database"],
      [[inventory("2026-10-20T00:00:00Z", { requiredVersion: h2, requiredFingerprint: c2, coveredThroughAt: "2026-10-13T08:00:00Z", coveredVersion: h1, coveredFingerprint: c1 })], false, "database"],
      [[inventory("2026-10-20T00:00:00Z", { requiredVersion: h2, requiredFingerprint: c2, coveredThroughAt: observation, coveredVersion: h1, coveredFingerprint: c3 })], false, "database"],
      [[gap("opaque-file", "2026-10-20T00:00:00Z", { requiredSinceAt: "2026-10-14T08:00:00Z", coveredThroughAt: "2026-10-13T08:00:00Z" })], false, "drive-file"],
      [[gap("opaque-file", "2026-10-20T00:00:00Z", { requiredSinceAt: "2026-10-14T08:00:00Z", coveredThroughAt: "2026-10-13T06:00:00Z" })], false, "drive-file"],
    ]
    for (const [gaps, complete, domain] of cases) {
      const projected = await preview(db, gaps, observed, complete, domain)
      assert.deepEqual(await snapshot(db), before)
      await db.exec("begin")
      try { assert.deepEqual(await reconcile(db, gaps, observed, complete, domain), projected) }
      finally { await db.exec("rollback") }
      assert.deepEqual(await snapshot(db), before)
    }
  } finally { await db.close() }
})

test("stale preview remains a read-only evidence projection rather than an observation-order acknowledgement", async () => {
  const db = await fixture()
  try {
    await reconcile(db, [gap("availability")], "2026-10-14T09:00:00Z")
    const before = await snapshot(db)
    const projected = await preview(db, [], observation, false)
    assert.equal(projected.accepted, true); assert.equal(epoch(projected.observedAt), epoch(observation))
    assert.equal(epoch(projected.gaps[0].firstUncoveredAt), epoch("2026-10-14T09:00:00Z"))
    assert.equal((await reconcile(db, [], observation, false)).accepted, false)
    assert.deepEqual(await snapshot(db), before)
  } finally { await db.close() }
})
