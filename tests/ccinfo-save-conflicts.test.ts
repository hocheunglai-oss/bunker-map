import assert from "node:assert/strict"
import test from "node:test"
import { CcinfoSaveConflict, ccinfoLegacyContentWriteMessage, createCcinfoSaveQueue } from "../lib/ccinfoSave"

const target = { kind: "company" as const, id: "00000000-0000-0000-0000-000000000001" }
const initial = "2026-10-12T01:00:00.000001+00:00"
const next = "2026-10-12T01:00:00.000002+00:00"
const last = "2026-10-12T01:00:00.000003+00:00"

test("serialized CCINFO saves preserve queued payloads and use the preceding acknowledged raw version", async () => {
  let release!: () => void
  const calls: Array<{ version: string; changes: Record<string, string | null> }> = []
  const queue = createCcinfoSaveQueue(async (_target, version, changes) => {
    calls.push({ version, changes })
    if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve })
    return { id: target.id, updated_at: calls.length === 1 ? next : last }
  })
  queue.loaded(target, initial)
  const firstPayload = { summary: "first" }
  const first = queue.save(target, firstPayload)
  const second = queue.save(target, { summary: "second", notes: "keep second notes" })
  firstPayload.summary = "caller changed this object"
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(queue.pending(), true)
  assert.deepEqual(calls, [{ version: initial, changes: { summary: "first" } }])
  release()
  await Promise.all([first, second])
  assert.deepEqual(calls[1], { version: next, changes: { summary: "second", notes: "keep second notes" } })
  assert.equal(queue.pending(), false)
})

test("zero-row/deleted conflicts never advance the version or run already queued stale writes", async () => {
  let writes = 0
  const queue = createCcinfoSaveQueue(async () => { writes += 1; throw new CcinfoSaveConflict() })
  queue.loaded(target, initial)
  const first = queue.save(target, { summary: "local draft" })
  const queued = queue.save(target, { summary: "newer local draft" })
  const results = await Promise.allSettled([first, queued])
  assert.equal(results[0].status, "rejected")
  assert.match((results[0] as PromiseRejectedResult).reason.message, /Your edits are still here/)
  assert.match((results[1] as PromiseRejectedResult).reason.message, /earlier save did not finish/)
  assert.equal(writes, 1)
  assert.equal(queue.pending(), false)
})

test("bad successful responses cannot acknowledge another record, missing versions, or unchanged versions", async () => {
  for (const row of [{ id: "another-record", updated_at: next }, { id: target.id, updated_at: "" }, { id: target.id, updated_at: initial }]) {
    const versions: string[] = []
    const queue = createCcinfoSaveQueue(async (_target, version) => { versions.push(version); return row })
    queue.loaded(target, initial)
    await assert.rejects(queue.save(target, { notes: "keep draft" }), /could not be verified/)
    await assert.rejects(queue.save(target, { notes: "retry draft" }), /could not be verified/)
    assert.deepEqual(versions, [initial, initial])
  }
})

test("separate entries do not share versions or failures and invalid initial versions fail closed", async () => {
  const other = { kind: "country" as const, id: "00000000-0000-0000-0000-000000000002" }
  const queue = createCcinfoSaveQueue(async (item) => {
    if (item.id === target.id) throw new CcinfoSaveConflict()
    return { id: item.id, updated_at: last }
  })
  assert.throws(() => queue.loaded(target, ""), /valid saved version/)
  await assert.rejects(queue.save(target, { notes: "draft" }), /Reopen/)
  queue.loaded(target, initial)
  queue.loaded(other, next)
  const result = await Promise.allSettled([queue.save(target, { notes: "company draft" }), queue.save(other, { notes: "country draft" })])
  assert.equal(result[0].status, "rejected")
  assert.equal(result[1].status, "fulfilled")
})

test("CCINFO proxy blocks old/unversioned content writes and accepts bounded returning CAS requests", () => {
  const body = new TextEncoder().encode(JSON.stringify({ summary: "changed" })).buffer
  const url = new URL("https://example.test/rest/v1/cc_companies")
  const check = (value = url, prefer: string | null = "return=representation") => ccinfoLegacyContentWriteMessage("ccinfo", "cc_companies", "PATCH", value, prefer, body)
  assert.ok(check())
  url.searchParams.set("id", `eq.${target.id}`)
  assert.ok(check())
  url.searchParams.set("updated_at", `eq.${initial}`)
  url.searchParams.set("select", "id,updated_at")
  assert.equal(check(), null)
  assert.ok(check(url, "return=minimal"))
  for (const version of ["is.null", "gte.2026-10-12", "eq.nonsense"]) {
    const bad = new URL(url)
    bad.searchParams.set("updated_at", version)
    assert.ok(check(bad))
  }
  const broad = new URL(url)
  broad.searchParams.set("id", `in.(${target.id})`)
  assert.ok(check(broad))
  const repeated = new URL(url)
  repeated.searchParams.append("updated_at", `eq.${next}`)
  assert.ok(check(repeated))
})

test("CCINFO guard leaves other pages, file/folder writes, inserts and deletes unchanged", () => {
  const content = new TextEncoder().encode(JSON.stringify({ notes: "changed" })).buffer
  const url = new URL("https://example.test/rest/v1/cc_ports")
  for (const [page, table, method, body] of [["phonebook", "cc_ports", "PATCH", content], ["ccinfo", "cc_entry_files", "PATCH", content], ["ccinfo", "cc_ports", "POST", content], ["ccinfo", "cc_ports", "DELETE", content]] as const) {
    assert.equal(ccinfoLegacyContentWriteMessage(page, table, method, url, null, body), null)
  }
})

test("country names require atomic rename; legacy bulk cascades fail closed but versioned port reparenting still works", () => {
  const name = new TextEncoder().encode(JSON.stringify({ name: "RENAMED" })).buffer
  const port = new TextEncoder().encode(JSON.stringify({ country_id: target.id, country_name: "RENAMED" })).buffer
  const url = new URL("https://example.test/rest/v1/cc_countries")
  url.searchParams.set("id", `eq.${target.id}`)
  url.searchParams.set("updated_at", `eq.${initial}`)
  url.searchParams.set("select", "*")
  assert.ok(ccinfoLegacyContentWriteMessage("ccinfo", "cc_countries", "PATCH", url, "return=representation", name))
  assert.equal(ccinfoLegacyContentWriteMessage("ccinfo", "cc_ports", "PATCH", url, "return=representation", port), null)
  url.searchParams.delete("updated_at")
  assert.ok(ccinfoLegacyContentWriteMessage("ccinfo", "cc_ports", "PATCH", url, "return=representation", port))
})
