import assert from "node:assert/strict"
import * as crypto from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"
import type { CardDavWriteLease } from "../lib/phonebookCarddav"

const output = ts.transpileModule(readFileSync(new URL("../lib/phonebookCarddav.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const target = fcunoConnectionPolicy.phonebookCardDav.hetzner
const hetznerEnv = () => ({ CARDDAV_WRITE_GENERATION: target.writeGeneration,
  CARDDAV_ADDRESSBOOK_URL: target.addressBookUrl, CARDDAV_USERNAME: target.username })

function fixture(env: Record<string, string | undefined> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let now = 0, retired = false, busy = false
  const supabase = { async rpc(name: string, args: Record<string, unknown>) {
    calls.push({ name, args })
    return retired ? { data: null, error: { code: "55000", message: "PRIVATE DATABASE DETAILS" } }
      : { data: !busy, error: null }
  } }
  const exports: { acquireCardDavWriteLease?: (client: unknown, durationMs?: number) => Promise<CardDavWriteLease> } = {}
  vm.runInNewContext(output, { exports, Error, process: { env }, Date: class extends Date { static now() { return now } },
    require(name: string) {
      if (name === "node:crypto") return crypto
      assert.equal(name, "../config/fcunoConnections")
      return { fcunoConnectionPolicy }
    },
  })
  return { calls, env, acquire: (durationMs?: number) => exports.acquireCardDavWriteLease!(supabase, durationMs),
    retire: () => { retired = true }, occupy: () => { busy = true }, advance: (ms: number) => { now += ms } }
}

test("unset and explicit legacy generation retain the deployed shared lease", async () => {
  for (const generation of [undefined, "legacy"]) {
    const f = fixture({ CARDDAV_WRITE_GENERATION: generation })
    const lease = await f.acquire()
    await lease.beforeWrite(); await lease.release()
    assert.deepEqual(f.calls.map(call => call.name), ["claim_bunker_map_backup_lock", "claim_bunker_map_backup_lock", "release_bunker_map_backup_lock"])
    assert.ok(f.calls.every(call => call.args.p_lock_name === "phonebook-carddav-writes"))
    assert.equal(new Set(f.calls.map(call => call.args.p_run_id)).size, 1)
  }
})

test("Hetzner generation is pinned and renewal/release retain the acquired owner and lock", async () => {
  for (const addressBookUrl of [target.addressBookUrl, target.addressBookUrl.slice(0, -1)]) {
    const f = fixture({ ...hetznerEnv(), CARDDAV_ADDRESSBOOK_URL: addressBookUrl })
    const lease = await f.acquire()
    f.env.CARDDAV_WRITE_GENERATION = "legacy"
    await lease.beforeWrite(); await lease.release()
    assert.ok(f.calls.every(call => call.args.p_lock_name === target.writeLockName))
    assert.equal(new Set(f.calls.map(call => call.args.p_run_id)).size, 1)
    assert.equal(f.calls[0].args.p_lease_seconds, 360)
  }
})

test("unknown generation, wrong collection and wrong owner fail before any RPC", async () => {
  for (const overrides of [{ CARDDAV_WRITE_GENERATION: "" }, { CARDDAV_WRITE_GENERATION: "hetzner-v2" },
    { CARDDAV_ADDRESSBOOK_URL: "https://old-provider.invalid/book/" },
    { CARDDAV_ADDRESSBOOK_URL: target.addressBookUrl + "?other=1" }, { CARDDAV_USERNAME: "admin" }]) {
    const f = fixture({ ...hetznerEnv(), ...overrides })
    await assert.rejects(f.acquire(), { stage: "configuration", message: /does not match its approved connection/ })
    assert.equal(f.calls.length, 0)
  }
})

test("retired initial claim and renewal fail clearly without leaking database details", async () => {
  const initial = fixture(); initial.retire()
  await assert.rejects(initial.acquire(), { stage: "configuration", message: "This phonebook writer has been retired. Reload the current FCUNO site; saved changes remain queued." })
  const renewal = fixture(), lease = await renewal.acquire(); renewal.retire()
  await assert.rejects(lease.beforeWrite(), { stage: "configuration", message: /writer has been retired/ })
  assert.equal(renewal.calls.length, 2)
})

test("generation selection preserves busy rejection and the bounded admission deadline", async () => {
  const busy = fixture(hetznerEnv()); busy.occupy()
  await assert.rejects(busy.acquire(), { stage: "verification", message: /already running/ })
  const f = fixture(hetznerEnv()), lease = await f.acquire(300_000)
  assert.equal(lease.deadline, 180_000)
  f.advance(180_000)
  await assert.rejects(lease.beforeWrite(), /continue on the next run/)
  assert.equal(f.calls.length, 1)
})
