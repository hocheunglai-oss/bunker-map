import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createSpcStemRoute, enquiry, stemPayload, users } from "./fixtures/spc-stem-api.mjs"
import { currentSpcWriteDefinition } from "./fixtures/spc-write-conflicts-sql.mjs"

function harness(options: Record<string, unknown> = {}) {
  const calls: Array<Record<string, unknown>> = []
  const headers: Array<Record<string, string>> = []
  const saved = structuredClone(enquiry)
  const client = {
    from(table: string) {
      assert.equal(table, "spc_enquiries")
      const query = {
        select() { return query },
        eq() { return query },
        async single() { return { data: saved, error: null } },
      }
      return query
    },
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, "stem_spc_enquiry_with_fixture")
      calls.push(args)
      if (options.rpcError) return { data: null, error: options.rpcError }
      const acknowledgement = [{ ...saved, status: "quoted", notes: args.p_notes || saved.notes,
        stem_request_id: args.p_request_id, stem_source_updated_at: args.p_expected_updated_at, stem_supplier_username: args.p_supplier_username }]
      return { data: typeof options.ack === "function" ? options.ack(acknowledgement) : acknowledgement, error: null }
    },
  }
  const app = createSpcStemRoute({
    ...options,
    createClient: (context: Record<string, string>) => { headers.push(context); return client },
  })
  return { ...app, calls, headers, saved }
}

test("actual STEM API fails before any RPC when user preparation is unavailable or supplier is invalid", async () => {
  for (const options of [
    { userLookupError: new Error("Injected user lookup outage") },
    { userOptions: users.filter((user) => !user.isSupplierTrader) },
  ]) {
    const app = harness(options)
    const response = await app.patch()
    assert.equal(response.status, options.userLookupError ? 500 : 400)
    assert.equal(app.calls.length, 0)
    assert.deepEqual(app.saved, enquiry)
  }
})

test("actual STEM API requires edit permission, ownership, source version and operation UUID", async () => {
  for (const [options, status] of [[{ actor: null }, 401], [{ permission: "view" }, 403]] as const) {
    const app = harness(options)
    assert.equal((await app.patch()).status, status)
    assert.equal(app.calls.length, 0)
    assert.equal(app.headers.length, 0)
  }
  const foreign = harness({ actor: { username: "foreign@example.test", userId: users[2].id, role: "BUYER TRADER", displayName: "Foreign" } })
  assert.equal((await foreign.patch()).status, 403)
  assert.equal(foreign.calls.length, 0)
  for (const payload of [stemPayload({ expectedUpdatedAt: "" }), stemPayload({ stemRequestId: "" }), stemPayload({ expectedUpdatedAt: "not a date" }), stemPayload({ stemRequestId: "not a UUID" })]) {
    const app = harness()
    assert.equal((await app.patch(payload)).status, 400)
    assert.equal(app.calls.length, 0)
  }
})

test("actual STEM API makes one audited aggregate RPC with exact microsecond version and canonical names", async () => {
  const app = harness()
  const response = await app.patch()
  assert.equal(response.status, 200)
  assert.equal(response.body.enquiry.status, "quoted")
  assert.equal(response.body.enquiry.meta.stemSupplierTraderDisplayName, users[1].displayName)
  assert.equal(app.calls.length, 1)
  assert.equal(app.calls[0].p_expected_updated_at, enquiry.updated_at)
  assert.equal(app.headers[0]["x-bunker-audit-actor-user-id"], users[0].id)
  assert.equal(app.headers[0]["x-bunker-audit-action"], "set-enquiry-stem")
  assert.equal(app.headers[0]["x-bunker-admin-user"], `spc:${users[0].username}`)
  assert.deepEqual(app.saved, enquiry, "the JavaScript store performs no standalone write")
})

test("actual STEM API maps transactional conflict, invalid input and ownership errors to actionable HTTP statuses", async () => {
  for (const [code, status] of [["40001", 500], ["22023", 400], ["42501", 403]] as const) {
    const app = harness({ rpcError: { code, message: "Synthetic transaction rejected" } })
    assert.equal((await app.patch()).status, status)
    assert.equal(app.calls.length, 1)
    assert.deepEqual(app.saved, enquiry)
  }
})

test("actual STEM API rejects incomplete, foreign or mismatched receipt acknowledgements without claiming success", async () => {
  type Ack = (rows: Array<Record<string, unknown>>) => unknown
  const acknowledgements: Ack[] = [() => null, () => [], () => [{}], rows => [...rows, ...rows],
    rows => [{ ...rows[0], id: "foreign" }], rows => [{ ...rows[0], status: "sent" }],
    rows => [{ ...rows[0], stem_request_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }],
    rows => [{ ...rows[0], stem_source_updated_at: "2026-10-14T01:02:03.123455Z" }],
    rows => [{ ...rows[0], stem_supplier_username: "foreign@example.test" }],
    rows => [{ ...rows[0], stem_request_id: 1 }], rows => [{ ...rows[0], stem_supplier_username: null }],
    rows => [{ ...rows[0], created_by_username: "foreign@example.test" }]]
  for (const ack of acknowledgements) {
    const app = harness({ ack }), response = await app.patch()
    assert.equal(response.status, 500)
    assert.match(response.body.message, /verified saved enquiry.*Refresh/)
    assert.deepEqual(app.saved, enquiry)
  }
  // PostgREST normalizes timestamptz offsets, but must not lose microseconds.
  const equivalent: Ack = rows => [{ ...rows[0], stem_source_updated_at: "2026-10-14T09:02:03.123456+08:00" }]
  assert.equal((await harness({ ack: equivalent }).patch()).status, 200)
})

test("STEM UI captures source version and keeps a stable UUID on retry; changing supplier creates a distinct operation", () => {
  const source = readFileSync(new URL("../app/spc/enquiries/page.tsx", import.meta.url), "utf8")
  assert.match(source, /expectedUpdatedAt: enquiry\.updatedAt/)
  assert.match(source, /const operation = \{ \.\.\.outcomeDraft \}/)
  assert.match(source, /stemRequestId: operation\.stemRequestId/)
  assert.match(source, /expectedUpdatedAt: operation\.expectedUpdatedAt/)
  assert.match(source, /current\?\.stemRequestId === operation\.stemRequestId \? null : current/)
  assert.match(source, /supplierTraderUsername: event\.target\.value, stemRequestId: crypto\.randomUUID\(\)/)
})

test("fresh SPC schema and forward migration define the identical atomic STEM boundary", () => {
  const baseline = readFileSync(new URL("../supabase/spc_schema.sql", import.meta.url), "utf8")
  assert.ok(baseline.includes(currentSpcWriteDefinition("stem_spc_enquiry_with_fixture")))
})

test("actual legacy fixture-note API rejects old clients without an exact saved source version", async () => {
  const app = harness()
  const response = await app.patch({ id: enquiry.id, mode: "fixture", fixture: { supplier: "SYNTHETIC SUPPLIER" } })
  assert.equal(response.status, 400)
  assert.match(response.body.message, /Refresh this enquiry.*saved version is required/)
  assert.equal(app.headers.length, 0)
  assert.deepEqual(app.saved, enquiry)
  assert.equal((await harness({ permission: "view" }).patch({ id: enquiry.id, mode: "fixture", expectedUpdatedAt: enquiry.updated_at, fixture: {} })).status, 403)
})
