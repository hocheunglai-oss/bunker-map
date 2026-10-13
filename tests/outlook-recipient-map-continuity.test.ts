import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import { isCertifiedRecipientProjectionAvailable } from "../lib/outlookRecipientMapAvailability"

const source = readFileSync(new URL("../app/api/outlook-addin/recipient-map/route.ts", import.meta.url), "utf8")
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
const fingerprint = "a".repeat(64)
const projection = {
  contacts: [{ sourceContactId: "synthetic-contact", displayName: "Certified Contact", externalEmailAddress: "certified@example.invalid" }],
  groups: [{ sourceGroupId: "synthetic-group", groupName: "Certified Group", alias: "certified-group", smtpAddress: "certified-group@example.invalid", memberCount: 1 }],
}
function fixture(overrides: Record<string, unknown> = {}, permissionError?: "Unauthorized" | "Forbidden") {
  const truth = {
    valid: true, integrityValid: true, ledgerValid: true, snapshotsValid: true, referencesValid: true,
    operationallyConsistent: true, latestCertificationHasProjectionEvidence: true,
    latestCertificationRunId: "11111111-1111-4111-8111-111111111111",
    latestCertificationAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    latestSourceFingerprint: fingerprint, latestProjectionSnapshotSha256: fingerprint,
    queue: { pending: 0, processing: 0, failed: 0, terminalFailed: 0 }, ...overrides,
  }
  const calls = { rpc: 0, snapshots: 0, permissions: [] as string[][] }
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "@/lib/outlookRecipientMapAvailability": { isCertifiedRecipientProjectionAvailable },
    "@/lib/adminAuth": { requireOutlookAddinPagePermissionForRequest: async (_request: Request, ...permission: string[]) => {
      calls.permissions.push(permission)
      if (permissionError) throw new Error(permissionError)
    } },
    "@supabase/supabase-js": { createClient(url: string, key: string) {
      assert.equal(url, "https://database-fixture.invalid")
      assert.equal(key, "synthetic-service-key")
      return {
        async rpc(name: string) {
          assert.equal(name, "verify_outlook_exchange_truth_ledger", "recipient reads never reserve, dispatch, complete or modify sync work")
          calls.rpc += 1
          return { data: truth, error: null }
        },
        from(table: string) {
          assert.equal(table, "outlook_exchange_truth_snapshots")
          const query = {
            select() { return query },
            eq(column: string, value: string) {
              assert.equal(value, column === "snapshot_kind" ? "fcuno_exchange_projection" : fingerprint)
              return query
            },
            async maybeSingle() {
              calls.snapshots += 1
              return { data: { snapshot_sha256: fingerprint, snapshot_kind: "fcuno_exchange_projection", schema_version: 1, canonical_json: JSON.stringify(projection), created_at: truth.latestCertificationAt }, error: null }
            },
          }
          return query
        },
      }
    } },
  }
  const exports: { GET?: (request: Request) => Promise<Response> } = {}
  vm.runInNewContext(output, {
    exports, Error, Date, process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://database-fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key" } },
    require(name: string) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
    fetch() { throw new Error("External network is forbidden in the recipient-map fixture") },
  })
  return { calls, get: () => exports.GET!(new Request("https://app-fixture.invalid/api/outlook-addin/recipient-map")) }
}

test("certified recipients remain usable throughout pending, processing and mixed hourly sync work", async () => {
  for (const queue of [
    { pending: 1, processing: 0, failed: 0, terminalFailed: 0 },
    { pending: 0, processing: 1, failed: 0, terminalFailed: 0 },
    { pending: 15, processing: 2, failed: 0, terminalFailed: 0 },
  ]) {
    const f = fixture({ operationallyConsistent: false, queue })
    const response = await f.get()
    assert.equal(response.status, 200)
    assert.match(response.headers.get("cache-control") || "", /private.*no-store/)
    const payload = await response.json()
    assert.equal(payload.schema, "fcuno.outlook-certified-recipient-map/v2")
    assert.equal(payload.recipientsBySourceKey["contact:synthetic-contact"].emailAddress, "certified@example.invalid")
    assert.equal(payload.recipientsBySourceKey["group:synthetic-group"].emailAddress, "certified-group@example.invalid")
    assert.equal(payload.certification.sourceFingerprint, fingerprint)
    assert.equal(payload.counts.mappedSourceIds, 2)
    assert.deepEqual(f.calls.permissions, [["email-templates", "view"]])
    assert.equal(f.calls.rpc, 1)
    assert.equal(f.calls.snapshots, 1)
  }
})

test("real failed work and invalid or stale certification remain blocked without fabricating recipients", async () => {
  for (const overrides of [
    { queue: { pending: 0, processing: 0, failed: 1, terminalFailed: 0 } },
    { queue: { pending: 0, processing: 0, failed: 1, terminalFailed: 1 } },
    { latestCertificationAt: new Date(Date.now() - 37 * 60 * 60 * 1000).toISOString() },
    { latestProjectionSnapshotSha256: "b".repeat(64) },
    { integrityValid: false },
  ]) {
    const f = fixture(overrides)
    const response = await f.get()
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, "RECIPIENT_TRUTH_UNAVAILABLE")
    assert.equal(f.calls.snapshots, 0)
  }
})

test("recipient-map authorization rejects before accessing any certification data", async () => {
  for (const [permissionError, status] of [["Unauthorized", 401], ["Forbidden", 403]] as const) {
    const f = fixture({}, permissionError)
    const response = await f.get()
    assert.equal(response.status, status)
    assert.match(response.headers.get("cache-control") || "", /private.*no-store/)
    assert.equal(f.calls.rpc, 0)
    assert.equal(f.calls.snapshots, 0)
  }
})
