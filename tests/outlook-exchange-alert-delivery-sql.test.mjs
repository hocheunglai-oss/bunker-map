import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"

// No cloud access or production data. Native mode uses the existing owned
// PostgreSQL 17.6 Unix-socket fixture; normal optional runs retain PGlite.
const nativeRequested = Boolean(process.env.NATIVE_PG_BIN)
const modulePath = process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite"
const pglite = nativeRequested ? null : await import(modulePath).catch((error) => {
  if (!process.env.PGLITE_MODULE_PATH && error.code === "ERR_MODULE_NOT_FOUND") return null
  throw error
})

async function database() {
  if (!nativeRequested) return new pglite.PGlite()
  const { setupNativeCcinfo, literal } = await import("./fixtures/native-postgres-ccinfo.mjs")
  const fixture = await setupNativeCcinfo("")
  let role = null
  let sequence = 0
  const execute = async (sql, rows = false) => {
    // A rejected query ends its psql connection. Give every operation its own
    // real backend so rejection tests cannot leave a broken owner session or
    // silently skip the role checks which follow it.
    const session = await fixture.session(`exchange-alert-${++sequence}`, false)
    try {
      if (role) await session.query(`set role ${role};`)
      return rows
        ? await session.one(`select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (${sql}) r;`)
        : await session.query(sql)
    } finally { await session.close() }
  }
  return {
    native: { root: fixture.root, version: fixture.version, runtimeSha256: fixture.runtimeSha256 },
    async exec(sql) {
      const set = sql.match(/^set role (service_role|anon|authenticated)$/)
      if (set) { role = set[1]; return }
      if (sql === "reset role") { role = null; return }
      await execute(sql)
    },
    async query(sql, parameters = []) {
      const bound = sql.replace(/\$(\d+)\b/g, (_, index) => {
        const value = parameters[Number(index) - 1]
        assert.notEqual(value, undefined, `Missing native SQL parameter ${index}`)
        return value === null ? "null" : typeof value === "boolean" ? String(value) : literal(value)
      })
      return { rows: await execute(bound, /^\s*select\b/i.test(bound)) }
    },
    close: () => fixture.close(),
  }
}

test(`Exchange email delivery policy in isolated ${nativeRequested ? "native PostgreSQL 17.6" : "PostgreSQL"}`, {
  skip: nativeRequested || pglite ? false : "Set PGLITE_MODULE_PATH or NATIVE_PG_BIN to run SQL integration tests",
  timeout: 120000,
}, async (t) => {
  const db = await database()
  if (db.native) t.diagnostic(`Owned native cluster: ${JSON.stringify(db.native)}`)
  const sql = readFileSync(new URL("../supabase/migrations/20261007065554_outlook_exchange_alert_delivery.sql", import.meta.url), "utf8")
  t.diagnostic(`Exact production alert SQL SHA-256: ${createHash("sha256").update(sql).digest("hex")}`)
  const key = "a".repeat(64)
  const keyB = "b".repeat(64)
  const incident = (immediate = true, id = key, kind = "service_access") => ({ key: id, kind, immediate })
  const storeKey = (scope = "incremental") => `outlook-addressbook-exchange-alerts:${scope}`
  const asRole = async (role, action) => {
    assert.ok(["service_role", "anon", "authenticated"].includes(role))
    await db.exec(`set role ${role}`)
    try { return await action() } finally { await db.exec("reset role") }
  }
  const observe = async (incidents = [incident()], { run = randomUUID(), scope = "incremental", recovered = false, observationComplete = false } = {}) => asRole("service_role", async () => {
    const result = await db.query("select public.observe_outlook_exchange_alert($1::uuid, $2::text, $3::jsonb, $4::boolean, $5::boolean) as result", [run, scope, JSON.stringify(incidents), recovered, observationComplete])
    return result.rows[0].result
  })
  const complete = (claim, delivered = true, scope = "incremental") => asRole("service_role", async () => {
    const result = await db.query("select public.complete_outlook_exchange_alert($1::text, $2::uuid, $3::boolean) as result", [scope, claim, delivered])
    return result.rows[0].result
  })
  const state = async (scope = "incremental") => (await db.query("select payload from public.office_calendar_store where key = $1", [storeKey(scope)])).rows[0]?.payload
  const reset = () => db.exec("truncate public.office_calendar_store")
  const ageIncident = (id = key, age = "46 minutes", scope = "incremental") => db.query(
    "update public.office_calendar_store set payload = jsonb_set(payload, array['incidents', $2, 'firstSeen'], to_jsonb(clock_timestamp() - $3::interval)) where key = $1", [storeKey(scope), id, age],
  )
  const expireClaim = (scope = "incremental") => db.query(
    "update public.office_calendar_store set payload = jsonb_set(payload, '{claim,expiresAt}', to_jsonb(clock_timestamp() - interval '1 second')) where key = $1", [storeKey(scope)],
  )

  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table public.office_calendar_store (key text primary key, payload jsonb not null, updated_at timestamptz not null default now());
      alter table public.office_calendar_store enable row level security;
      grant select, insert, update, delete on public.office_calendar_store to service_role;
    `)
    await db.exec(sql)

    await t.test("service-only invoker RPCs keep table RLS and browser-role boundaries", async () => {
      for (const role of ["anon", "authenticated"]) {
        await asRole(role, async () => {
          await assert.rejects(db.query("select public.observe_outlook_exchange_alert($1, 'incremental', '[]', false)", [randomUUID()]), /permission denied/)
          await assert.rejects(db.query("select public.complete_outlook_exchange_alert('incremental', $1, true)", [randomUUID()]), /permission denied/)
          await assert.rejects(db.query("select * from public.office_calendar_store"), /permission denied/)
        })
      }
      const functions = await db.query("select prosecdef, proconfig from pg_proc where proname in ('observe_outlook_exchange_alert', 'complete_outlook_exchange_alert')")
      assert.equal(functions.rows.length, 2)
      for (const row of functions.rows) {
        assert.equal(row.prosecdef, false)
        assert.ok(row.proconfig.includes("search_path=pg_catalog, public"))
      }
      assert.equal((await db.query("select relrowsecurity from pg_class where oid = 'public.office_calendar_store'::regclass")).rows[0].relrowsecurity, true)
    })

    await t.test("an actionable problem emails once, and only a new problem emails again", async () => {
      await reset()
      const first = await observe()
      assert.equal(first.shouldNotify, true)
      assert.deepEqual(first.incidentKeys, [key])
      assert.equal((await complete(first.claimId)).reason, "delivered")
      assert.equal((await observe()).reason, "already_notified")
      const next = await observe([incident(), incident(true, keyB, "contact_correction")])
      assert.equal(next.shouldNotify, true)
      assert.deepEqual(next.incidentKeys, [keyB])
      assert.ok((await state()).incidents[key].notifiedAt)
      assert.equal((await state()).incidents[keyB].notifiedAt, undefined)
    })

    await t.test("a delivered full-sync incident stays silent across calendar days and new run IDs", async () => {
      await reset()
      const originalRun = randomUUID()
      const fullIncident = incident(true, key, "verification")
      const first = await observe([fullIncident], { run: originalRun, scope: "full" })
      await complete(first.claimId, true, "full")
      // Move only synthetic retained history into the past; no real clock,
      // delivery state or production setting is changed by this fixture.
      await db.query(`update public.office_calendar_store set payload =
        jsonb_set(jsonb_set(jsonb_set(payload,
          array['incidents', $2, 'firstSeen'], to_jsonb(clock_timestamp() - interval '4 days')),
          array['incidents', $2, 'lastSeen'], to_jsonb(clock_timestamp() - interval '3 days')),
          array['incidents', $2, 'notifiedAt'], to_jsonb(clock_timestamp() - interval '3 days'))
        where key = $1`, [storeKey("full"), key])
      const notifiedAt = (await state("full")).incidents[key].notifiedAt
      for (const run of [originalRun, randomUUID(), randomUUID()]) {
        const next = await observe([fullIncident], { run, scope: "full" })
        assert.deepEqual(next, { shouldNotify: false, claimId: null, incidentKeys: [], reason: "already_notified" })
        assert.equal((await state("full")).incidents[key].notifiedAt, notifiedAt)
      }
      assert.equal((await state("full")).incidents[key].distinctRuns, 2)
      assert.equal((await state("full")).incidents[key].firstRunId, originalRun)
      assert.equal((await state("full")).claim, undefined)
    })

    await t.test("missing full-sync proof does not rearm yesterday's incident, but verified recovery does", async () => {
      await reset()
      const fullIncident = incident(true, key, "verification")
      const first = await observe([fullIncident], { scope: "full" })
      await complete(first.claimId, true, "full")
      await ageIncident(key, "3 days", "full")
      assert.equal((await observe([], { scope: "full" })).reason, "no_current_issue")
      assert.ok((await state("full")).incidents[key].notifiedAt)
      assert.equal((await observe([fullIncident], { scope: "full" })).reason, "already_notified")
      // A healthy incremental observation cannot prove full reconciliation.
      await observe([], { recovered: true, scope: "incremental" })
      assert.equal((await observe([fullIncident], { scope: "full" })).shouldNotify, false)
      await observe([], { recovered: true, scope: "full" })
      const recurrence = await observe([fullIncident], { scope: "full" })
      assert.equal(recurrence.shouldNotify, true)
      assert.deepEqual(recurrence.incidentKeys, [key])
      assert.notEqual(recurrence.claimId, first.claimId)
      assert.equal((await state("full")).incidents[key].distinctRuns, 1)
    })

    await t.test("a previously delivered verification issue cannot hide a separate new access failure", async () => {
      await reset()
      const verification = incident(true, key, "verification")
      const first = await observe([verification], { scope: "full" })
      await complete(first.claimId, true, "full")
      await ageIncident(key, "3 days", "full")
      const independent = await observe([verification, incident(true, keyB, "service_access")], { scope: "full" })
      assert.equal(independent.shouldNotify, true)
      assert.deepEqual(independent.incidentKeys, [keyB])
      await complete(independent.claimId, true, "full")
      assert.equal((await observe([verification, incident(true, keyB, "service_access")], { scope: "full" })).reason, "already_notified")
    })

    await t.test("temporary failures need two distinct runs and at least 45 minutes", async () => {
      await reset()
      const run = randomUUID()
      assert.equal((await observe([incident(false)], { run })).reason, "waiting_for_persistence")
      await ageIncident()
      assert.equal((await observe([incident(false)], { run })).shouldNotify, false)
      assert.equal((await state()).incidents[key].distinctRuns, 1)
      const persistent = await observe([incident(false)])
      assert.equal(persistent.shouldNotify, true)
      assert.equal((await state()).incidents[key].distinctRuns, 2)

      await reset()
      await observe([incident(false)])
      assert.equal((await observe([incident(false)])).shouldNotify, false)
      await ageIncident(key, "44 minutes")
      assert.equal((await observe([incident(false)])).shouldNotify, false)
      await ageIncident(key, "45 minutes")
      assert.equal((await observe([incident(false)])).shouldNotify, true)
    })

    await t.test("healthy verified runs rearm; unknown and missing observations do not", async () => {
      await reset()
      const first = await observe()
      await complete(first.claimId)
      assert.equal((await observe([])).reason, "no_current_issue")
      assert.ok((await state()).incidents[key].notifiedAt)
      assert.equal((await observe()).shouldNotify, false)
      assert.equal((await observe([], { recovered: true })).reason, "recovered")
      assert.deepEqual((await state()).incidents, {})
      assert.equal((await observe()).shouldNotify, true)
    })

    await t.test("healthy recovery discards a temporary incident without ever emailing", async () => {
      await reset()
      await observe([incident(false)])
      await ageIncident()
      await observe([], { recovered: true })
      assert.equal((await observe([incident(false)])).shouldNotify, false)
      assert.equal((await state()).incidents[key].distinctRuns, 1)
    })

    await t.test("complete observation resolves one transient incident while another issue remains", async () => {
      await reset()
      await observe([incident(false)])
      await ageIncident(key, "2 days")
      const other = await observe([incident(true, keyB, "contact_correction")], { observationComplete: true })
      await complete(other.claimId)
      assert.equal((await state()).incidents[key], undefined)
      assert.ok((await state()).incidents[keyB].notifiedAt)

      // Fresh isolated failure must start a new grace period, not inherit the
      // old two-day clock; the unrelated notified contact is still retained.
      const again = await observe([incident(false)])
      assert.equal(again.reason, "waiting_for_persistence")
      assert.equal((await state()).incidents[key].distinctRuns, 1)
      assert.ok((await state()).incidents[keyB].notifiedAt)
      await ageIncident()
      assert.equal((await observe([incident(false)])).shouldNotify, true)
    })

    await t.test("complete observation rearms a previously notified issue without global recovery", async () => {
      await reset()
      const first = await observe([incident(), incident(true, keyB)])
      await complete(first.claimId)
      await observe([incident(true, keyB)], { observationComplete: true })
      assert.equal((await state()).incidents[key], undefined)
      const recurrence = await observe([incident(), incident(true, keyB)], { observationComplete: true })
      assert.deepEqual(recurrence.incidentKeys, [key])
    })

    await t.test("complete observation prunes claimed resolved keys without acknowledging a recurrence", async () => {
      await reset()
      const first = await observe([incident(), incident(true, keyB)])
      assert.equal((await observe([incident(true, keyB)], { observationComplete: true })).reason, "delivery_in_progress")
      assert.equal((await state()).claim.id, first.claimId)
      assert.deepEqual((await state()).claim.incidentKeys, [keyB])

      // A recurs while B's old email is still in flight. Its old acknowledgement
      // must only mark B, never this new occurrence of A.
      await observe([incident(), incident(true, keyB)])
      await complete(first.claimId)
      assert.equal((await state()).incidents[key].notifiedAt, undefined)
      assert.ok((await state()).incidents[keyB].notifiedAt)
      assert.deepEqual((await observe([incident(), incident(true, keyB)])).incidentKeys, [key])
    })

    await t.test("complete observation fences an entirely resolved claim before a different notification", async () => {
      await reset()
      const first = await observe()
      const replacement = await observe([incident(true, keyB)], { observationComplete: true })
      assert.equal(replacement.shouldNotify, true)
      assert.notEqual(replacement.claimId, first.claimId)
      assert.equal((await complete(first.claimId)).reason, "claim_not_found")
      assert.equal((await state()).claim.id, replacement.claimId)
      assert.equal((await state()).incidents[keyB].notifiedAt, undefined)
    })

    await t.test("default four-argument observation remains partial for compatibility", async () => {
      await reset()
      const first = await observe()
      await complete(first.claimId)
      await asRole("service_role", () => db.query("select public.observe_outlook_exchange_alert($1, 'incremental', '[]', false)", [randomUUID()]))
      assert.ok((await state()).incidents[key].notifiedAt)
    })

    await t.test("active claims survive observations and prevent competing deliveries", async () => {
      await reset()
      const first = await observe()
      const second = await observe([incident(), incident(true, keyB)])
      assert.deepEqual(second, { shouldNotify: false, claimId: null, incidentKeys: [], reason: "delivery_in_progress" })
      assert.equal((await state()).claim.id, first.claimId)
      await complete(first.claimId)
      const next = await observe([incident(), incident(true, keyB)])
      assert.deepEqual(next.incidentKeys, [keyB])
    })

    await t.test("failed transport releases the claim without marking successful delivery", async () => {
      await reset()
      const first = await observe()
      assert.equal((await complete(first.claimId, false)).reason, "released")
      assert.equal((await state()).incidents[key].notifiedAt, undefined)
      // Retry of the receipt is idempotent and cannot turn failure into success.
      assert.deepEqual(await complete(first.claimId, true), { accepted: true, delivered: false, reason: "already_completed" })
      const retry = await observe()
      assert.equal(retry.shouldNotify, true)
      assert.notEqual(retry.claimId, first.claimId)
      assert.equal((await complete(first.claimId, true)).reason, "already_completed")
      assert.equal((await state()).claim.id, retry.claimId)
    })

    await t.test("expired claims recover and stale acknowledgements cannot mark another delivery", async () => {
      await reset()
      const first = await observe()
      await expireClaim()
      assert.equal((await complete(first.claimId)).reason, "claim_expired")
      const retry = await observe()
      assert.equal(retry.shouldNotify, true)
      assert.notEqual(retry.claimId, first.claimId)
      assert.equal((await complete(first.claimId)).reason, "claim_not_found")
      assert.equal((await state()).claim.id, retry.claimId)
      assert.equal((await state()).incidents[key].notifiedAt, undefined)
      await complete(retry.claimId)
      assert.equal((await observe()).shouldNotify, false)
    })

    await t.test("recovery fences stale completion even when the same hash recurs", async () => {
      await reset()
      const first = await observe()
      await observe([], { recovered: true })
      assert.equal((await complete(first.claimId)).reason, "claim_not_found")
      const next = await observe()
      assert.equal((await complete(first.claimId)).reason, "claim_not_found")
      assert.equal((await state()).claim.id, next.claimId)
      assert.equal((await state()).incidents[key].notifiedAt, undefined)
    })

    await t.test("incremental recovery cannot clear full-sync incidents", async () => {
      await reset()
      const full = await observe([incident()], { scope: "full" })
      await complete(full.claimId, true, "full")
      await observe([], { recovered: true })
      assert.ok((await state("full")).incidents[key].notifiedAt)
      assert.equal((await observe([incident()], { scope: "full" })).shouldNotify, false)
      assert.equal((await complete(full.claimId, true, "incremental")).reason, "claim_not_found")
    })

    await t.test("invalid arguments fail atomically without state resets or PII storage", async () => {
      await reset()
      for (const input of [null, {}, [incident(), incident()], [{ ...incident(), key: "contact@example.com" }], [{ ...incident(), kind: "someone@example.com" }], [{ ...incident(), immediate: "true" }], [{ ...incident(), error: "secret" }], [{ key, immediate: true }], Array.from({ length: 1001 }, () => incident())]) {
        await assert.rejects(observe(input), /Exchange|Recovery/)
      }
      await assert.rejects(observe([], { scope: "other" }), /Invalid Exchange/)
      await assert.rejects(observe([], { scope: null }), /Invalid Exchange/)
      await assert.rejects(observe([], { run: null }), /Invalid Exchange/)
      await assert.rejects(observe([incident()], { recovered: true }), /Recovery/)
      await assert.rejects(observe([], { recovered: null }), /Invalid Exchange/)
      await assert.rejects(observe([], { observationComplete: null }), /Invalid Exchange/)
      assert.equal(await state(), undefined)
      const first = await observe()
      const before = await state()
      await assert.rejects(observe([incident(true, keyB), incident(true, key, "verification")]), /stable incident key/)
      assert.deepEqual(await state(), before)
      await complete(first.claimId)
      const payload = JSON.stringify(await state())
      assert.ok(!payload.includes("secret") && !payload.includes("@"))
    })

    await t.test("corrupt history fails closed instead of resending old notifications", async () => {
      await reset()
      await db.query("insert into public.office_calendar_store(key,payload) values ($1, '{\"version\":0,\"incidents\":{}}')", [storeKey()])
      await assert.rejects(observe(), /history is invalid/)
      await assert.rejects(complete(randomUUID()), /history is invalid/)
      assert.equal((await state()).version, 0)
    })
  } finally {
    await db.close()
  }
})
