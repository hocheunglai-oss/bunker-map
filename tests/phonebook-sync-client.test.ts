import assert from "node:assert/strict"
import test from "node:test"
import {
  acknowledgePhonebookSync,
  enqueuePhonebookSync,
  loadPhonebookSyncScope,
  LEGACY_PHONEBOOK_SYNC_RETRY_KEY,
  PHONEBOOK_SYNC_RETRY_KEY,
  readPhonebookSyncRetries,
  runPhonebookSync,
  stagePhonebookSync,
} from "../lib/phonebookSyncClient"

function memoryStorage(raw?: string) {
  const values = new Map<string, string>(raw === undefined ? [] : [[PHONEBOOK_SYNC_RETRY_KEY, raw]])
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}
function stage(storage: ReturnType<typeof memoryStorage>, ids: string[], operation: "upsert" | "delete" = "upsert") {
  return stagePhonebookSync(storage, ids.map((id) => ({ id, operation })))
}
function verified(ids: string[], extra: Record<string, unknown> = {}) {
  return { verifiedIds: ids, verifiedCount: ids.length, failed: [], total: ids.length, done: true, nextCursor: null, ...extra }
}
function requestBody(init?: RequestInit) { return JSON.parse(String(init?.body)) as Record<string, unknown> }

test("company and full scopes are fetched authoritatively, without trusting visible cached rows", async () => {
  const seen: string[] = []
  const fetcher: typeof fetch = async (url, init) => {
    seen.push(String(url))
    assert.equal(init?.cache, "no-store")
    assert.ok(init?.signal)
    return Response.json({ contacts: [{ id: "a", full_name: "Alice" }, { id: "b" }] })
  }
  assert.deepEqual(await loadPhonebookSyncScope("A & B", fetcher), [
    { id: "a", label: "Alice", operation: "upsert" }, { id: "b", label: "Contact", operation: "upsert" },
  ])
  await loadPhonebookSyncScope(null, fetcher)
  assert.deepEqual(seen, ["/api/phonebook/contacts?company=A%20%26%20B", "/api/phonebook/contacts?all=1"])
  for (const value of [{}, { contacts: null }, { contacts: [{ id: "" }] }, { contacts: [null] }]) {
    await assert.rejects(loadPhonebookSyncScope("Company", async () => Response.json(value)), /complete saved contact list/)
  }
  await assert.rejects(loadPhonebookSyncScope("Company", async () => Response.json({ contacts: [] }, { status: 503 })), /complete saved contact list/)
})

test("legacy failures migrate to uploads and retain all records beyond the former 50-entry limit", () => {
  const records = Array.from({ length: 75 }, (_, index) => ({ id: `contact-${index}`, label: `Contact${index}`, error: "Old error" }))
  const storage = memoryStorage()
  storage.setItem(LEGACY_PHONEBOOK_SYNC_RETRY_KEY, JSON.stringify(records))
  assert.equal(readPhonebookSyncRetries(storage).length, 75)
  assert.ok(readPhonebookSyncRetries(storage).every((entry) => entry.operation === "upsert"))
  assert.equal(storage.getItem(LEGACY_PHONEBOOK_SYNC_RETRY_KEY), JSON.stringify(records))
  assert.ok(storage.getItem(PHONEBOOK_SYNC_RETRY_KEY))
  stage(storage, ["another"])
  assert.equal(readPhonebookSyncRetries(storage).length, 76)
})

test("an old tab clearing the legacy key cannot erase migrated uploads or new deletion intents", () => {
  const storage = memoryStorage()
  storage.setItem(LEGACY_PHONEBOOK_SYNC_RETRY_KEY, JSON.stringify([{ id: "old-upload", label: "Contact" }]))
  assert.equal(readPhonebookSyncRetries(storage).length, 1)
  stage(storage, ["deleted-contact"], "delete")
  storage.setItem(LEGACY_PHONEBOOK_SYNC_RETRY_KEY, "[]")
  assert.deepEqual(readPhonebookSyncRetries(storage).map(({ id, operation }) => ({ id, operation })), [
    { id: "old-upload", operation: "upsert" }, { id: "deleted-contact", operation: "delete" },
  ])
  storage.setItem(LEGACY_PHONEBOOK_SYNC_RETRY_KEY, "broken-old-tab-data")
  assert.equal(readPhonebookSyncRetries(storage).length, 2)
})

test("one-time migration fails honestly when storage cannot preserve the new ledger", () => {
  const old = JSON.stringify([{ id: "old-upload", label: "Contact" }])
  const storage = {
    getItem: (key: string) => key === LEGACY_PHONEBOOK_SYNC_RETRY_KEY ? old : null,
    setItem: () => { throw new Error("Quota exceeded") },
  }
  assert.throws(() => readPhonebookSyncRetries(storage), /could not be saved/)
  assert.equal(storage.getItem(LEGACY_PHONEBOOK_SYNC_RETRY_KEY), old)
})

test("corrupt or inaccessible retry storage fails safely without silently destroying pending data", () => {
  for (const raw of ["", "{", "null", "{}", '[{"id":""}]', '[{"id":"x","operation":"unknown"}]']) {
    const storage = memoryStorage(raw)
    assert.throws(() => readPhonebookSyncRetries(storage), /retry information is unreadable/)
    assert.throws(() => stage(storage, ["new-contact"]), /retry information is unreadable/)
    assert.equal(storage.getItem(PHONEBOOK_SYNC_RETRY_KEY), raw)
  }
  const inaccessible = { getItem: () => { throw new Error("Blocked") }, setItem: () => undefined }
  assert.throws(() => readPhonebookSyncRetries(inaccessible), /could not be read/)
  const unwritable = { getItem: () => null, setItem: () => { throw new Error("Quota") } }
  assert.throws(() => stagePhonebookSync(unwritable, [{ id: "new", operation: "upsert" }]), /could not be saved/)
})

test("an unrelated successful upload leaves failed uploads and deletions pending", async () => {
  const storage = memoryStorage()
  stage(storage, ["failed-upload"])
  stage(storage, ["failed-delete"], "delete")
  const entries = stage(storage, ["other-contact"])
  const result = await runPhonebookSync({ entries, storage, fetcher: async () => Response.json(verified(["other-contact"])) })
  assert.deepEqual(result, { verifiedCount: 1, failed: [] })
  assert.deepEqual(readPhonebookSyncRetries(storage).map(({ id, operation }) => ({ id, operation })), [
    { id: "failed-upload", operation: "upsert" }, { id: "failed-delete", operation: "delete" },
  ])
})

test("all pending operations are saved before the network request and survive network/HTTP failures", async () => {
  for (const kind of ["network", "http"] as const) {
    const storage = memoryStorage()
    const entries = stage(storage, ["a", "b", "c"])
    await assert.rejects(runPhonebookSync({ entries, storage, fetcher: async () => {
      assert.deepEqual(readPhonebookSyncRetries(storage).map((entry) => entry.id), ["a", "b", "c"])
      if (kind === "network") throw new Error("Offline")
      return Response.json({ message: "Provider unavailable." }, { status: 503 })
    } }), kind === "network" ? /Offline/ : /Provider unavailable/)
    assert.equal(readPhonebookSyncRetries(storage).length, 3)
  }
})

test("requests are serial batches of two, and failures after a completed batch preserve unattempted IDs", async () => {
  const storage = memoryStorage()
  const entries = stage(storage, ["a", "b", "c", "d", "e"])
  const requests: string[][] = []
  const result = await runPhonebookSync({ entries, storage, fetcher: async (_url, init) => {
    const ids = requestBody(init).contactIds as string[]
    requests.push(ids)
    assert.ok(init?.signal)
    return Response.json(verified(ids))
  } })
  assert.deepEqual(requests, [["a", "b"], ["c", "d"], ["e"]])
  assert.equal(result.verifiedCount, 5)
  assert.deepEqual(readPhonebookSyncRetries(storage), [])

  const retried = stage(storage, ["a", "b", "c"])
  let count = 0
  await assert.rejects(runPhonebookSync({ entries: retried, storage, fetcher: async (_url, init) => {
    if (++count === 2) throw new Error("Connection dropped")
    return Response.json(verified(requestBody(init).contactIds as string[]))
  } }), /Connection dropped/)
  assert.deepEqual(readPhonebookSyncRetries(storage).map((entry) => entry.id), ["c"])
})

test("retry preserves delete intent and does not convert failed deletions into uploads", async () => {
  const storage = memoryStorage()
  stage(storage, ["deleted-contact"], "delete")
  const entries = readPhonebookSyncRetries(storage)
  await assert.rejects(runPhonebookSync({ entries, storage, fetcher: async (_url, init) => {
    assert.deepEqual(requestBody(init), { deleteContactIds: ["deleted-contact"] })
    return Response.json({ message: "Temporary failure" }, { status: 500 })
  } }), /Temporary failure/)
  assert.equal(readPhonebookSyncRetries(storage)[0].operation, "delete")
  await runPhonebookSync({ entries: readPhonebookSyncRetries(storage), storage, fetcher: async (_url, init) => {
    assert.deepEqual(requestBody(init), { deleteContactIds: ["deleted-contact"] })
    return Response.json(verified(["deleted-contact"]))
  } })
  assert.deepEqual(readPhonebookSyncRetries(storage), [])
})

test("partial HTTP 207 acknowledges verified IDs only and retains every failed operation", async () => {
  const storage = memoryStorage()
  const entries = stage(storage, Array.from({ length: 55 }, (_, i) => `contact-${i}`))
  const result = await runPhonebookSync({ entries, storage, fetcher: async (_url, init) => {
    const ids = requestBody(init).contactIds as string[]
    const successful = ids.includes("contact-0") ? ["contact-0"] : []
    const failed = ids.filter((id) => !successful.includes(id)).map((id) => ({ id, label: id, error: "Retry required" }))
    return Response.json(verified(successful, { total: ids.length, failed }), { status: 207 })
  } })
  assert.equal(result.verifiedCount, 1)
  assert.equal(result.failed.length, 54)
  assert.equal(readPhonebookSyncRetries(storage).length, 54)
})

test("incomplete or malformed success responses never clear pending operations", async () => {
  for (const payload of [
    {}, { message: "Success" }, verified([]), verified(["wrong-id"]),
    verified(["a"], { done: false }), verified(["a"], { verifiedCount: 2 }),
    verified(["a"], { failed: [{ id: "a", error: "Conflict" }] }),
    verified(["a"], { nextCursor: 1 }), verified(["a"], { failed: [{}] }),
  ]) {
    const storage = memoryStorage()
    const entries = stage(storage, ["a"])
    await assert.rejects(runPhonebookSync({ entries, storage, fetcher: async () => Response.json(payload) }))
    assert.equal(readPhonebookSyncRetries(storage).length, 1)
  }
})

test("older verified operations cannot acknowledge a newer edit or deletion of the same ID", () => {
  const storage = memoryStorage()
  const original = stagePhonebookSync(storage, [{ id: "a", operation: "upsert" }], () => "original")
  stagePhonebookSync(storage, [{ id: "a", operation: "upsert" }], () => "new-edit")
  acknowledgePhonebookSync(storage, original, ["a"])
  assert.equal(readPhonebookSyncRetries(storage)[0].token, "new-edit")
  stagePhonebookSync(storage, [{ id: "a", operation: "delete" }], () => "deletion")
  acknowledgePhonebookSync(storage, original, ["a"])
  assert.equal(readPhonebookSyncRetries(storage)[0].operation, "delete")
})

test("overlapping sync calls are serialized and a failed request does not drop the next job", async () => {
  const queue = { current: Promise.resolve() as Promise<unknown> }
  const events: string[] = []
  let finishFirst!: () => void
  const gate = new Promise<void>((resolve) => { finishFirst = resolve })
  const first = enqueuePhonebookSync(queue, async () => { events.push("first-start"); await gate; events.push("first-end"); throw new Error("First failed") })
  const firstRejected = assert.rejects(first, /First failed/)
  const second = enqueuePhonebookSync(queue, async () => { events.push("second"); return "complete" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(events, ["first-start"])
  finishFirst()
  await firstRejected
  assert.equal(await second, "complete")
  assert.deepEqual(events, ["first-start", "first-end", "second"])
})

test("full resync sends upload-only requests and continues after a partial failure", async () => {
  const storage = memoryStorage()
  const entries = stage(storage, ["a", "b", "c"])
  const requests: Record<string, unknown>[] = []
  const result = await runPhonebookSync({ entries, storage, fullResync: true, fetcher: async (_url, init) => {
    const body = requestBody(init)
    requests.push(body)
    if (body.cursor === 0) return Response.json(verified(["a"], { total: 3, done: false, nextCursor: 2, failed: [{ id: "b", label: "b", error: "Retry" }] }), { status: 207 })
    return Response.json(verified(["c"], { total: 3 }))
  } })
  assert.deepEqual(requests, [{ fullRebuild: true, phase: "upload", cursor: 0 }, { fullRebuild: true, phase: "upload", cursor: 2 }])
  assert.equal(result.verifiedCount, 2)
  assert.deepEqual(readPhonebookSyncRetries(storage).map((entry) => entry.id), ["b"])
})

test("full resync stops on nonprogressing or inconsistent cursors", async () => {
  for (const nextCursor of [null, 0, 3, -1, 1.5]) {
    const storage = memoryStorage()
    const entries = stage(storage, ["a", "b"])
    let requests = 0
    await assert.rejects(runPhonebookSync({ entries, storage, fullResync: true, fetcher: async () => {
      requests += 1
      return Response.json(verified(["a"], { total: 2, done: false, nextCursor }))
    } }))
    assert.equal(requests, 1)
    assert.ok(readPhonebookSyncRetries(storage).some((entry) => entry.id === "b"))
  }
})

test("full resync cannot claim success if the server omitted a contact from its snapshot", async () => {
  const storage = memoryStorage()
  const entries = stage(storage, ["a", "b"])
  const result = await runPhonebookSync({ entries, storage, fullResync: true, fetcher: async () => Response.json(verified(["a"], { total: 2 })) })
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].id, "b")
  assert.equal(readPhonebookSyncRetries(storage)[0].id, "b")
})
