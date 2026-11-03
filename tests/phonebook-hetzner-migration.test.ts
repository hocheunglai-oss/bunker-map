import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { once } from "node:events"
import type { SupabaseClient } from "@supabase/supabase-js"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"
import { buildVCard, cardHref, type PhonebookContact } from "../lib/phonebookCarddav"
import {
  loadMigrationSnapshot, migrationSnapshot, runHetznerMigration, validateMigrationTarget, validateMigrationSourceCredential,
  type MigrationCheckpoint, type MigrationOptions, type MigrationSnapshot,
} from "../lib/phonebookMigrationHetzner"

const target = { expectedOrigin: "https://nx12345.your-storageshare.de", expectedUsername: "fcuno-writer",
  addressBookUrl: "https://nx12345.your-storageshare.de/remote.php/dav/addressbooks/users/fcuno-writer/fcuno/" }
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`
function contact(number: number): PhonebookContact {
  return { id: id(number), full_name: `SYNTHETIC CONTACT ${number}`, company: "SYNTHETIC COMPANY", company_phone: "+85212345678",
    company_other_name: "測試", title: null, position: "SYNTHETIC", department: null, direct_line: null,
    mobile_1: "+85222223333", mobile_2: "+85244445555", personal_email: "fixture@example.invalid", general_email: null,
    private_email: null, notes: "Synthetic data only" }
}
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")

function fixture(count = 3) {
  const data = Array.from({ length: count }, (_, index) => contact(index + 1))
  const cards = new Map<string, { body: string; etag: string }>()
  const requests: Array<{ method: string; member: string; headers: Headers }> = []
  let sequence = 0
  let active = 0, maximumActive = 0
  let snapshotReads = 0
  const injected = { dropFirstPutResponse: false, corruptReadback: false, conflict: false, extraAtFinalInventory: false, createBeforeFirstPut: false, forceWeakEtag: false }
  let inventoryReads = 0
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, target.expectedOrigin)
    assert.equal(init?.redirect, "error")
    const member = url.pathname.slice(new URL(target.addressBookUrl).pathname.length)
    assert.ok(!member.includes("/"))
    const method = init?.method || "GET"
    const headers = new Headers(init?.headers)
    requests.push({ method, member, headers })
    assert.ok(["GET", "PUT", "PROPFIND"].includes(method), "no destructive request allowed")
    if (method === "PROPFIND") {
      const root = `<d:response><d:href>${new URL(target.addressBookUrl).pathname}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:addressbook/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
      if (headers.get("Depth") === "1") inventoryReads++
      const resources = headers.get("Depth") === "0" ? "" : [...cards].map(([name, card]) => `<d:response><d:href>${new URL(target.addressBookUrl).pathname}${name}</d:href><d:propstat><d:prop><d:getetag>${escape(card.etag)}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")
      const extra = injected.extraAtFinalInventory && inventoryReads > 1 ? `<d:response><d:href>${new URL(target.addressBookUrl).pathname}unexpected.vcf</d:href><d:propstat><d:prop><d:getetag>&quot;extra&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` : ""
      return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">${root}${resources}${extra}</d:multistatus>`, { status: 207 })
    }
    active++; maximumActive = Math.max(active, maximumActive)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    const existing = cards.get(member)
    if (method === "GET") {
      if (!existing) return new Response(null, { status: 404 })
      const etag = injected.forceWeakEtag || headers.get("Accept-Encoding") !== "identity" ? `W/${existing.etag}` : existing.etag
      return new Response(injected.corruptReadback ? existing.body.replace("+85244445555", "+85299999999") : existing.body, { headers: { ETag: etag } })
    }
    if (injected.createBeforeFirstPut) {
      injected.createBeforeFirstPut = false
      cards.set(member, { body: buildVCard(contact(9)), etag: '"concurrent-create"' })
      assert.equal(headers.get("If-None-Match"), "*")
      return new Response(null, { status: 412 })
    }
    if (injected.conflict) return new Response(null, { status: 412 })
    if (existing) assert.equal(headers.get("If-Match"), existing.etag)
    else assert.equal(headers.get("If-None-Match"), "*")
    cards.set(member, { body: String(init?.body), etag: `"revision-${++sequence}"` })
    if (injected.dropFirstPutResponse) { injected.dropFirstPutResponse = false; throw new Error("Synthetic network failure after committed upload") }
    return new Response(null, { status: existing ? 204 : 201 })
  }
  const options: MigrationOptions = { target, username: target.expectedUsername, password: "synthetic-secret", concurrency: 2,
    transport, loadSource: async () => { snapshotReads++; return migrationSnapshot(data) } }
  return { data, cards, requests, options, injected, stats: () => ({ maximumActive, snapshotReads }) }
}

test("target lock rejects wrong host, account, origin, unsafe paths and current provider", () => {
  assert.equal(validateMigrationTarget(target, target.expectedUsername).addressBookUrl, target.addressBookUrl)
  for (const addressBookUrl of [
    "http://nx12345.your-storageshare.de/remote.php/dav/addressbooks/users/fcuno-writer/fcuno/",
    target.addressBookUrl.replace("nx12345.your-storageshare.de", "use22.thegood.cloud"),
    target.addressBookUrl.replace("nx12345.your-storageshare.de", "nx12345.your-storageshare.de.evil.invalid"),
    `${target.addressBookUrl}?token=secret`, target.addressBookUrl.replace("fcuno/", "nested/book/"),
    target.addressBookUrl.replace("fcuno/", "encoded%2Fbook/"), target.addressBookUrl.replace("fcuno/", "other/../fcuno/"),
  ]) assert.throws(() => validateMigrationTarget({ ...target, addressBookUrl }, target.expectedUsername))
  assert.throws(() => validateMigrationTarget(target, "someone-else"))
  assert.throws(() => validateMigrationTarget(target, target.expectedUsername, target.addressBookUrl))
})

test("dry run never uploads, deletes, or changes checkpoints", async () => {
  const f = fixture()
  let saved = 0
  const result = await runHetznerMigration({ ...f.options, saveCheckpoint: async () => { saved++ } })
  assert.equal(result.wouldUpload, 3)
  assert.equal(result.uploaded, 0)
  assert.equal(result.candidateVerified, false)
  assert.equal(result.cutoverPerformed, false)
  assert.equal(saved, 0)
  assert.ok(f.requests.every(request => request.method !== "PUT"))
})

test("preflight accepts unsupported collection ETag only when addressbook resourcetype succeeded", async () => {
  const f = fixture(1)
  const transport: typeof fetch = async (input, init) => {
    const response = await f.options.transport!(input, init)
    if (new Headers(init?.headers).get("Depth") !== "0") return response
    assert.ok(!String(init?.body).includes("getetag"))
    const xml = (await response.text()).replace("</d:response>", '<d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>')
    return new Response(xml, { status: 207 })
  }
  assert.equal((await runHetznerMigration({ ...f.options, transport, apply: true })).candidateVerified, true)
  const rejected: typeof fetch = async (input, init) => {
    const response = await transport(input, init)
    return new Response((await response.text()).replace("200 OK", "404 Not Found"), { status: response.status })
  }
  await assert.rejects(runHetznerMigration({ ...f.options, transport: rejected }), /verified CardDAV/)
})

function sourceFixture(countOffset = 0) {
  const tables: Record<string, Array<Record<string, unknown> & { id: string }>> = {
    phonebook_contacts: Array.from({ length: 5 }, (_, index) => ({ ...contact(index + 1), company: "synthetic company" })),
    phonebook_companies: [{ id: id(101), name: "SYNTHETIC COMPANY", other_name: "測試", country: "HK",
      tel_country: "852", tel_area: null, tel_no_1: "12345678", phone: null }],
  }
  const reads: Array<{ table: string; after?: string; fields: string }> = []
  const client = { from: (table: string) => ({ select: (fields: string, options?: { count?: string }) => {
    let after: string | undefined
    const query = {
      order: () => query, limit: () => query, gt: (_field: string, value: string) => { after = value; return query },
      then: (resolve: (result: { data: Record<string, unknown>[]; error: null; count: number | null }) => unknown) => {
        reads.push({ table, after, fields })
        const data = tables[table].filter(row => !after || row.id > after).slice(0, 2)
          .map(row => Object.fromEntries(fields.split(",").map(field => [field, row[field]])))
        return Promise.resolve({ data, error: null, count: options?.count ? tables[table].length + countOffset : null }).then(resolve)
      },
    }
    return query
  } }) } as unknown as SupabaseClient
  return { client, tables, reads }
}

test("source loader verifies complete counts across server-capped pages and joins every company field", async () => {
  const f = sourceFixture()
  const snapshot = await loadMigrationSnapshot(f.client)
  assert.equal(snapshot.cards.length, 5)
  assert.equal(snapshot.hash, migrationSnapshot(Array.from({ length: 5 }, (_, index) => ({ ...contact(index + 1), company: "synthetic company", company_phone: "12345678" }))).hash)
  assert.equal(f.reads.filter(read => read.table === "phonebook_contacts").length, 3)
  assert.ok(snapshot.cards.every(card => card.vcard.includes("+85244445555") && card.vcard.includes("測試")))
})

test("source loader rejects incomplete counts and ambiguous company projection", async () => {
  await assert.rejects(loadMigrationSnapshot(sourceFixture(1).client), /row count/)
  const f = sourceFixture()
  f.tables.phonebook_companies.push({ ...f.tables.phonebook_companies[0], id: id(102), name: "synthetic company", tel_no_1: "99999999" })
  await assert.rejects(loadMigrationSnapshot(f.client), /Ambiguous company/)
})

test("uploads with bounded concurrency and verifies every field and exact inventory", async () => {
  const f = fixture(7)
  const result = await runHetznerMigration({ ...f.options, apply: true })
  assert.equal(result.uploaded, 7)
  assert.equal(result.verifiedCount, 7)
  assert.equal(result.candidateVerified, true)
  assert.equal(result.sourceUnchanged, true)
  assert.equal(f.stats().snapshotReads, 3)
  assert.equal(f.stats().maximumActive, 2)
  assert.equal(f.requests.filter(request => request.method === "GET").length, 7, "empty-book import needs only one readback per created contact")
  assert.equal(f.requests.filter(request => request.method === "PUT").length, 7)
  assert.ok([...f.cards.values()].every(card => card.body.includes("+85244445555")))
})

test("requests identity representation but still rejects an ETag that remains weak", async () => {
  const f = fixture(1)
  const imported = await runHetznerMigration({ ...f.options, apply: true })
  assert.equal(imported.candidateVerified, true)
  assert.ok(f.requests.every(request => request.headers.get("Accept-Encoding") === "identity"))
  f.injected.forceWeakEtag = true
  const resumed = await runHetznerMigration({ ...f.options, apply: true })
  assert.equal(resumed.failed, 1)
  assert.equal(resumed.candidateVerified, false)
  assert.equal(f.requests.filter(request => request.method === "PUT").length, 1, "a weak ETag must never be promoted for an update")
})

test("restart rechecks remote state after committed upload even without checkpoint acknowledgement", async () => {
  const f = fixture(1)
  let checkpoint: MigrationCheckpoint | undefined
  f.injected.dropFirstPutResponse = true
  const failed = await runHetznerMigration({ ...f.options, apply: true, saveCheckpoint: async value => { checkpoint = structuredClone(value) } })
  assert.equal(failed.failed, 1)
  assert.equal(checkpoint, undefined)
  assert.equal(f.cards.size, 1)
  const resumed = await runHetznerMigration({ ...f.options, apply: true, checkpoint, saveCheckpoint: async value => { checkpoint = structuredClone(value) } })
  assert.equal(resumed.uploaded, 0)
  assert.equal(resumed.unchanged, 1)
  assert.equal(resumed.candidateVerified, true)
  assert.equal(f.requests.filter(request => request.method === "PUT").length, 1)
  assert.equal(Object.keys(checkpoint!.verified).length, 1)
})

test("checkpoint writes are batched, immutable, serialized, and flushed after the final partial batch", async () => {
  const f = fixture(123)
  const saved: MigrationCheckpoint[] = []
  let active = 0, maximumActive = 0
  const result = await runHetznerMigration({ ...f.options, apply: true, concurrency: 8, saveCheckpoint: async value => {
    active++; maximumActive = Math.max(maximumActive, active)
    saved.push(value)
    await new Promise(resolve => setTimeout(resolve, 40))
    active--
  } })
  assert.equal(result.candidateVerified, true)
  assert.deepEqual(saved.map(value => Object.keys(value.verified).length), [50, 100, 123])
  assert.equal(maximumActive, 1)
  assert.equal(active, 0)
})

test("a partial upload failure flushes verified progress and resumes without rewriting those contacts", async () => {
  const f = fixture(57)
  const saved: MigrationCheckpoint[] = []
  const transport: typeof fetch = (input, init) => init?.method === "PUT" && String(input).endsWith(cardHref(id(54)))
    ? Promise.resolve(new Response(null, { status: 503 })) : f.options.transport!(input, init)
  const result = await runHetznerMigration({ ...f.options, transport, apply: true, concurrency: 1,
    saveCheckpoint: async value => { saved.push(value) } })
  assert.equal(result.failed, 1)
  assert.equal(result.candidateVerified, false)
  assert.deepEqual(saved.map(value => Object.keys(value.verified).length), [50, 53])
  const resumed = await runHetznerMigration({ ...f.options, apply: true, checkpoint: saved.at(-1) })
  assert.equal(resumed.unchanged, 53)
  assert.equal(resumed.uploaded, 4)
  assert.equal(resumed.candidateVerified, true)
})

test("periodic and final checkpoint failures reject readiness without retrying a failed save", async () => {
  for (const count of [1, 55]) {
    const f = fixture(count)
    let attempts = 0
    await assert.rejects(runHetznerMigration({ ...f.options, apply: true, concurrency: 1, saveCheckpoint: async () => {
      attempts++
      throw new Error("Synthetic checkpoint write failure")
    } }), /Synthetic checkpoint write failure/)
    assert.equal(attempts, 1)
    assert.equal(f.cards.size, Math.min(count, 50))
    assert.equal(f.stats().snapshotReads, 2, "verification cannot report readiness after a failed checkpoint")
  }
})

test("final checkpoint includes an in-flight success that completes after another worker fails", async () => {
  const f = fixture(2)
  let saved: MigrationCheckpoint | undefined
  const transport: typeof fetch = (input, init) => init?.method === "PUT" && String(input).endsWith(cardHref(id(1)))
    ? Promise.resolve(new Response(null, { status: 503 })) : f.options.transport!(input, init)
  const result = await runHetznerMigration({ ...f.options, transport, apply: true,
    saveCheckpoint: async value => { saved = value } })
  assert.equal(result.failed, 1)
  assert.equal(result.verifiedCount, 1)
  assert.deepEqual(Object.keys(saved!.verified), [id(2)])
})

test("unchanged contacts preserve destination REV and do not cause PUTs", async () => {
  const f = fixture(1)
  const body = buildVCard(f.data[0]).replace(/REV:[^\r]+/, "REV:20000101T000000Z")
  f.cards.set(cardHref(id(1)), { body, etag: '"existing"' })
  const result = await runHetznerMigration({ ...f.options, apply: true })
  assert.equal(result.unchanged, 1)
  assert.equal(result.candidateVerified, true)
  assert.equal(f.cards.get(cardHref(id(1)))!.body, body)
  assert.equal(f.requests.filter(request => request.method === "PUT").length, 0)
})

test("stale markers cannot conceal corrupted second mobile in readback", async () => {
  const f = fixture(1)
  f.injected.corruptReadback = true
  const result = await runHetznerMigration({ ...f.options, apply: true })
  assert.equal(result.failed, 1)
  assert.equal(result.candidateVerified, false)
})

test("existing unmanaged resource at a canonical filename is never overwritten", async () => {
  const f = fixture(1)
  f.cards.set(cardHref(id(1)), { body: buildVCard(contact(9)), etag: '"collision"' })
  const result = await runHetznerMigration({ ...f.options, apply: true })
  assert.equal(result.failed, 1)
  assert.ok(f.requests.every(request => request.method !== "PUT"))
})

test("conditional conflict blocks readiness without blind retry", async () => {
  const f = fixture(1)
  f.injected.conflict = true
  const result = await runHetznerMigration({ ...f.options, apply: true })
  assert.equal(result.failed, 1)
  assert.equal(result.candidateVerified, false)
  assert.equal(f.requests.filter(request => request.method === "PUT").length, 1)
})

test("creation after initial inventory cannot be overwritten by the faster conditional import", async () => {
  const f = fixture(1)
  f.injected.createBeforeFirstPut = true
  const result = await runHetznerMigration({ ...f.options, apply: true })
  assert.equal(result.failed, 1)
  assert.equal(result.uploaded, 0)
  assert.equal(result.candidateVerified, false)
  assert.ok(f.cards.get(cardHref(id(1)))!.body.includes(`UID:bunker-map-${id(9)}`))
  assert.equal(f.requests.filter(request => request.method === "GET").length, 0)
  assert.equal(f.requests.filter(request => request.method === "PUT").length, 1)
})

test("source edits during upload or pagination block candidate verification", async () => {
  const f = fixture(1)
  let reads = 0
  const loadSource = async (): Promise<MigrationSnapshot> => {
    reads++
    return migrationSnapshot(reads >= 3 ? [{ ...f.data[0], mobile_2: "+85200000000" }] : f.data)
  }
  const result = await runHetznerMigration({ ...f.options, apply: true, loadSource })
  assert.equal(result.sourceUnchanged, false)
  assert.equal(result.candidateVerified, false)
  reads = 1
  await assert.rejects(runHetznerMigration({ ...f.options, apply: true, loadSource }), /Source changed/)
})

test("extra initial contacts block writes; extras appearing later block readiness", async () => {
  const f = fixture(1)
  f.cards.set("personal.vcf", { body: buildVCard(contact(9)), etag: '"personal"' })
  await assert.rejects(runHetznerMigration({ ...f.options, apply: true }), /extra contacts/)
  assert.ok(f.requests.every(request => request.method !== "PUT"))
  f.cards.clear()
  f.injected.extraAtFinalInventory = true
  const clean = fixture(1)
  clean.injected.extraAtFinalInventory = true
  const result = await runHetznerMigration({ ...clean.options, apply: true })
  assert.equal(result.exactInventoryVerified, false)
  assert.equal(result.candidateVerified, false)
})

test("redirects and checkpoint mismatches fail closed before reading source", async () => {
  const f = fixture(1)
  await assert.rejects(runHetznerMigration({ ...f.options, transport: async () => new Response(null, { status: 302 }) }), /redirects/)
  assert.equal(f.stats().snapshotReads, 0)
  await assert.rejects(runHetznerMigration({ ...f.options, checkpoint: { version: 1, sourceProject: "wrong", targetHash: "wrong", verified: {} } }), /Checkpoint/)
  assert.equal(f.requests.length, 0)
})

test("empty or duplicated source data cannot become a migration snapshot", () => {
  assert.throws(() => migrationSnapshot([]), /empty/)
  assert.throws(() => migrationSnapshot([contact(1), contact(1)]), /duplicated/)
})

test("browser credentials and credentials for another project cannot read a partial source", () => {
  const jwt = (payload: object) => `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
  validateMigrationSourceCredential(jwt({ role: "service_role", ref: fcunoConnectionPolicy.supabase.projectRef }))
  validateMigrationSourceCredential("sb_secret_synthetic-only")
  for (const key of ["sb_publishable_fixture", "not-a-key", jwt({ role: "anon", ref: fcunoConnectionPolicy.supabase.projectRef }),
    jwt({ role: "service_role", ref: "another-project" })]) assert.throws(() => validateMigrationSourceCredential(key), /server credential/)
})

test("synthetic HTTP integration verifies upload, restart, and request conditions through a loopback fixture", async () => {
  const f = fixture(4)
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const result = await f.options.transport!(new URL(request.url!, target.expectedOrigin), {
        method: request.method, redirect: "error", headers: request.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined,
      })
      response.writeHead(result.status, Object.fromEntries(result.headers))
      response.end(Buffer.from(await result.arrayBuffer()))
    } catch { response.writeHead(500); response.end("Synthetic fixture error") }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const loopback = `http://127.0.0.1:${address.port}`
  // Only the test transport maps the already validated HTTPS target to this
  // synthetic local server. Production CLI has no TLS or host override.
  const transport: typeof fetch = (input, init) => fetch(`${loopback}${new URL(String(input)).pathname}`, init)
  try {
    const first = await runHetznerMigration({ ...f.options, transport, apply: true })
    assert.equal(first.candidateVerified, true)
    const second = await runHetznerMigration({ ...f.options, transport, apply: true })
    assert.equal(second.uploaded, 0)
    assert.equal(second.unchanged, 4)
    assert.equal(second.candidateVerified, true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
