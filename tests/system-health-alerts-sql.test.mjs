import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"

// Optional real-Postgres integration test, entirely in memory. Install PGlite
// outside the repository and point PGLITE_MODULE_PATH at its dist/index.js to
// run without adding a production or mandatory test dependency. An explicitly
// configured but unavailable module fails rather than silently skipping.
const modulePath = process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite"
const pglite = await import(modulePath).catch((error) => {
  if (!process.env.PGLITE_MODULE_PATH && error.code === "ERR_MODULE_NOT_FOUND") return null
  throw error
})

test("System Health alert migration executes correctly in isolated PostgreSQL", {
  skip: pglite ? false : "Set PGLITE_MODULE_PATH to run optional SQL integration tests",
}, async (t) => {
  const db = new pglite.PGlite()
  const sql = readFileSync(new URL("../supabase/migrations/20260924022019_system_health_alert_incidents.sql", import.meta.url), "utf8")
  const recipientA = "a".repeat(64)
  const recipientB = "b".repeat(64)
  const id = "drive-file-content-backup"
  const start = Date.now() - 86_400_000
  const observation = (level, step, checkId = id) => ({
    check_id: checkId, alert_level: level, observed_at: new Date(start + step * 1000).toISOString(),
  })
  const asRole = async (role, action) => {
    assert.ok(["anon", "authenticated", "service_role"].includes(role))
    await db.exec(`set role ${role}`)
    try { return await action() } finally { await db.exec("reset role") }
  }
  const claim = async (observations, token = randomUUID(), recipient = recipientA) => asRole("service_role", async () => {
    const result = await db.query("select public.claim_system_health_alerts($1::jsonb, $2::uuid, $3::text) as claims", [
      JSON.stringify(observations), token, recipient,
    ])
    return result.rows[0].claims
  })
  const finish = async (token, delivered) => asRole("service_role", () => db.query(
    "select public.finish_system_health_alerts($1::uuid, $2::boolean)", [token, delivered],
  ))
  const state = async (recipient = recipientA) => (await db.query(
    "select * from private.system_health_alert_incidents where check_id = $1 and recipient_key = $2", [id, recipient],
  )).rows[0]
  const reset = () => db.exec("truncate private.system_health_alert_incidents")

  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;")
    await db.exec(sql)

    await t.test("only service_role can execute RPCs or read incident state", async () => {
      for (const role of ["anon", "authenticated"]) {
        await asRole(role, async () => {
          await assert.rejects(db.query("select public.claim_system_health_alerts('[]', $1::uuid, $2)", [randomUUID(), recipientA]), /permission denied/)
          await assert.rejects(db.query("select public.finish_system_health_alerts($1::uuid, true)", [randomUUID()]), /permission denied/)
          await assert.rejects(db.query("select * from private.system_health_alert_incidents"), /permission denied/)
        })
      }
      const result = await db.query("select relrowsecurity from pg_class where oid = 'private.system_health_alert_incidents'::regclass")
      assert.equal(result.rows[0].relrowsecurity, true)
      assert.deepEqual(await claim([]), [])
    })

    await t.test("warning is sent once, escalation once, and recovery rearms it", async () => {
      await reset()
      const warning = randomUUID()
      assert.deepEqual(await claim([observation(1, 1)], warning), [id])
      await finish(warning, true)
      assert.deepEqual(await claim([observation(1, 2)]), [])
      const escalation = randomUUID()
      assert.deepEqual(await claim([observation(2, 3)], escalation), [id])
      await finish(escalation, true)
      assert.deepEqual(await claim([observation(2, 4)]), [])
      assert.deepEqual(await claim([observation(1, 5)]), [])
      assert.equal((await state()).notified_level, 2)
      assert.deepEqual(await claim([observation(0, 6)]), [])
      assert.equal((await state()).incident_open, false)
      assert.deepEqual(await claim([observation(1, 7)]), [id])
    })

    await t.test("each recipient has independent delivery, retry and recovery state", async () => {
      await reset()
      const accepted = randomUUID()
      const rejected = randomUUID()
      assert.deepEqual(await claim([observation(1, 1)], accepted, recipientA), [id])
      assert.deepEqual(await claim([observation(1, 1)], rejected, recipientB), [id])
      await finish(accepted, true)
      await finish(rejected, false)
      assert.equal((await state(recipientA)).notified_level, 1)
      assert.equal((await state(recipientB)).notified_level, 0)
      assert.deepEqual(await claim([observation(1, 2)], randomUUID(), recipientA), [])
      const retry = randomUUID()
      assert.deepEqual(await claim([observation(1, 2)], retry, recipientB), [id])
      await finish(retry, true)
      await claim([observation(0, 3)], randomUUID(), recipientA)
      assert.equal((await state(recipientA)).incident_open, false)
      assert.equal((await state(recipientB)).incident_open, true)
      assert.deepEqual(await claim([observation(1, 4)], randomUUID(), recipientB), [])
    })

    await t.test("in-flight lease prevents duplicate claims and pending observations preserve it", async () => {
      await reset()
      const token = randomUUID()
      assert.deepEqual(await claim([observation(1, 1)], token), [id])
      assert.deepEqual(await claim([observation(1, 2)]), [])
      assert.deepEqual(await claim([observation(null, 3)]), [])
      assert.equal((await state()).claimed_by, token)
      assert.equal((await state()).incident_open, true)
      await finish(token, true)
      assert.deepEqual(await claim([observation(1, 4)]), [])
    })

    await t.test("expired leases may be reclaimed; stale acknowledgement cannot clear a new lease", async () => {
      await reset()
      const oldToken = randomUUID()
      const newToken = randomUUID()
      assert.deepEqual(await claim([observation(1, 1)], oldToken), [id])
      await db.exec("update private.system_health_alert_incidents set claim_expires_at = clock_timestamp() - interval '1 second'")
      assert.deepEqual(await claim([observation(1, 2)], newToken), [id])
      await finish(oldToken, true)
      assert.equal((await state()).claimed_by, newToken)
      assert.equal((await state()).notified_level, 0)
      await finish(newToken, true)
      assert.equal((await state()).notified_level, 1)
    })

    await t.test("older observations cannot resolve or reopen a newer incident", async () => {
      await reset()
      const token = randomUUID()
      assert.deepEqual(await claim([observation(1, 10)], token), [id])
      await finish(token, true)
      await claim([observation(0, 9)])
      assert.equal((await state()).incident_open, true)
      await claim([observation(0, 11)])
      assert.deepEqual(await claim([observation(2, 10)]), [])
      assert.equal((await state()).incident_open, false)
    })

    await t.test("invalid recipient keys and observations fail without partial state writes", async () => {
      await reset()
      for (const recipient of [null, "", "A".repeat(64), "x".repeat(64), "a".repeat(63)]) {
        await assert.rejects(claim([observation(1, 1)], randomUUID(), recipient), /recipient key/)
      }
      await assert.rejects(claim([observation(1, 1), observation(3, 2, "other-check")]), /Invalid health observation/)
      await assert.rejects(claim([observation(1, 1, "bad/id")]), /Invalid health observation/)
      await assert.rejects(claim([{ ...observation(1, 1), observed_at: "infinity" }]), /Invalid health observation/)
      await assert.rejects(claim([{ ...observation(1, 1), observed_at: new Date(Date.now() + 600_000).toISOString() }]), /Invalid health observation/)
      await assert.rejects(claim(Array.from({ length: 101 }, () => observation(1, 1))), /at most 100/)
      assert.equal((await db.query("select count(*)::integer as count from private.system_health_alert_incidents")).rows[0].count, 0)
    })
  } finally {
    await db.close()
  }
})
