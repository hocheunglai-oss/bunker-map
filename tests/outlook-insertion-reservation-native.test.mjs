import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { setupInsertion, reserveSql, certification, fingerprint, json, literal } from "./fixtures/outlook-insertion-native.mjs"
import { waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"

test("native reservation reuses exactly one full verifier proof and retains private RPC metadata", async () => {
  const f = await setupInsertion()
  try {
    const service = await f.session("reservation-service")
    await service.query("set lock_timeout='7s';")
    const result = await service.one(reserveSql(randomUUID()))
    assert.equal(result.reserved, true)
    assert.deepEqual(await service.one("select jsonb_build_object('lockTimeout',current_setting('lock_timeout'));"), { lockTimeout: "7s" }, "reservation-local timeout must not change caller configuration")
    assert.deepEqual(await f.calls(), { count: 1 })
    const verification = await service.one("select public.verify_outlook_template_recipient_truth();")
    assert.deepEqual(verification.exchangeTruth, f.verified)
    const metadata = await f.owner.one(`select jsonb_build_object('functions',jsonb_agg(jsonb_build_object(
      'name',p.proname,'definer',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig,
      'anon',has_function_privilege('anon',p.oid,'execute'),
      'authenticated',has_function_privilege('authenticated',p.oid,'execute'),
      'service',has_function_privilege('service_role',p.oid,'execute')) order by p.proname))
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('reserve_outlook_template_insertion','verify_outlook_template_recipient_truth');`)
    for (const value of metadata.functions) {
      assert.equal(value.anon, false)
      assert.equal(value.authenticated, false)
      assert.equal(value.service, true)
      assert.ok(value.config.includes("search_path=pg_catalog, pg_temp"))
      assert.ok(value.config.includes("statement_timeout=20s"))
      assert.equal(value.definer, value.name !== "reserve_outlook_template_insertion")
      assert.equal(value.volatility, value.name === "reserve_outlook_template_insertion" ? "v" : "s")
    }
  } finally { await f.close() }
})

test("native stale-template business rejection is non-retryable and does not bury the next valid reservation", async () => {
  const f = await setupInsertion()
  try {
    const stale = await f.session("stale-template-business-rejection")
    await assert.rejects(stale.one(reserveSql(randomUUID(), { revision: 2 })), error => {
      assert.match(error.message, /OUTLOOK_INSERTION_TEMPLATE_CHANGED/)
      assert.equal(error.code, "P0001", "business rejection must not use PostgREST transaction-retry SQLSTATE40001")
      return true
    })
    assert.deepEqual(await f.calls(), { count: 0 })
    assert.equal((await f.audit()).count, 0)
    const valid = await f.session("valid-after-business-rejection")
    assert.equal((await valid.one(reserveSql(randomUUID()))).reserved, true)
    assert.deepEqual(await f.calls(), { count: 1 })
    assert.equal((await f.audit()).count, 1)
  } finally { await f.close() }
})

test("native global truth contention is bounded and cannot create an audit or reserve stale proof", async () => {
  const f = await setupInsertion()
  try {
    const blocker = await f.session("truth-writer", false)
    const waiter = await f.session("blocked-reservation")
    await blocker.query("begin; select pg_advisory_xact_lock(913047563612485921::bigint);")
    const start = Date.now()
    const pending = waiter.one(reserveSql(randomUUID()))
    const rejection = assert.rejects(pending, /OUTLOOK_INSERTION_STATE_BUSY/)
    await waitForBlock(f.owner, waiter, blocker, "advisory")
    await rejection
    assert.ok(Date.now() - start >= 1500)
    assert.ok(Date.now() - start < 6000, "lock contention must settle before the RPC network deadline")
    assert.deepEqual(await f.calls(), { count: 0 })
    assert.equal((await f.audit()).count, 0)
    await blocker.query("rollback;")
    const retry = await f.session("unblocked-reservation")
    assert.equal((await retry.one(reserveSql(randomUUID()))).reserved, true)
    assert.equal((await f.audit()).count, 1)
  } finally { await f.close() }
})

test("native concurrent same-operation retries produce one append-only reservation", async () => {
  const f = await setupInsertion({ delay: 0.2 })
  try {
    const first = await f.session("first-reservation")
    const second = await f.session("same-operation-retry")
    const operation = randomUUID()
    await first.query("begin;")
    const initial = await first.one(reserveSql(operation))
    const pending = second.one(reserveSql(operation))
    await waitForBlock(f.owner, second, first, "advisory")
    await first.query("commit;")
    const retry = await pending
    assert.equal(initial.reserved, true)
    assert.equal(initial.idempotent, false)
    assert.equal(retry.idempotent, true)
    assert.equal(retry.auditLogId, initial.auditLogId)
    assert.equal((await f.audit()).count, 1)
    assert.deepEqual(await f.calls(), { count: 2 }, "each reservation independently checks current proof once")
    await first.query(`select public.complete_outlook_template_insertion(${literal(operation)}::uuid,
      'synthetic-template',1,${literal(certification)}::uuid,${literal(fingerprint)},
      'synthetic-user','Synthetic User','inserted');`)
    const completedRetry = await f.session("completed-operation-retry")
    await assert.rejects(completedRetry.one(reserveSql(operation)), /OUTLOOK_INSERTION_OPERATION_COMPLETED/)
    assert.equal((await f.audit()).count, 2)
  } finally { await f.close() }
})

test("native real truth and template failures still fail closed without audit writes", async () => {
  const f = await setupInsertion()
  try {
    const truthFailures = [
      ...["valid", "integrityValid", "ledgerValid", "snapshotsValid", "referencesValid", "latestCertificationHasProjectionEvidence"].map(key => ({ [key]: false })),
      { latestCertificationRunId: randomUUID() }, { latestSourceFingerprint: "b".repeat(64) },
      { latestProjectionSnapshotSha256: "b".repeat(64) },
      { latestCertificationAt: new Date(Date.now() - 37 * 3600000).toISOString() },
      { latestCertificationAt: new Date(Date.now() + 600000).toISOString() },
      { queue: { pending: 0, processing: 0, failed: 1, terminalFailed: 0 } },
      { queue: { pending: 0, processing: 0, failed: 0, terminalFailed: 1 } },
    ]
    for (const [index, changes] of truthFailures.entries()) {
      await f.owner.query(`update private.synthetic_exchange_truth set value=${json({ ...f.verified, ...changes })};`)
      const service = await f.session(`invalid-truth-${index}`)
      await assert.rejects(service.one(reserveSql(randomUUID())), /OUTLOOK_INSERTION_TRUTH_STALE/)
      assert.equal((await f.audit()).count, 0)
    }
    await f.owner.query(`update private.synthetic_exchange_truth set value=${json(f.verified)};`)
    for (const [index, changes] of [{ revision: 2 }, { template: "missing-template" }, { actor: "" }, { age: 1 }].entries()) {
      const service = await f.session(`invalid-template-${index}`)
      await assert.rejects(service.one(reserveSql(randomUUID(), changes)), /OUTLOOK_INSERTION_(TEMPLATE_CHANGED|RESERVATION_INVALID)/)
      assert.equal((await f.audit()).count, 0)
    }
  } finally { await f.close() }
})

test("native idempotency conflicts, expiry and completed operations remain blocked", async () => {
  const f = await setupInsertion()
  try {
    const service = await f.session("initial-idempotency")
    const operation = randomUUID()
    await service.one(reserveSql(operation))
    const conflict = await f.session("conflicting-actor")
    await assert.rejects(conflict.one(reserveSql(operation, { actor: "different-user" })), /OUTLOOK_INSERTION_OPERATION_CONFLICT/)
    // Only the isolated fixture owner bypasses the production append-only trigger
    // to construct an immutable old reservation; service_role cannot do this.
    await f.owner.query(`alter table public.audit_logs disable trigger user;
      update public.audit_logs set occurred_at=clock_timestamp()-interval '121 seconds' where record_pk->>'operationId'=${literal(operation)};
      alter table public.audit_logs enable trigger user;`)
    const expired = await f.session("expired-operation")
    await assert.rejects(expired.one(reserveSql(operation)), /OUTLOOK_INSERTION_RESERVATION_EXPIRED/)
    assert.equal((await f.audit()).count, 1)
  } finally { await f.close() }
})
