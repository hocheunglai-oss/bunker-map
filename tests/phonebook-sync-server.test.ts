import assert from "node:assert/strict"
import test from "node:test"
import { syncPhonebookFromWorkbench } from "../lib/phonebookSyncServer"

const request = new Request("https://fixture.invalid/api/admin/ai-workbench", { headers: { cookie: "fixture-session=1" } })
const ids = ["contact-1", "contact-2", "contact-3"]
const payload = (batch: string[], failed: Array<{ id: string }> = []) => ({
  done: true, nextCursor: null, total: batch.length + failed.length,
  verifiedIds: batch, verifiedCount: batch.length, failed,
})

test("workbench batches sync and requires verification for every ID", async () => {
  const batches: string[][] = []
  const send: typeof fetch = async (url, options) => {
    assert.equal(String(url), "https://fixture.invalid/api/phonebook/carddav-sync")
    assert.equal(new Headers(options?.headers).get("cookie"), "fixture-session=1")
    const batch = JSON.parse(String(options?.body)).contactIds
    batches.push(batch)
    return Response.json(payload(batch))
  }
  const result = await syncPhonebookFromWorkbench(request, [...ids, ids[0]], { fetch: send })
  assert.deepEqual(batches, [ids.slice(0, 2), ids.slice(2)])
  assert.equal(result?.ok, true)
})

test("workbench never treats partial HTTP success as completed sync", async () => {
  let calls = 0
  const result = await syncPhonebookFromWorkbench(request, ids, { fetch: async () => {
    calls++
    return Response.json(payload([ids[0]], [{ id: ids[1] }]), { status: 207 })
  } })
  assert.equal(result?.ok, false)
  assert.deepEqual(result?.failed.map((failure) => failure.id), ids.slice(1))
  assert.equal(calls, 1)
})

test("workbench keeps every unfinished ID for malformed, incomplete and failed responses", async () => {
  for (const response of [Response.json({}), Response.json({ done: false, verifiedIds: ids, failed: [] }), Response.json({ message: "failed" }, { status: 500 }), new Response("not json")]) {
    const result = await syncPhonebookFromWorkbench(request, ids, { fetch: async () => response })
    assert.equal(result?.ok, false)
    assert.deepEqual(result?.failed.map((failure) => failure.id), ids)
  }
})

test("workbench bounds total sync time and reports skipped contacts", async () => {
  let clock = 0
  const result = await syncPhonebookFromWorkbench(request, ids, { now: () => clock, fetch: async () => {
    clock = 21_000
    return Response.json(payload(ids.slice(0, 2)))
  } })
  assert.equal(result?.ok, false)
  assert.deepEqual(result?.failed.map((failure) => failure.id), [ids[2]])
})

test("workbench rejects conflicting, duplicate or unexpected verification IDs", async () => {
  for (const value of [
    payload([ids[0], ids[0]]), payload([ids[0], "not-requested"]),
    payload([ids[0]], [{ id: ids[0] }]),
    { ...payload(ids.slice(0, 2)), nextCursor: 2 },
    { ...payload(ids.slice(0, 2)), total: 3 },
  ]) {
    const result = await syncPhonebookFromWorkbench(request, ids, { fetch: async () => Response.json(value) })
    assert.equal(result?.ok, false)
    assert.equal(result?.failed.length, ids.length)
  }
})

test("workbench handles a network timeout without claiming delivery", async () => {
  const result = await syncPhonebookFromWorkbench(request, ids, { fetch: async () => { throw new Error("timeout") } })
  assert.equal(result?.ok, false)
  assert.equal(result?.failed.length, 3)
  assert.match(result?.message || "", /Open Phonebook/)
  assert.equal(await syncPhonebookFromWorkbench(request, [], { fetch: async () => { throw new Error("should not fetch") } }), null)
})
