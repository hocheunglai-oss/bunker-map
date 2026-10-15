import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import * as policy from "../lib/backupProtectionPolicy"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"

const input: policy.BackupGapObservation = { domain: "drive-file", observedAt: "2026-10-15T00:30:00.000Z", gaps: [{ key: "a".repeat(64), dueAt: "2026-10-14T22:15:00.000Z", requiredSinceAt: "2026-10-14T01:00:00Z" }], complete: true }
const good = () => ({ schema: "fcuno.backup-protection-gaps/v1", domain: input.domain, accepted: true, observedAt: input.observedAt,
  gaps: input.gaps.map((gap) => ({ key: gap.key, firstUncoveredAt: input.observedAt, firstDueAt: gap.dueAt })) })

function fixture(options: { url?: string; reply?: unknown; error?: unknown; reject?: boolean } = {}) {
  const calls: unknown[] = []
  const loaded = { exports: {} as {
    createBackupProtectionGapObserver(): policy.BackupGapObserver
    createBackupProtectionGapPreviewObserver(): policy.BackupGapObserver
    validateBackupGapReply(value: unknown, input: policy.BackupGapObservation): policy.BackupGapObservationResult
  } }
  const dependencies: Record<string, unknown> = {
    "server-only": {}, "@/config/fcunoConnections": { fcunoConnectionPolicy }, "@/lib/backupProtectionPolicy": policy,
    "@supabase/supabase-js": { createClient(url: string, key: string, configuration: unknown) {
      calls.push({ url, key, configuration })
      return { rpc(name: string, args: unknown) { calls.push({ name, args }); return { async abortSignal(signal: AbortSignal) {
        assert.equal(signal.aborted, false)
        if (options.reject) throw Error("Transport details that must remain private")
        return { data: Object.hasOwn(options, "reply") ? options.reply : good(), error: options.error || null }
      } } } }
    } },
  }
  const code = transformSync(readFileSync(new URL("../lib/backupProtectionGapStore.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", code)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name] }, loaded, loaded.exports,
    { env: { NEXT_PUBLIC_SUPABASE_URL: options.url || `https://${fcunoConnectionPolicy.supabase.projectRef}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "synthetic-only-key" } })
  return { ...loaded.exports, calls }
}

test("gap observer pins the canonical project before creating any service client", () => {
  for (const url of ["https://wrong.supabase.co", `https://${fcunoConnectionPolicy.supabase.projectRef}.supabase.co/elsewhere`, `https://${fcunoConnectionPolicy.supabase.projectRef}.supabase.co?secret=1`, "not a URL"]) {
    const f = fixture({ url })
    assert.throws(f.createBackupProtectionGapObserver, policy.BackupProtectionObservationError)
    assert.deepEqual(f.calls, [])
  }
})

test("observer uses only the exact gap RPC and returns validated fixed clocks", async () => {
  const f = fixture()
  assert.deepEqual(await f.createBackupProtectionGapObserver()(input), good())
  assert.deepEqual(f.calls[1], { name: "reconcile_backup_protection_gaps", args: { p_domain: input.domain, p_observed_at: input.observedAt, p_gaps: input.gaps, p_complete: true } })
})

test("dashboard preview factory calls only the read-only RPC with the same project pin and validated shape", async () => {
  const f = fixture()
  assert.deepEqual(await f.createBackupProtectionGapPreviewObserver()(input), good())
  assert.deepEqual(f.calls[1], { name: "preview_backup_protection_gaps", args: { p_domain: input.domain, p_observed_at: input.observedAt, p_gaps: input.gaps, p_complete: true } })
  const denied = fixture({ url: "https://wrong.supabase.co" })
  assert.throws(denied.createBackupProtectionGapPreviewObserver, policy.BackupProtectionObservationError)
  assert.deepEqual(denied.calls, [])
})

test("stale GET projection may read a newer committed clock without relaxing notification ordering validation", async () => {
  const newer = { ...good(), gaps: [{ ...good().gaps[0], firstUncoveredAt: "2026-10-15T00:31:00.000Z" }] }
  const f = fixture({ reply: newer })
  assert.deepEqual(await f.createBackupProtectionGapPreviewObserver()(input), newer)
  await assert.rejects(() => f.createBackupProtectionGapObserver()(input), policy.BackupProtectionObservationError)
  const future = fixture({ reply: { ...newer, gaps: [{ ...newer.gaps[0], firstUncoveredAt: new Date(Date.now() + 10 * 60_000).toISOString() }] } })
  await assert.rejects(() => future.createBackupProtectionGapPreviewObserver()(input), policy.BackupProtectionObservationError)
})

test("bad response shapes and delayed due dates always raise a typed storage error", () => {
  const f = fixture()
  for (const value of [null, [], {}, { ...good(), domain: "database" }, { ...good(), accepted: "yes" },
    { ...good(), observedAt: "wrong" }, { ...good(), gaps: [null] },
    { ...good(), gaps: [{ ...good().gaps[0], key: {} }] }, { ...good(), gaps: [...good().gaps, ...good().gaps] },
    { ...good(), gaps: [{ ...good().gaps[0], firstDueAt: "2026-10-20T00:00:00Z" }] },
    { ...good(), gaps: [{ ...good().gaps[0], firstUncoveredAt: "2026-10-20T00:00:00Z" }] },
  ]) assert.throws(() => f.validateBackupGapReply(value, input), policy.BackupProtectionObservationError)
})

test("invalid sparse input and future reset proof cannot reach the database", async () => {
  const f = fixture(), observe = f.createBackupProtectionGapObserver()
  const before = f.calls.length
  for (const malformed of [null, { ...input, gaps: [null] }, { ...input, gaps: [{ key: 123, dueAt: input.gaps[0].dueAt }] },
    { ...input, gaps: [...input.gaps, ...input.gaps] }, { ...input, gaps: [{ ...input.gaps[0], coveredThroughAt: "2026-10-16T00:00:00Z" }] },
  ]) await assert.rejects(() => observe(malformed as policy.BackupGapObservation), policy.BackupProtectionObservationError)
  assert.equal(f.calls.length, before)
})

test("unknown partial observations may preserve extra clocks; complete responses may not", () => {
  const f = fixture()
  const partial = { ...input, gaps: [], complete: false }
  assert.deepEqual(f.validateBackupGapReply(good(), partial), good())
  assert.throws(() => f.validateBackupGapReply(good(), { ...partial, complete: true }), policy.BackupProtectionObservationError)
})

test("stale observations and database failures abort notification, without exposing transport details", async () => {
  for (const options of [{ reply: { ...good(), accepted: false, observedAt: "2026-10-15T00:31:00Z" } },
    { error: { message: "private database details" } }, { reject: true }]) {
    const f = fixture(options)
    await assert.rejects(() => f.createBackupProtectionGapObserver()(input), (error: unknown) => {
      assert.ok(error instanceof policy.BackupProtectionObservationError)
      assert.doesNotMatch(error.message, /private database|Transport details/)
      return true
    })
  }
})

test("schema reset proof requires the exact required and covered inventory fingerprints", async () => {
  const f = fixture(), observe = f.createBackupProtectionGapObserver()
  const schema: policy.BackupGapObservation = { ...input, domain: "database", gaps: [{ key: "inventory", dueAt: input.gaps[0].dueAt }] }
  await assert.rejects(() => observe(schema), policy.BackupProtectionObservationError)
  schema.gaps[0] = { ...schema.gaps[0], requiredVersion: "20261015073258", requiredFingerprint: "a".repeat(64), coveredThroughAt: "2026-10-14T18:00:00Z" }
  await assert.rejects(() => observe(schema), policy.BackupProtectionObservationError)
})
