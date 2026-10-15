import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { transformSync } from "esbuild"
import * as snapshotExport from "../../lib/backupTruthSnapshotExport"
import * as compression from "../../lib/compressedBackupStage"
import * as pricing from "../../lib/backupPricingSchema.mjs"

export function snapshotRow(canonical: string, extra: Record<string, unknown> = {}) {
  return {
    snapshot_sha256: createHash("sha256").update(canonical).digest("hex"),
    snapshot_kind: "synthetic-projection",
    schema_version: 1,
    canonical_json: canonical,
    byte_length: Buffer.byteLength(canonical),
    item_counts: { synthetic: 1 },
    created_at: "2026-10-15T00:00:00.000Z",
    ...extra,
  }
}

export function snapshotClient(response: (hash: string, call: number) => unknown | Promise<unknown>) {
  const requests: URL[] = []
  const supabase = createClient("https://backup-snapshot-fixture.invalid", "synthetic-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input) => {
      const url = new URL(String(input))
      requests.push(url)
      assert.equal(url.origin, "https://backup-snapshot-fixture.invalid")
      assert.equal(url.pathname, "/rest/v1/outlook_exchange_truth_snapshots")
      assert.equal(url.searchParams.get("select"), "*")
      assert.equal(url.searchParams.get("limit"), "1")
      assert.deepEqual([...url.searchParams.keys()].sort(), ["limit", "select", "snapshot_sha256"])
      const filter = url.searchParams.get("snapshot_sha256")!
      assert.match(filter, /^eq\.[0-9a-f]{64}$/)
      const rows = await response(filter.slice(3), requests.length)
      if (rows instanceof Response) return rows
      return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } })
    } },
  })
  return { supabase, requests, readSnapshot: (hash: string) => supabase.from("outlook_exchange_truth_snapshots").select("*").eq("snapshot_sha256", hash).limit(1) }
}

export const directRead = async (operation: () => PromiseLike<{ data: unknown; error: unknown }>) => {
  const result = await operation()
  if (result.error) throw result.error
  return result.data
}

type Stage = ReturnType<typeof compression.createCompressedBackupStage>
type Writer = { stream: Stage["writable"]; stage: Stage; sourceByteLength: number }

// Execute the production section, retry policy and serializer verbatim. Only
// external integrations are replaced; no backup business logic is recreated.
export function actualSnapshotSection() {
  const source = readFileSync(new URL("../../app/api/backups/bunker-map-drive/route.ts", import.meta.url), "utf8")
  const start = source.indexOf("      const seenSnapshotHashes = new Set<string>()")
  const end = source.indexOf("      let exportedLedgerHeadSequence = 0", start)
  assert.ok(start > 0 && end > start)
  const section = source.slice(start, end)
  assert.match(section, /streamReferencedTruthSnapshots\(/)
  assert.doesNotMatch(section, /streamTableRows\(/)
  const require = createRequire(import.meta.url)
  const modules: Record<string, unknown> = {
    "@supabase/supabase-js": { createClient: () => assert.fail("No production database client in this fixture") },
    "next/server": { NextResponse: { json: () => assert.fail("No live response in section fixture") } },
    "@/lib/adminAuth": { requireAdminPagePermission: () => assert.fail("No production session in this fixture") },
    "@/lib/compressedBackupStage": compression,
    "@/lib/googleApis": { loadGoogleApis: () => assert.fail("No Google calls in this fixture") },
    "@/lib/queryEscaping": {},
    "@/lib/backupPricingSchema.mjs": pricing,
    "@/lib/backupTruthSnapshotExport": snapshotExport,
  }
  const code = transformSync(`${source}\nmodule.exports.sectionFixture = async function(supabase, referencedSnapshotHashes, writer, sections, counts, expectedCount) {\nlet isFirstSection = true;\nconst checkpointBefore = { snapshots: expectedCount };\n${section}\nreturn { snapshotCount, seenSnapshotHashes };\n};`, { loader: "ts", format: "cjs", target: "node24" }).code
  const loaded = { exports: {} as { sectionFixture: (supabase: ReturnType<typeof snapshotClient>["supabase"], hashes: Set<string>, writer: Writer, sections: Record<string, unknown>, counts: Record<string, number>, expectedCount: number) => Promise<{ snapshotCount: number; seenSnapshotHashes: Set<string> }> } }
  new Function("require", "module", "exports", "process", "setTimeout", code)(
    (name: string) => name.startsWith("node:") ? require(name) : (assert.ok(name in modules, name), modules[name]),
    loaded, loaded.exports, { env: {} }, (callback: () => void) => setTimeout(callback, 0),
  )
  return loaded.exports.sectionFixture
}
