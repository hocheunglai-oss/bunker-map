import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import test from "node:test"
import ts from "typescript"

const compile = (file: string) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
const sharedOutput = compile("../lib/phonebookCarddav.ts")
const engineOutput = compile("../lib/phonebookCarddavReconcile.ts")
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const path = (n: number) => `/book/bunker-map-${id(n)}.vcf`
const vcard = (name = "PRIVATE NAME") => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nTEL:PRIVATE PHONE\r\nEND:VCARD\r\n`
const card = () => ({ vcard: vcard(), etag: '"original"' })
type Row = Record<string, any>
type Call = { method: string; path: string; init: RequestInit }

function fixture(options: {
  count?: number; backupFails?: boolean; corruptBackup?: boolean; queueFails?: boolean
  lockBusy?: boolean; onFetch?: (call: Call, f: ReturnType<typeof fixture>) => Response | void | Promise<Response | void>
} = {}) {
  const contacts: Row[] = Array.from({ length: options.count ?? 2 }, (_, n) => ({
    id: id(n + 1), full_name: `PRIVATE CONTACT ${n + 1}`, company: null, position: null,
  }))
  const remote = new Map<string, { vcard: string; etag: string }>(contacts.map((_c, i) => [path(i + 1), card()]))
  const queue: Row[] = []
  const backups: Row[] = []
  const calls: Call[] = []
  const log: unknown[] = []
  let owner: string | null = null
  let failNextLease = false
  const database = {
    async rpc(name: string, args: Row) {
      if (name === "claim_bunker_map_backup_lock") {
        if (options.lockBusy || failNextLease) return { data: false, error: null }
        assert.equal(args.p_lock_name, "phonebook-carddav-writes")
        if (owner && owner !== args.p_run_id) return { data: false, error: null }
        owner = args.p_run_id
        return { data: true, error: null }
      }
      if (name === "release_bunker_map_backup_lock") {
        if (owner === args.p_run_id) owner = null
        return { data: true, error: null }
      }
      if (name === "enqueue_phonebook_carddav") {
        for (const contactId of args.p_contact_ids) {
          const existing = queue.find((item) => item.contact_id === contactId)
          const next = { contact_id: contactId, version: randomUUID(), attempts: 0, queued_at: new Date(0).toISOString(), next_attempt_at: new Date(0).toISOString() }
          if (existing) Object.assign(existing, next)
          else queue.push(next)
        }
        return { data: true, error: null }
      }
      throw new Error(`Unexpected RPC: ${name}`)
    },
    from(table: string) {
      const rows = table === "phonebook_contacts" ? contacts : table === "phonebook_companies" ? [] : table === "phonebook_carddav_queue" ? queue : table === "phonebook_carddav_quarantine" ? backups : null
      assert.ok(rows, table)
      const filters: Array<(row: Row) => boolean> = []
      let start = 0, end = Infinity, single = false, operation = "select", values: Row = {}
      const builder = {
        select() { return builder },
        order() { return builder },
        range(a: number, b: number) { start = a; end = b + 1; return builder },
        limit(n: number) { end = n; return builder },
        eq(key: string, value: unknown) { filters.push((r) => r[key] === value); return builder },
        in(key: string, values: unknown[]) { filters.push((r) => values.includes(r[key])); return builder },
        lte(key: string, value: unknown) { filters.push((r) => r[key] <= value!); return builder },
        single() { single = true; return builder },
        maybeSingle() { single = true; return builder },
        delete() { operation = "delete"; return builder },
        update(data: Row) { operation = "update"; values = data; return builder },
        upsert(data: Row, config: Row) {
          assert.equal(config.ignoreDuplicates, true)
          assert.equal(config.onConflict, table === "phonebook_carddav_queue" ? "contact_id" : "address_book_hash,resource_path,content_sha256")
          operation = "upsert"; values = data; return builder
        },
        then(resolve: (v: any) => any, reject: (e: unknown) => any) {
          if ((table === "phonebook_carddav_quarantine" && options.backupFails) || (table === "phonebook_carddav_queue" && options.queueFails)) return Promise.resolve({ error: new Error("PRIVATE DATABASE ERROR"), data: null }).then(resolve, reject)
          if (operation === "upsert") {
            if (table === "phonebook_carddav_queue") {
              for (const value of values as Row[]) if (!rows.some((r) => r.contact_id === value.contact_id)) rows.push({ version: randomUUID(), attempts: 0, queued_at: new Date(0).toISOString(), next_attempt_at: new Date(0).toISOString(), ...value })
            } else if (!rows.some((r) => r.resource_path === values.resource_path && r.content_sha256 === values.content_sha256 && r.address_book_hash === values.address_book_hash)) rows.push({ id: randomUUID(), ...values })
          }
          const selected = rows.filter((r) => filters.every((filter) => filter(r))).slice(start, end)
          if (operation === "delete") for (const row of selected) rows.splice(rows.indexOf(row), 1)
          if (operation === "update") for (const row of selected) Object.assign(row, values)
          let data = structuredClone(single ? selected[0] || null : selected)
          if (options.corruptBackup && table === "phonebook_carddav_quarantine" && single) (data as Row).vcard += "CORRUPTED"
          return Promise.resolve({ data, error: null, count: selected.length }).then(resolve, reject)
        },
      }
      return builder
    },
  }
  const shared: Row = {}
  const engine: Row = {}
  const context = {
    Error, URL, Buffer, AbortSignal, TextDecoder, setTimeout: (callback: () => void) => setTimeout(callback, 0),
    process: { env: { CARDDAV_ADDRESSBOOK_URL: "https://carddav-fixture.invalid/book/", CARDDAV_USERNAME: "test", CARDDAV_PASSWORD: "test" } },
    console: { info: (...items: unknown[]) => log.push(items), error: (...items: unknown[]) => log.push(items) },
    require: (name: string) => {
      if (name === "node:crypto") return { createHash, randomUUID }
      if (name === "./phonebookCarddav") return shared
      throw new Error(`Unexpected dependency ${name}`)
    },
    fetch: async (url: string, init: RequestInit) => {
      const parsed = new URL(url)
      assert.equal(parsed.origin, "https://carddav-fixture.invalid")
      assert.equal(init.redirect, "error")
      const call = { method: init.method || "GET", path: parsed.pathname, init }
      calls.push(call)
      const custom = await options.onFetch?.(call, f)
      if (custom) return custom
      if (call.method === "PROPFIND") return new Response(`<d:multistatus xmlns:d="DAV:">${[...remote].map(([key, value]) => `<d:response><d:href>${key}</d:href><d:propstat><d:prop><d:getetag>${value.etag.replaceAll('"', "&quot;")}</d:getetag><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")}</d:multistatus>`, { status: 207 })
      if (call.method === "PUT") { remote.set(call.path, { vcard: String(init.body), etag: '"updated"' }); return new Response(null, { status: 204 }) }
      if (call.method === "DELETE") {
        const item = remote.get(call.path)
        assert.ok(backups.some((b) => b.resource_path === call.path && b.vcard === item?.vcard), "Deletion must have a durable original backup")
        if (new Headers(init.headers).get("If-Match") !== item?.etag) return new Response(null, { status: 412 })
        remote.delete(call.path); return new Response(null, { status: 204 })
      }
      const item = remote.get(call.path)
      return new Response(item?.vcard || null, { status: item ? 200 : 404, headers: item ? { ETag: item.etag } : {} })
    },
  }
  vm.runInNewContext(sharedOutput, { ...context, exports: shared })
  vm.runInNewContext(engineOutput, { ...context, exports: engine })
  const f = { contacts, remote, queue, backups, calls, log, database, shared, engine,
    run: () => engine.runPhonebookCarddavReconcile(database),
    loseLease: () => { failNextLease = true },
    enqueue: (contactId: string) => database.rpc("enqueue_phonebook_carddav", { p_contact_ids: [contactId] }),
  }
  return f
}

test("removes five extras only after recoverable backups and verifies the exact mirror", async () => {
  const f = fixture({ count: 10 })
  for (let i = 0; i < 5; i++) f.remote.set(`/book/extra-${i}.vcf`, card())
  const result = await f.run()
  assert.equal(result.verified, true)
  assert.equal(result.saved, 10)
  assert.equal(result.total, 10)
  assert.equal(result.removed, 5)
  assert.equal(f.backups.length, 5)
  assert.ok(f.backups.every((backup) => backup.deleted_at && backup.vcard === vcard()))
  assert.ok(!JSON.stringify(f.log).match(/PRIVATE|\/book\/|https:/))
})

test("missing current contacts are recreated without deleting healthy contacts", async () => {
  const f = fixture()
  f.remote.delete(path(1))
  f.remote.set("/book/extra.vcf", card())
  const result = await f.run()
  assert.equal(result.repaired, 1)
  assert.equal(result.removed, 1)
  assert.equal(result.verified, true)
  assert.ok(f.calls.findIndex((c) => c.method === "PUT") < f.calls.findIndex((c) => c.method === "DELETE"))
  assert.equal(f.queue.length, 0)
})

test("orphan deletions retain full backups and acknowledge durable delete queue", async () => {
  const f = fixture()
  f.remote.set(path(3), card())
  await f.enqueue(id(3))
  assert.equal((await f.run()).verified, true)
  assert.equal(f.backups[0].reason, "orphan")
  assert.equal(f.queue.length, 0)
})

test("backup failure or corrupted readback prevents every deletion", async () => {
  for (const option of [{ backupFails: true }, { corruptBackup: true }]) {
    const f = fixture(option)
    f.remote.set("/book/extra.vcf", card())
    await assert.rejects(f.run())
    assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 0)
    assert.equal(f.remote.size, 3)
  }
})

test("weak ETags and invalid or oversized vCards cannot be deleted", async () => {
  for (const item of [{ etag: 'W/"weak"', vcard: vcard() }, { etag: '"strong"', vcard: "Not a vCard" }, { etag: '"strong"', vcard: "\uFEFF" + vcard() }, { etag: '"strong"', vcard: vcard("x".repeat(1_000_000)) }]) {
    const f = fixture()
    f.remote.set("/book/extra.vcf", item)
    await assert.rejects(f.run())
    assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 0)
  }
})

test("a changed card at DELETE is preserved by If-Match and original backup remains", async () => {
  const f = fixture({ onFetch: (call, f) => {
    if (call.method === "DELETE") { f.remote.set(call.path, { etag: '"concurrent-edit"', vcard: vcard("NEW DETAILS") }); return new Response(null, { status: 412 }) }
  } })
  f.remote.set("/book/extra.vcf", card())
  await assert.rejects(f.run())
  assert.equal(f.backups.length, 1)
  assert.ok(!f.backups[0].deleted_at)
  assert.match(f.remote.get("/book/extra.vcf")!.vcard, /NEW DETAILS/)
})

test("concurrent source changes prevent automatic cleanup", async () => {
  const f = fixture({ onFetch: (call, f) => {
    if (call.method === "GET" && call.path.endsWith("extra.vcf")) f.contacts.push({ id: id(3), full_name: "ADDED" })
  } })
  f.remote.set("/book/extra.vcf", card())
  await assert.rejects(f.run())
  assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 0)
})

test("lost writer lease blocks cleanup even after successful backup", async () => {
  const f = fixture({ onFetch: (call, f) => { if (call.method === "GET" && call.path.endsWith("extra.vcf")) f.loseLease() } })
  f.remote.set("/book/extra.vcf", card())
  await assert.rejects(f.run())
  assert.equal(f.backups.length, 1)
  assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 0)
})

test("an empty source or busy common lock never clears the shared book", async () => {
  for (const option of [{ count: 0 }, { lockBusy: true }]) {
    const f = fixture(option)
    f.remote.set("/book/extra.vcf", card())
    await assert.rejects(f.run())
    assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 0)
  }
})

test("unexpected bulk extras trip the deletion safety limit", async () => {
  const f = fixture()
  for (let i = 0; i < 6; i++) f.remote.set(`/book/extra-${i}.vcf`, card())
  const result = await f.run()
  assert.equal(result.blocked, "removal-safety-limit")
  assert.equal(result.verified, false)
  assert.equal(result.removed, 0)
})

test("failed repair retains durable work, backs off, and blocks extra deletion", async () => {
  const f = fixture({ onFetch: (call) => call.method === "PUT" ? new Response(null, { status: 403 }) : undefined })
  f.remote.delete(path(1))
  f.remote.set("/book/extra.vcf", card())
  const result = await f.run()
  assert.equal(result.verified, false)
  assert.equal(result.blocked, "missing-contacts")
  assert.equal(result.pending, 1)
  assert.equal(f.queue[0].attempts, 1)
  assert.ok(Date.parse(f.queue[0].next_attempt_at) > Date.now())
  assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 0)
})

test("acknowledgment cannot erase a newer contact mutation", async () => {
  let changed = false
  const f = fixture({ onFetch: async (call, f) => {
    if (call.method === "GET" && call.path === path(1) && !changed) { changed = true; await f.enqueue(id(1)) }
  } })
  await f.enqueue(id(1))
  const result = await f.run()
  assert.equal(result.pending, 1)
  assert.equal(result.verified, false)
  assert.equal(f.queue.length, 1)
})

test("strict cleanup inventories reject foreign, nested, partial, and ambiguous members", () => {
  const f = fixture()
  for (const xml of [
    '<d:multistatus xmlns:d="DAV:">',
    '<multistatus><response><href>https://foreign.invalid/book/extra.vcf</href><status>HTTP/1.1 200 OK</status><getetag>"x"</getetag></response></multistatus>',
    '<multistatus><response><href>/book/nested/extra.vcf</href><status>HTTP/1.1 200 OK</status><getetag>"x"</getetag></response></multistatus>',
    '<multistatus><response><href>/book/extra.vcf</href><status>HTTP/1.1 403 Forbidden</status></response></multistatus>',
    '<multistatus><response><href>/book/extra.vcf</href><status>HTTP/1.1 200 OK</status></response></multistatus>',
  ]) assert.throws(() => f.engine.parseReconcileInventory(xml, "https://carddav-fixture.invalid/book/"))
})

test("the collection root may have 404 getetag while every actual card is complete", () => {
  const f = fixture()
  const xml = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/book/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response><d:response><d:href>/book/extra.vcf</d:href><d:propstat><d:prop><d:getetag>&quot;good&quot;</d:getetag><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
  const result = f.engine.parseReconcileInventory(xml, "https://carddav-fixture.invalid/book/")
  assert.equal(result.length, 1)
  assert.equal(result[0].etag, '"good"')
})

test("inventory repair discovery preserves an existing version and retry backoff", async () => {
  const f = fixture()
  f.remote.delete(path(1))
  await f.enqueue(id(1))
  f.queue[0].attempts = 4
  f.queue[0].next_attempt_at = new Date(Date.now() + 3600_000).toISOString()
  const version = f.queue[0].version
  const result = await f.run()
  assert.equal(result.verified, false)
  assert.equal(f.queue[0].version, version)
  assert.equal(f.queue[0].attempts, 4)
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 0)
})

test("a source change during final remote verification cannot claim an exact match", async () => {
  let lists = 0
  const f = fixture({ onFetch: (call, f) => {
    if (call.method === "PROPFIND" && ++lists === 3) f.contacts.push({ id: id(3), full_name: "ADDED" })
  } })
  await assert.rejects(f.run())
  assert.ok(!f.log.some((item) => JSON.stringify(item).includes('"verified":true')))
})
