import assert from "node:assert/strict"
import test from "node:test"
import { setupInsertion, json } from "./fixtures/outlook-insertion-native.mjs"

test("native combined backup evidence computes one full proof per fresh invocation and retains invalid evidence", async () => {
  // Execute the real deployed template-verifier SQL in an isolated PostgreSQL
  // fixture. Only its underlying ledger input/counter is synthetic. This proves
  // the nesting contract used by the actual-route orchestration tests without
  // invoking any hosted function or relaxing production integrity checks.
  const f = await setupInsertion()
  try {
    const service = await f.session("backup-combined-proof")
    const first = { ...f.verified, operationallyConsistent: true,
      headSequence: 11, headSha256: "b".repeat(64), ledgerEntries: 11, snapshots: 3 }
    await f.owner.query(`update private.synthetic_exchange_truth set value=${json(first)};`)
    const before = await service.one("select public.verify_outlook_template_recipient_truth();")
    assert.equal(before.valid, true)
    assert.deepEqual(before.exchangeTruth, first)
    assert.deepEqual(await f.calls(), { count: 1 })

    const second = { ...first, headSequence: 12, headSha256: "c".repeat(64), ledgerEntries: 12 }
    await f.owner.query(`update private.synthetic_exchange_truth set value=${json(second)};`)
    const after = await service.one("select public.verify_outlook_template_recipient_truth();")
    assert.equal(after.valid, true)
    assert.deepEqual(after.exchangeTruth, second, "the after-export invocation must not return the earlier proof")
    assert.notDeepEqual(before.exchangeTruth, after.exchangeTruth)
    assert.deepEqual(await f.calls(), { count: 2 })

    const invalid = { ...second, snapshotsValid: false }
    await f.owner.query(`update private.synthetic_exchange_truth set value=${json(invalid)};`)
    const rejected = await service.one("select public.verify_outlook_template_recipient_truth();")
    assert.equal(rejected.valid, false)
    assert.deepEqual(rejected.exchangeTruth, invalid, "a broken nested proof cannot become a successful template proof")
    assert.deepEqual(await f.calls(), { count: 3 })
    assert.equal((await f.audit()).count, 0, "proof reads create no business audit writes")
  } finally { await f.close() }
})
