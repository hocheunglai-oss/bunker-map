import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import { transformSync } from "esbuild"
import * as compression from "../lib/compressedBackupStage"
import * as snapshotExport from "../lib/backupTruthSnapshotExport"
import * as pricing from "../lib/backupPricingSchema.mjs"
import * as attendance from "../lib/backupAttendanceSchema.mjs"
import { makeBackupFixture } from "./fixtures/backup-validation.mjs"

const ledgerRpc = "verify_outlook_exchange_truth_ledger"
const checkpointRpc = "get_outlook_exchange_truth_checkpoint"
const recipientRpc = "verify_outlook_template_recipient_truth"
const truthRpcs = new Set([ledgerRpc, checkpointRpc, recipientRpc])
type ProofPhase = "before" | "after"
type Fault = { phase: ProofPhase; rpc: string; kind: "transport" | "malformed" | "invalid" }

// Load the entire actual route and retain its orchestration, proof validation,
// real Supabase SDK, paged reads, section serializer and Brotli stage. Only the
// external SDK transports are synthetic; no production database/session or
// Google endpoint can be reached from this fixture.
function fixture(options: { fault?: Fault; changed?: "epoch" | "inventory" | "head" | "templates"; beforeEpochBusy?: boolean } = {}) {
  const artifact = makeBackupFixture("20261014082839")
  const truth = artifact.integrity.truth
  const checkpoint = { ...truth.checkpointBeforeExport, queue: { pending: 0, processing: 0, failed: 0, terminalFailed: 0 } }
  const inventory = { schema: "bunker-map.backup-inventory/v1", migrationHead: artifact.migrationHead,
    tables: artifact.databaseInventory.liveTables, unfencedTables: [], catalogSha256: "ab".repeat(32),
    appliedMigrations: [], receiptColumns: [], annualConfirmationColumns: [] }
  const events: string[] = [], calls = new Map<string, number>()
  let activeProofs = 0, peakProofs = 0, tableReads = 0, googleReads = 0
  const rowsByTable: Record<string, Array<Record<string, unknown>>> = {
    outlook_exchange_truth_ledger: artifact.data.outlookExchangeTruthLedger,
    outlook_exchange_sync_certifications: artifact.data.outlookExchangeSyncCertifications,
    outlook_exchange_truth_snapshots: artifact.data.outlookExchangeTruthSnapshots,
  }
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
  const supabase = createClient("https://backup-proof-fixture.invalid", "synthetic-only-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input) => {
      const url = new URL(String(input))
      assert.equal(url.origin, "https://backup-proof-fixture.invalid")
      const name = url.pathname.replace("/rest/v1/", "")
      if (name.startsWith("rpc/")) {
        const rpc = name.slice(4), count = (calls.get(rpc) || 0) + 1
        calls.set(rpc, count)
        const phase: ProofPhase = count === 1 ? "before" : "after"
        if (rpc === "get_bunker_map_backup_inventory") return response(count > 1 && options.changed === "inventory" ? { ...inventory, catalogSha256: "cd".repeat(32) } : inventory)
        if (rpc === "get_bunker_map_backup_export_fence") return response({ schema: "bunker-map.backup-export-fence/v1", ready: !options.beforeEpochBusy, epoch: count > 1 && options.changed === "epoch" ? 8 : 7 })
        if (rpc === "get_attendance_dingtalk_anomaly_backup_page") return response([])
        assert.ok(truthRpcs.has(rpc), `Unexpected RPC ${rpc}`)
        events.push(`${phase}:${rpc}:start`)
        const expensive = rpc !== checkpointRpc
        if (expensive) { activeProofs++; peakProofs = Math.max(peakProofs, activeProofs) }
        try {
          // A real asynchronous transport boundary exposes Promise.all overlap.
          // Each template-truth RPC represents its existing nested full proof.
          await new Promise<void>((resolve) => setImmediate(resolve))
          const fault = options.fault?.rpc === rpc && options.fault.phase === phase ? options.fault : undefined
          if (fault?.kind === "transport") return response({ code: "P0001", message: "Synthetic proof denied" }, 400)
          if (fault?.kind === "malformed") return response(null)
          const value = structuredClone(rpc === ledgerRpc ? truth.verificationBeforeExport : rpc === checkpointRpc ? checkpoint : truth.templateRecipientVerificationBeforeExport)
          if (fault?.kind === "invalid") {
            if (rpc === checkpointRpc) value.checkpointValid = false
            else value.valid = false
          }
          if (phase === "after" && options.changed === "head" && rpc === ledgerRpc) value.headSha256 = "ef".repeat(32)
          if (phase === "after" && options.changed === "templates" && rpc === recipientRpc) value.templates = { ...value.templates, total: 1, sendable: 1 }
          return response(value)
        } finally {
          if (expensive) activeProofs--
          events.push(`${phase}:${rpc}:end`)
        }
      }
      tableReads++
      events.push(`table:${name}`)
      let rows = rowsByTable[name] || []
      for (const [column, filter] of url.searchParams) {
        if (filter.startsWith("eq.")) rows = rows.filter((row) => String(row[column]) === filter.slice(3))
        if (filter.startsWith("gt.")) rows = rows.filter((row) => Number(row[column]) > Number(filter.slice(3)))
        if (filter.startsWith("lte.")) rows = rows.filter((row) => Number(row[column]) <= Number(filter.slice(4)))
      }
      const from = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || rows.length)
      return response(rows.slice(from, from + limit))
    } },
  })
  const require = createRequire(import.meta.url)
  const google = {
    auth: { OAuth2: class { setCredentials() {} } },
    people: () => ({ people: { connections: { async list() { googleReads++; return { data: { connections: [] } } } } } }),
    calendar: () => ({ events: { async list() { googleReads++; return { data: { items: [] } } } } }),
    drive: () => assert.fail("Preparing data must not publish a Drive artifact"),
  }
  const modules: Record<string, unknown> = {
    "@supabase/supabase-js": { createClient: () => assert.fail("No production database client") },
    "next/server": { NextResponse: { json: () => assert.fail("No live route response") } },
    "@/lib/adminAuth": { requireAdminPagePermission: () => assert.fail("No production session") },
    "@/lib/compressedBackupStage": compression,
    "@/lib/googleApis": { loadGoogleApis: async () => ({ google }) },
    "@/lib/queryEscaping": {},
    "@/lib/backupPricingSchema.mjs": pricing,
    "@/lib/backupAttendanceSchema.mjs": attendance,
    "@/lib/backupTruthSnapshotExport": snapshotExport,
  }
  const source = readFileSync(new URL("../app/api/backups/bunker-map-drive/route.ts", import.meta.url), "utf8")
  const code = transformSync(`${source}\nmodule.exports.proofFixture = { buildBackupFile, getBackupInventory };`, { loader: "ts", format: "cjs", target: "node24" }).code
  const loaded = { exports: {} as { proofFixture: {
    getBackupInventory(client: typeof supabase): Promise<unknown>
    buildBackupFile(client: typeof supabase, path: string, previous: null, provenance: unknown, inventory: unknown): Promise<{ truth: Record<string, unknown>; counts: Record<string, number>; databaseEpoch: number; stagingFileByteLength: number }>
  } } }
  new Function("require", "module", "exports", "process", "fetch", code)(
    (name: string) => name.startsWith("node:") ? require(name) : (assert.ok(name in modules, name), modules[name]), loaded, loaded.exports,
    { env: { GOOGLE_OAUTH_CLIENT_ID: "synthetic", GOOGLE_OAUTH_CLIENT_SECRET: "synthetic", GOOGLE_OAUTH_REFRESH_TOKEN: "synthetic", GOOGLE_CALENDAR_REFRESH_TOKEN: "synthetic", GOOGLE_CALENDAR_ID: "synthetic@example.invalid" } },
    () => assert.fail("No global network transport"),
  )
  return { events, calls, artifact, checkpoint,
    get peakProofs() { return peakProofs }, get tableReads() { return tableReads }, get googleReads() { return googleReads },
    async run() {
      const directory = await mkdtemp(join(tmpdir(), "fcuno-proof-serialization-"))
      try {
        const input = await loaded.exports.proofFixture.getBackupInventory(supabase)
        return await loaded.exports.proofFixture.buildBackupFile(supabase, join(directory, "synthetic-data.json.br"), null,
          { backupRunId: "11111111-1111-4111-8111-111111111111", source: "vercel-cron", requestedBy: "Synthetic fixture" }, input)
      } finally { await rm(directory, { recursive: true, force: true }) }
    },
  }
}

test("actual backup builder runs all six unchanged pre/post RPCs without overlapping full proofs", { timeout: 10_000 }, async () => {
  const f = fixture(), prepared = await f.run()
  assert.equal(f.peakProofs, 1)
  assert.deepEqual(f.events.filter((event) => !event.startsWith("table:")), [
    `before:${ledgerRpc}:start`, `before:${ledgerRpc}:end`, `before:${checkpointRpc}:start`, `before:${checkpointRpc}:end`, `before:${recipientRpc}:start`, `before:${recipientRpc}:end`,
    `after:${checkpointRpc}:start`, `after:${checkpointRpc}:end`, `after:${ledgerRpc}:start`, `after:${ledgerRpc}:end`, `after:${recipientRpc}:start`, `after:${recipientRpc}:end`,
  ])
  assert.ok(f.events.indexOf(`before:${recipientRpc}:end`) < f.events.findIndex((event) => event.startsWith("table:")))
  assert.ok(f.events.findLastIndex((event) => event.startsWith("table:")) < f.events.indexOf(`after:${checkpointRpc}:start`))
  for (const name of truthRpcs) assert.equal(f.calls.get(name), 2)
  assert.equal(f.calls.get("get_bunker_map_backup_export_fence"), 2)
  assert.equal(f.calls.get("get_bunker_map_backup_inventory"), 2)
  assert.equal(f.googleReads, 2)
  assert.equal(prepared.databaseEpoch, 7)
  assert.ok(prepared.stagingFileByteLength > 0)
  assert.equal(prepared.counts.outlookExchangeTruthLedger, 2)
  assert.equal(prepared.counts.outlookExchangeTruthSnapshots, 2)
  for (const key of ["verificationBeforeExport", "verificationAfterExport", "templateRecipientVerificationBeforeExport", "templateRecipientVerificationAfterExport"] as const) {
    assert.deepEqual(prepared.truth[key], f.artifact.integrity.truth[key], key)
  }
  assert.deepEqual(prepared.truth.checkpointBeforeExport, f.checkpoint)
  assert.deepEqual(prepared.truth.checkpointAfterExport, f.checkpoint)
})

test("every pre/post RPC transport, malformed result and invalid proof still fails closed in the actual builder", { timeout: 15_000 }, async () => {
  for (const phase of ["before", "after"] as const) for (const rpc of truthRpcs) for (const kind of ["transport", "malformed", "invalid"] as const) {
    const f = fixture({ fault: { phase, rpc, kind } })
    await assert.rejects(f.run(), /proof denied|did not return an object|failed|not an operationally consistent|not aligned/, `${phase}:${rpc}:${kind}`)
    assert.equal(f.peakProofs, 1)
    if (phase === "before") { assert.equal(f.tableReads, 0); assert.equal(f.googleReads, 0) }
    if (kind !== "invalid") {
      const starts = f.events.filter((event) => event.startsWith(`${phase}:`) && event.endsWith(":start"))
      assert.equal(starts.at(-1), `${phase}:${rpc}:start`, "a failed await does not launch later proof RPCs")
    }
  }
})

test("actual serialization preserves independent epoch, inventory, head and recipient-truth fences", { timeout: 10_000 }, async () => {
  for (const [changed, error] of [["epoch", /database epoch/], ["inventory", /schema or table inventory changed/], ["head", /Exchange truth verification changed/], ["templates", /recipient truth changed/]] as const) {
    const f = fixture({ changed })
    await assert.rejects(f.run(), error)
    assert.equal(f.peakProofs, 1)
    for (const name of truthRpcs) assert.equal(f.calls.get(name), 2)
  }
  const busy = fixture({ beforeEpochBusy: true })
  await assert.rejects(busy.run(), /tracked database write transaction is active/)
  assert.equal(busy.peakProofs, 0)
  assert.equal(busy.tableReads, 0)
  assert.equal(busy.googleReads, 0)
})
