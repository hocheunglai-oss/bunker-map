import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const routeSource = readFileSync(new URL("../app/api/phonebook/carddav-sync/route.ts", import.meta.url), "utf8")
const routeOutput = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`
const contact = (number: number, extra: Record<string, unknown> = {}) => ({
  id: id(number), full_name: `TEST CONTACT ${number}`, company: "TEST COMPANY", position: "TEST POSITION",
  department: null, title: null, direct_line: "12345678", mobile_1: "+852-12345678", mobile_2: null,
  personal_email: "synthetic@example.invalid", general_email: null, private_email: null, notes: null, ...extra,
})
type Contact = ReturnType<typeof contact>
type FetchCall = { url: URL; method: string; body: string; contactId: string }
type FixtureOptions = {
  rows?: Contact[]
  permissionError?: "Unauthorized" | "Forbidden"
  databaseError?: boolean
  missingServiceKey?: boolean
  onFetch?: (call: FetchCall, remote: Map<string, string>, rows: Contact[]) => Response | undefined | Promise<Response | undefined>
}

function fixture(options: FixtureOptions = {}) {
  const rows = options.rows || [contact(1), contact(2)]
  const companies = [{ name: "TEST COMPANY", country: "HONG KONG", tel_country: "852", tel_no_1: "87654321", tel_area: null, other_name: null, phone: null }]
  const calls: FetchCall[] = []
  const queries: Array<{ table: string; range?: number[]; order?: string; count?: string }> = []
  const logs: unknown[][] = []
  const permissions: string[][] = []
  const remote = new Map<string, string>()
  const exports: { POST?: (request: Request) => Promise<Response>; GET?: () => Promise<Response>; maxDuration?: number } = {}
  const dependencies: Record<string, unknown> = {
    "node:crypto": { createHash },
    "next/server": { NextResponse: Response },
    "@supabase/supabase-js": { createClient: (url: string, key: string) => {
      assert.equal(url, "https://database-fixture.invalid")
      assert.equal(key, "synthetic-service-key")
      return {
        from(table: string) {
          assert.ok(["phonebook_contacts", "phonebook_companies"].includes(table))
          const query: { table: string; range?: number[]; order?: string; count?: string } = { table }
          const filters: Array<(row: Record<string, unknown>) => boolean> = []
          let single = false
          const builder = {
            select(_fields: string, config?: { count?: string }) { query.count = config?.count; return builder },
            order(field: string) { query.order = field; return builder },
            range(start: number, end: number) { query.range = [start, end]; return builder },
            eq(field: string, value: unknown) { filters.push((row) => row[field] === value); return builder },
            in(field: string, values: unknown[]) { filters.push((row) => values.includes(row[field])); return builder },
            maybeSingle() { single = true; return builder },
            then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
              queries.push({ ...query })
              let selected = (table === "phonebook_contacts" ? rows : companies).filter((row) => filters.every((filter) => filter(row)))
              if (query.order) selected = [...selected].sort((a, b) => String((a as Record<string, unknown>)[query.order!]).localeCompare(String((b as Record<string, unknown>)[query.order!])))
              const count = selected.length
              if (query.range) selected = selected.slice(query.range[0], query.range[1] + 1)
              return Promise.resolve({ data: structuredClone(single ? selected[0] || null : selected), count, error: options.databaseError ? new Error("PRIVATE SOURCE PHONE +85212345678 AND CREDENTIAL") : null }).then(resolve, reject)
            },
          }
          return builder
        },
      }
    } },
    "@/lib/adminAuth": { requireAdminPagePermission: async (...values: string[]) => {
      permissions.push(values)
      if (options.permissionError) throw new Error(options.permissionError)
      return { username: "test-admin" }
    } },
  }
  vm.runInNewContext(routeOutput, {
    exports, Error, URL, Buffer, AbortSignal, setTimeout: (callback: () => void) => setTimeout(callback, 0),
    console: { error: (...values: unknown[]) => logs.push(values), info: (...values: unknown[]) => logs.push(values) },
    process: { env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://database-fixture.invalid",
      SUPABASE_SERVICE_ROLE_KEY: options.missingServiceKey ? undefined : "synthetic-service-key",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "unsafe-anonymous-fallback",
      CARDDAV_ADDRESSBOOK_URL: "https://carddav-fixture.invalid/book/",
      CARDDAV_USERNAME: "synthetic-user", CARDDAV_PASSWORD: "synthetic-password",
    } },
    require: (name: string) => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name] },
    fetch: async (target: string, init: RequestInit) => {
      const url = new URL(target)
      assert.equal(url.origin, "https://carddav-fixture.invalid", "No real network access is permitted.")
      const contactId = decodeURIComponent(url.pathname.split("/").pop() || "").replace(/^bunker-map-/, "").replace(/\.vcf$/, "")
      const call = { url, method: init.method || "GET", body: String(init.body || ""), contactId }
      calls.push(call)
      const customResponse = await options.onFetch?.(call, remote, rows)
      if (customResponse) return customResponse
      if (call.method === "PROPFIND") {
        const hrefs = [...remote.keys()].map((id) => `<d:response><d:href>/book/bunker-map-${id}.vcf</d:href></d:response>`).join("")
        return new Response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/book/</d:href></d:response>${hrefs}</d:multistatus>`, { status: 207 })
      }
      if (call.method === "PUT") { remote.set(contactId, call.body); return new Response(null, { status: 204 }) }
      if (call.method === "DELETE") { remote.delete(contactId); return new Response(null, { status: 204 }) }
      if (call.method === "GET") return new Response(remote.get(contactId) || null, { status: remote.has(contactId) ? 200 : 404 })
      throw new Error(`Unexpected remote operation: ${call.method}`)
    },
  })
  const post = (body: unknown) => exports.POST!(new Request("https://app-fixture.invalid/api/phonebook/carddav-sync", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }))
  const get = () => exports.GET!()
  return { post, get, calls, queries, logs, permissions, remote, rows }
}

test("read-only count reports saved contacts and distinct managed CardDAV cards", async () => {
  const f = fixture({ onFetch: (call) => call.method === "PROPFIND" ? new Response(
    `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/book/</d:href></d:response><d:response><d:href>/book/bunker-map-${id(1)}.vcf</d:href></d:response><d:response><d:href>/book/bunker-map-${id(1)}.vcf</d:href></d:response><d:response><d:href>/book/other.vcf</d:href></d:response><d:response><d:href>https://other.invalid/book/bunker-map-${id(2)}.vcf</d:href></d:response></d:multistatus>`, { status: 207 }) : undefined })
  const response = await f.get()
  assert.equal(response.status, 200)
  const payload = await response.json() as { savedContactCount: number; carddavContactCount: number; checkedAt: string }
  assert.equal(payload.savedContactCount, 2)
  assert.equal(payload.carddavContactCount, 1)
  assert.ok(!Number.isNaN(Date.parse(payload.checkedAt)))
  assert.deepEqual(f.permissions, [["phonebook", "view"]])
  assert.deepEqual(f.calls.map((call) => call.method), ["PROPFIND"])
})

test("count never invents a zero when CardDAV is unavailable or unauthorized", async () => {
  const denied = fixture({ permissionError: "Forbidden" })
  assert.equal((await denied.get()).status, 403)
  assert.equal(denied.calls.length, 0)
  const unavailable = fixture({ onFetch: (call) => call.method === "PROPFIND" ? new Response("secret upstream body", { status: 503 }) : undefined })
  const response = await unavailable.get()
  assert.equal(response.status, 503)
  assert.equal((await response.json()).message, "CardDAV count unavailable. Please retry.")
  const malformed = fixture({ onFetch: (call) => call.method === "PROPFIND" ? new Response("not XML", { status: 207 }) : undefined })
  assert.equal((await malformed.get()).status, 503)
})

test("authorizes phonebook edit permission before reading or syncing contacts", async () => {
  for (const [permissionError, status] of [["Unauthorized", 401], ["Forbidden", 403]] as const) {
    const f = fixture({ permissionError })
    assert.equal((await f.post({ contactIds: [id(1)] })).status, status)
    assert.deepEqual(f.permissions, [["phonebook", "edit"]])
    assert.equal(f.calls.length, 0)
    assert.equal(f.queries.length, 0)
  }
})

test("rejects missing, malformed, oversized or conflicting scopes before any side effect", async () => {
  for (const body of [null, [], {}, { contactIds: ["../contact"] }, { contactIds: [id(1), id(2), id(3)] }, { contactIds: "bad" }, { deleteContactIds: [12] }, { fullRebuild: "true" }, { selectedCompany: 42 }, { fullRebuild: true, contactIds: [id(1)] }, { fullRebuild: true, cursor: -1 }, { fullRebuild: true, cursor: 0.5 }, { contactIds: [id(1)], cursor: 2 }]) {
    const f = fixture()
    const response = await f.post(body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(f.calls.length, 0)
    assert.equal(f.queries.length, 0)
  }
})

test("requires a service-role read instead of mistaking anonymous hidden rows for deleted contacts", async () => {
  const f = fixture({ missingServiceKey: true })
  assert.equal((await f.post({ deleteContactIds: [id(1)] })).status, 503)
  assert.equal(f.calls.length, 0)
})

test("successful explicit updates verify the exact IDs and preserve company-phone mapping", async () => {
  const f = fixture()
  const response = await f.post({ contactIds: [id(2), id(1)] })
  const result = await response.json()
  assert.equal(response.status, 200)
  assert.deepEqual(result.verifiedIds, [id(1), id(2)])
  assert.equal(result.verifiedCount, 2)
  assert.equal(result.total, 2)
  assert.equal(result.done, true)
  assert.equal(result.nextCursor, null)
  assert.deepEqual(result.failed, [])
  assert.ok(f.remote.get(id(1))?.includes("TEL;TYPE=WORK:87654321"))
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(f.logs)), [["phonebook_carddav_sync_verified", { contactIds: [id(1), id(2)] }]])
})

test("a missing explicit ID is an actionable partial failure rather than false success", async () => {
  const f = fixture({ rows: [contact(1)] })
  const response = await f.post({ contactIds: [id(1), id(2)] })
  const result = await response.json()
  assert.equal(response.status, 207)
  assert.deepEqual(result.verifiedIds, [id(1)])
  assert.equal(result.failed[0].id, id(2))
  assert.equal(result.failed[0].stage, "source-read")
  assert.equal(result.total, 2)
})

test("permanent upstream errors are not retried and logs contain only IDs, stages and status", async () => {
  for (const status of [400, 401, 403, 404]) {
    const f = fixture({ onFetch: () => new Response("PRIVATE PHONE AND PASSWORD", { status }) })
    const response = await f.post({ contactIds: [id(1), id(2)] })
    const result = await response.json()
    assert.equal(response.status, 207)
    assert.deepEqual(result.verifiedIds, [])
    assert.equal(result.failed.length, 2)
    assert.equal(result.failed[0].status, status)
    assert.equal(f.calls.length, 2)
    assert.ok(!JSON.stringify({ result, logs: f.logs }).match(/PRIVATE|PASSWORD|TEST CONTACT|synthetic@example|synthetic-password/))
    assert.deepEqual(JSON.parse(JSON.stringify(f.logs[0])), ["phonebook_carddav_sync_failure", { contactId: id(1), stage: "upload", status }])
  }
})

test("transient quota and server failures retry within the bounded two-contact batch", async () => {
  for (const status of [429, 500, 503]) {
    let writes = 0
    const f = fixture({ onFetch: (call) => call.method === "PUT" && ++writes === 1 ? new Response(null, { status }) : undefined })
    const response = await f.post({ contactIds: [id(1)] })
    assert.equal(response.status, 200)
    assert.equal(writes, 2)
  }
  const f = fixture({ onFetch: () => new Response(null, { status: 503 }) })
  const response = await f.post({ contactIds: [id(1), id(2)] })
  assert.equal(response.status, 207)
  assert.equal(f.calls.length, 6)
  assert.equal((await response.json()).failed.length, 2)
})

test("a committed PUT followed by a read timeout retries the same deterministic card without duplicates", async () => {
  let reads = 0
  const f = fixture({ onFetch: (call) => {
    if (call.method === "GET" && ++reads === 1) throw new Error("request timed out with PRIVATE CREDENTIAL")
    return undefined
  } })
  const response = await f.post({ contactIds: [id(1)] })
  assert.equal(response.status, 200)
  assert.equal(f.remote.size, 1)
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 2)
})

test("stale or wrong returned cards never count as verified", async () => {
  const f = fixture({ onFetch: (call) => call.method === "GET" ? new Response(`BEGIN:VCARD\r\nX-BUNKER-MAP-CONTACT-ID:${id(1)}\r\nX-BUNKER-MAP-SYNC-HASH:stale\r\nEND:VCARD`) : undefined })
  const response = await f.post({ contactIds: [id(1)] })
  const result = await response.json()
  assert.equal(response.status, 207)
  assert.equal(result.verifiedCount, 0)
  assert.equal(result.failed[0].stage, "verification")
})

test("source changes during an upload prevent stale completion claims", async () => {
  const f = fixture({ onFetch: (call, _remote, rows) => {
    if (call.method === "GET") rows[0].full_name = "UPDATED WHILE SYNCING"
    return undefined
  } })
  const response = await f.post({ contactIds: [id(1)] })
  const result = await response.json()
  assert.equal(response.status, 207)
  assert.equal(result.verifiedCount, 0)
  assert.equal(result.failed[0].stage, "source-check")
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 1)
})

test("Chinese names survive byte-aware vCard folding, including structured N and astral characters", async () => {
  const fullName = "陳小明船舶供應🚢".repeat(14)
  const f = fixture({ rows: [contact(1, { full_name: fullName, notes: "多行備註資料".repeat(25) })] })
  assert.equal((await f.post({ contactIds: [id(1)] })).status, 200)
  const card = f.remote.get(id(1))!
  for (const line of card.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75, line)
  const unfolded = card.replace(/\r\n[ \t]/g, "")
  assert.ok(unfolded.includes(`FN:${fullName}\r\n`))
  assert.ok(unfolded.includes(`N:${fullName};;;;\r\n`))
  assert.ok(!card.includes("�"))
})

test("verification unfolds provider-folded identity and hash properties", async () => {
  const f = fixture({ onFetch: (call, remote) => {
    if (call.method !== "GET") return undefined
    return new Response(remote.get(call.contactId)!.replace(/(X-BUNKER-MAP-(?:CONTACT-ID|SYNC-HASH):.{12})/g, "$1\r\n "))
  } })
  assert.equal((await f.post({ contactIds: [id(1)] })).status, 200)
})

test("full resync is non-destructive and paginates over 250 contacts in stable ID order", async () => {
  const f = fixture({ rows: Array.from({ length: 251 }, (_, index) => contact(251 - index)) })
  f.remote.set("unmanaged", "KEEP THIS PRIVATE CONTACT")
  let cursor = 0
  const verifiedIds: string[] = []
  do {
    const response = await f.post({ fullRebuild: true, phase: "delete", cursor })
    const result = await response.json()
    assert.equal(response.status, 200)
    assert.equal(result.phase, "upload")
    assert.equal(result.total, 251)
    assert.ok(result.verifiedCount <= 2)
    verifiedIds.push(...result.verifiedIds)
    if (result.done) break
    assert.ok(result.nextCursor > cursor)
    cursor = result.nextCursor
  } while (cursor < 300)
  assert.deepEqual(verifiedIds, Array.from({ length: 251 }, (_, index) => id(index + 1)))
  assert.equal(f.remote.size, 252)
  assert.equal(f.remote.get("unmanaged"), "KEEP THIS PRIVATE CONTACT")
  assert.equal(f.calls.filter((call) => call.method === "DELETE" || call.method === "PROPFIND").length, 0)
  for (const query of f.queries.filter((query) => query.table === "phonebook_contacts")) {
    assert.equal(query.order, "id")
    assert.equal(query.range![1] - query.range![0], 1)
    assert.equal(query.count, "exact")
  }
})

test("old company clients fail before any partial write; explicit cursor company requests paginate", async () => {
  const f = fixture({ rows: [contact(1), contact(2), contact(3)] })
  const oldResponse = await f.post({ selectedCompany: "TEST COMPANY", cursor: null })
  assert.equal(oldResponse.status, 400)
  assert.match((await oldResponse.json()).message, /Refresh Phonebook/)
  assert.equal(f.calls.length, 0)
  const first = await (await f.post({ selectedCompany: "TEST COMPANY", cursor: 0 })).json()
  assert.equal(first.done, false)
  assert.equal(first.nextCursor, 2)
  const second = await (await f.post({ selectedCompany: "TEST COMPANY", cursor: first.nextCursor })).json()
  assert.deepEqual(second.verifiedIds, [id(3)])
  assert.equal(second.done, true)
})

test("a failed full-resync batch advances attempted progress without claiming the failed ID was verified", async () => {
  const f = fixture({ rows: [contact(1), contact(2), contact(3)], onFetch: (call) =>
    call.contactId === id(1) ? new Response(null, { status: 403 }) : undefined,
  })
  const response = await f.post({ fullRebuild: true, cursor: 0 })
  const first = await response.json()
  assert.equal(response.status, 207)
  assert.deepEqual(first.verifiedIds, [id(2)])
  assert.equal(first.failed[0].id, id(1))
  assert.equal(first.done, false)
  assert.equal(first.nextCursor, 2)
  const second = await (await f.post({ fullRebuild: true, cursor: first.nextCursor })).json()
  assert.deepEqual(second.verifiedIds, [id(3)])
  assert.equal(second.done, true)
})

test("empty full resync succeeds without destructive operations", async () => {
  const f = fixture({ rows: [] })
  const response = await f.post({ fullRebuild: true })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.total, 0)
  assert.equal(result.done, true)
  assert.equal(f.calls.length, 0)
})

test("deletions only proceed for authoritative absent rows and verify remote absence", async () => {
  const f = fixture({ rows: [contact(1)] })
  f.remote.set(id(1), "EXISTING CONTACT")
  f.remote.set(id(2), "DELETED CONTACT")
  const response = await f.post({ deleteContactIds: [id(1), id(2)] })
  const result = await response.json()
  assert.equal(response.status, 207)
  assert.deepEqual(result.verifiedIds, [id(2)])
  assert.equal(result.failed[0].id, id(1))
  assert.equal(result.failed[0].stage, "source-check")
  assert.equal(f.remote.get(id(1)), "EXISTING CONTACT")
  assert.equal(f.remote.has(id(2)), false)
  assert.equal(f.calls.filter((call) => call.method === "DELETE").length, 1)
})

test("delete retries recheck source to protect a contact restored after an upstream failure", async () => {
  const f = fixture({ rows: [], onFetch: (call, _remote, rows) => {
    if (call.method === "DELETE") { rows.push(contact(1)); return new Response(null, { status: 503 }) }
    return undefined
  } })
  const response = await f.post({ deleteContactIds: [id(1)] })
  const result = await response.json()
  assert.equal(response.status, 207)
  assert.equal(result.failed[0].stage, "source-check")
  assert.equal(f.calls.length, 1)
})

test("restoration during delete verification is reported as unverified instead of claiming success", async () => {
  const f = fixture({ rows: [], onFetch: (call, _remote, rows) => {
    if (call.method === "GET") rows.push(contact(1))
    return undefined
  } })
  const response = await f.post({ deleteContactIds: [id(1)] })
  const result = await response.json()
  assert.equal(response.status, 207)
  assert.deepEqual(result.verifiedIds, [])
  assert.equal(result.failed[0].stage, "source-check")
})

test("database failures fail closed with sanitized output and no upstream mutations", async () => {
  for (const body of [{ contactIds: [id(1)] }, { deleteContactIds: [id(1)] }]) {
    const f = fixture({ databaseError: true })
    const response = await f.post(body)
    assert.ok([207, 503].includes(response.status))
    assert.ok(!JSON.stringify({ result: await response.json(), logs: f.logs }).match(/PRIVATE|CREDENTIAL|12345678/))
    assert.equal(f.calls.length, 0)
  }
})
