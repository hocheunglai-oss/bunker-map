import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import { buildVCard, buildCompanyPhone } from "../lib/phonebookCarddav"
import { observePhonebookCarddavSemanticShadow, PHONEBOOK_SEMANTIC_SHADOW_WINDOW } from "../lib/phonebookCarddavSemanticShadow"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const origin = "https://gglyugbrnyvyfktgwert.supabase.co", book = "https://p00-contacts.icloud.com/123/carddavhome/card/"
const company = { name: "SYNTHETIC COMPANY", other_name: "OTHER SYNTHETIC", country: "TEST", tel_country: "000", tel_area: "00", tel_no_1: "0000", phone: null }
const rows = [1, 2].map((n) => ({ id: id(n), full_name: `SYNTHETIC ${n}`, company: company.name, company_phone: buildCompanyPhone(company), company_other_name: company.other_name, title: null, position: "TEST", department: null, direct_line: null, mobile_1: "+000-000-0001", mobile_2: null, personal_email: `synthetic-${n}@example.invalid`, general_email: null, private_email: null, notes: "SYNTHETIC NOTES" }))
const fakeNow = Date.parse("2026-10-21T07:00:00Z")
const active = { approved: true, startsAt: new Date(fakeNow - 1000).toISOString(), expiresAt: new Date(fakeNow + 60_000).toISOString() }
type Options = {
  disabled?: boolean; expired?: boolean; future?: boolean; longWindow?: boolean; invalidCommit?: boolean; preview?: boolean; lowBudget?: boolean
  mismatch?: boolean; unsupported?: boolean; sourceChanged?: boolean; missing?: boolean; oversize?: boolean; invalidUtf8?: boolean
  privateError?: boolean; sourceFailure?: boolean; noCompany?: boolean; companyFallback?: boolean; oneContact?: boolean; lateBody?: boolean
  hungProvider?: boolean; hungSource?: boolean; hungStream?: boolean; totalTimeout?: boolean; loggingFails?: boolean; invalidSource?: boolean
  attack?: { url: string; method: string }; omittedFields?: boolean; invalidBook?: string; elapsedMs?: number; wallMs?: number
}
async function fixture(options: Options = {}) {
  const keys = ["CARDDAV_ADDRESSBOOK_URL", "CARDDAV_USERNAME", "CARDDAV_PASSWORD"] as const
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, { CARDDAV_ADDRESSBOOK_URL: options.invalidBook || book, CARDDAV_USERNAME: "SYNTHETIC PRIVATE USER", CARDDAV_PASSWORD: "SYNTHETIC PRIVATE PASSWORD" })
  const calls: Array<{ url: URL; method: string }> = [], logs: Array<{ event: string; summary: Record<string, any> }> = []
  const timers = new Set<ReturnType<typeof setTimeout>>(), timerDelays: number[] = []
  let activeStreams = 0, abortedRequests = 0, cancelledStreams = 0, clientCreations = 0
  const chosen = (options.oneContact ? rows.slice(0, 1) : rows).map((row) => ({ ...row, ...(options.noCompany ? { company: null, company_phone: null, company_other_name: null } : {}), ...(options.omittedFields ? { mobile_1: null, personal_email: null, notes: null, position: null, company: null, company_phone: null, company_other_name: null } : {}) }))
  const send: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource)), method = String(init?.method || "GET")
    calls.push({ url, method }); assert.equal(method, "GET", "No source/provider write is permitted")
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert.ok(init?.signal)
    if (url.origin === origin) {
      if (options.hungSource) return new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => { abortedRequests += 1; reject(new Error("PRIVATE SOURCE TIMEOUT")) }, { once: true }) })
      if (options.sourceFailure) return Response.json({ message: "PRIVATE SOURCE FIELD AND KEY" }, { status: 503 })
      if (url.pathname.endsWith("phonebook_companies")) return Response.json(options.companyFallback ? [] : [company])
      assert.equal(url.pathname, "/rest/v1/phonebook_contacts")
      let data = chosen
      if (options.sourceChanged && url.searchParams.has("id")) data = chosen.map((row) => ({ ...row, notes: "CHANGED PRIVATE SOURCE" }))
      return new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "content-range": `0-${data.length - 1}/${data.length}` } })
    }
    assert.equal(url.origin, new URL(book).origin)
    const row = chosen.find((row) => url.pathname.endsWith(`bunker-map-${row.id}.vcf`)); assert.ok(row)
    if (options.lateBody) return new Promise((resolve) => {
      init!.signal!.addEventListener("abort", () => {
        activeStreams += 1
        resolve(new Response(new ReadableStream({ cancel() { activeStreams -= 1; cancelledStreams += 1 } })))
      }, { once: true })
    })
    if (options.hungProvider || options.totalTimeout) return new Promise((_resolve, reject) => {
      const aborted = () => { abortedRequests += 1; reject(new Error("PRIVATE NETWORK CREDENTIAL")) }
      init!.signal!.addEventListener("abort", aborted, { once: true })
    })
    if (options.privateError) throw new Error("PRIVATE PROVIDER NAME PHONE PASSWORD")
    if (options.missing) return new Response("PRIVATE REMOTE CARD", { status: 404 })
    if (options.hungStream) {
      activeStreams += 1
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("BEGIN:VCARD\r\n")) }, cancel() { activeStreams -= 1; cancelledStreams += 1 } }))
    }
    if (options.oversize) return new Response("a".repeat(1_000_001))
    if (options.invalidUtf8) return new Response(new Uint8Array([255, 255]))
    let card = buildVCard(row)
    if (options.mismatch) card = card.replace(`FN:${row.full_name}`, "FN:PRIVATE WRONG PERSON")
    if (options.unsupported) card = card.replace("VERSION:3.0", "VERSION:4.0")
    return new Response(card)
  }
  const input = { sourceUrl: options.invalidSource ? "https://wrong-project.supabase.co" : origin, serviceRoleKey: "SYNTHETIC-PRIVATE-SERVICE-KEY", requestStartedMonotonicMs: options.elapsedMs !== undefined ? -options.elapsedMs : options.lowBudget ? -280_000 : 0 }
  const setTimer = ((callback: () => void, delay: number) => {
    timerDelays.push(delay)
    const scaled = options.totalTimeout ? delay === 10_000 ? 5 : 1000 : options.hungProvider || options.hungSource || options.hungStream || options.lateBody ? delay === 10_000 ? 1000 : 5 : delay
    const handle = setTimeout(() => { timers.delete(handle); callback() }, scaled); timers.add(handle); return handle
  }) as typeof setTimeout
  const clearTimer = ((handle: ReturnType<typeof setTimeout>) => { timers.delete(handle); clearTimeout(handle) }) as typeof clearTimeout
  const factory: typeof createClient = options.attack ? ((url: string, key: string, settings: any) => {
    clientCreations += 1
    const attack = options.attack!
    const request = () => settings.global.fetch(attack.url, { method: attack.method, headers: { apikey: key, Authorization: `Bearer ${key}` } })
    const query = { select() { return query }, order() { return query }, range() { return query }, then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) { return request().then(() => resolve({ data: [], error: null }), reject) } }
    return { from: () => query }
  }) as unknown as typeof createClient : ((...args: Parameters<typeof createClient>) => { clientCreations += 1; return createClient(...args) }) as typeof createClient
  try {
    await observePhonebookCarddavSemanticShadow(input, {
      window: options.disabled ? { ...active, approved: false } : options.expired ? { ...active, expiresAt: new Date(fakeNow - 1).toISOString() } : options.future ? { ...active, startsAt: new Date(fakeNow + 1).toISOString() } : options.longWindow ? { ...active, expiresAt: new Date(fakeNow + 1_000_000).toISOString() } : active,
      metadata: { environment: options.preview ? "preview" : "production", commit: options.invalidCommit ? "PRIVATE BAD COMMIT" : "1".repeat(40) },
      now: () => 0, wallNow: () => options.wallMs === undefined ? fakeNow : options.wallMs, fetch: send, setTimer, clearTimer, createClient: factory,
      log: (event, summary) => { if (options.loggingFails) throw new Error("PRIVATE LOGGING FAILURE"); logs.push({ event, summary }) },
    })
    assert.equal(timers.size, 0, "Every observation/request timer must be cleared")
    assert.equal(activeStreams, 0, "Aborted reader must be cancelled")
    return { calls, logs, timerDelays, abortedRequests, cancelledStreams, clientCreations }
  } finally {
    for (const timer of timers) clearTimeout(timer)
    for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key] }
  }
}

test("unapproved/expired/future/overlong windows skip quietly without constructing client/timers or doing IO", async () => {
  assert.deepEqual(PHONEBOOK_SEMANTIC_SHADOW_WINDOW, { approved: false, startsAt: "1970-01-01T00:00:00.000Z", expiresAt: "1970-01-01T00:00:00.000Z" })
  for (const option of [{ disabled: true }, { expired: true }, { future: true }, { longWindow: true }]) {
    const f = await fixture(option); assert.equal(f.calls.length, 0); assert.equal(f.logs.length, 0); assert.equal(f.clientCreations, 0); assert.equal(f.timerDelays.length, 0)
  }
})
test("unknown commit, preview and insufficient remaining300s budget skip quietly", async () => {
  for (const option of [{ invalidCommit: true }, { preview: true }, { lowBudget: true }]) {
    const f = await fixture(option); assert.equal(f.calls.length, 0); assert.equal(f.logs.length, 0); assert.equal(f.timerDelays.length, 0)
  }
})
test("clock/window and300s budget boundaries fail closed without off-by-one observations", async () => {
  for (const option of [{ wallMs: Number.NaN }, { wallMs: fakeNow + 60_000 }, { elapsedMs: 270_001 }, { elapsedMs: -1 }, { elapsedMs: Number.NaN }]) {
    const f = await fixture(option); assert.equal(f.calls.length, 0); assert.equal(f.logs.length, 0); assert.equal(f.timerDelays.length, 0)
  }
  const f = await fixture({ elapsedMs: 270_000 }); assert.equal(f.logs[0].summary.match, 2)
})
test("two-card exact current inherited payloads produce only aggregate match/coverage evidence", async () => {
  const f = await fixture(), s = f.logs[0].summary
  assert.equal(f.logs.length, 1); assert.equal(f.logs[0].event, "phonebook_carddav_semantic_shadow")
  assert.equal(s.sampleSize, 2); assert.equal(s.match, 2); assert.equal(s.comparableCards, 2); assert.equal(s.observationIncomplete, false)
  assert.equal(s.expectedNonempty.FN, 2); assert.equal(s.expectedNonempty.N, 2); assert.equal(s.expectedNonempty.TEL, 4); assert.equal(s.observedNonempty.EMAIL, 2)
  assert.equal(s.wholeBookContentVerified, false); assert.equal(s.physicalDeviceVerified, false)
  assert.equal(f.calls.filter((call) => call.url.origin !== origin).length, 2); assert.equal(f.calls.filter((call) => call.url.origin === origin).length, 4)
  assert.ok(f.timerDelays.includes(10_000)); assert.ok(f.timerDelays.every((delay) => delay <= 3000 || delay === 10_000))
})
test("one available source contact stays a one-card sample without scanning for another", async () => {
  const f = await fixture({ oneContact: true }); assert.equal(f.logs[0].summary.sampleSize, 1); assert.equal(f.calls.filter((call) => call.url.origin !== origin).length, 1)
})
test("actual nonempty coverage flags do not invent absent phone/email/note/company shapes", async () => {
  const s = (await fixture({ omittedFields: true })).logs[0].summary
  assert.equal(s.match, 2); assert.equal(s.expectedNonempty.TEL, 0); assert.equal(s.observedNonempty.EMAIL, 0); assert.equal(s.observedNonempty.ORG, 0); assert.equal(s.expectedNonempty.NOTE, 0)
  assert.equal(s.expectedShapeFlags.multiplePhoneEndpoints, false)
})
test("changed payload retaining markers is observed but neither repairs nor ACKs", async () => {
  const f = await fixture({ mismatch: true }), s = f.logs[0].summary
  assert.equal(s.different, 2); assert.equal(s.match, 0); assert.deepEqual(s.differingProperties, ["FN"]); assert.ok(f.calls.every((call) => call.method === "GET"))
})
test("unsupported vCard shape is explicit and nonfatal", async () => {
  const s = (await fixture({ unsupported: true })).logs[0].summary
  assert.equal(s.unsupported, 2); assert.equal(s.match, 0); assert.equal(s.comparableCards, 0); assert.equal(s.observedNonempty.FN, 0)
})
test("before/after source churn is reported rather than silently treating match as certification", async () => {
  const s = (await fixture({ sourceChanged: true })).logs[0].summary
  assert.equal(s.match, 2); assert.equal(s.sourceChanged, true); assert.notEqual(s.sourceBeforeSha256, s.sourceAfterSha256)
})
test("missing/oversized/nonUTF8 cards and provider errors remain nonfatal incomplete observations", async () => {
  for (const option of [{ missing: true }, { oversize: true }, { invalidUtf8: true }, { privateError: true }]) {
    const s = (await fixture(option)).logs[0].summary
    assert.equal(s.match, 0); assert.equal(s.incompleteCards, 2); assert.equal(s.observationIncomplete, true)
  }
})
test("source failure or wrong canonical project cannot cause a provider read", async () => {
  for (const option of [{ sourceFailure: true }, { invalidSource: true }]) {
    const f = await fixture(option); assert.equal(f.calls.filter((call) => call.url.origin !== origin).length, 0); assert.equal(f.logs[0].summary.observationIncomplete, true)
    assert.equal(f.calls.length, option.sourceFailure ? 1 : 0, "The installed SDK must not retry a shadow source failure")
  }
})
test("company fallback lookup is quietly stopped instead of scanning the company book or inventing omitted inherited fields", async () => {
  const f = await fixture({ companyFallback: true }); assert.equal(f.calls.length, 2); assert.equal(f.calls.filter((call) => call.url.origin !== origin).length, 0); assert.equal(f.logs[0].summary.observationIncomplete, true)
})
test("per-request abort cancels two stalled reads and clears every timer", async () => {
  const f = await fixture({ hungProvider: true }); assert.equal(f.abortedRequests, 2); assert.equal(f.logs[0].summary.incompleteCards, 2)
})
test("source timeout aborts once without installed-SDK retry backoff or provider reads", async () => {
  const f = await fixture({ hungSource: true }); assert.equal(f.abortedRequests, 1); assert.equal(f.calls.length, 1); assert.equal(f.logs[0].summary.observationIncomplete, true)
})
test("total10s abort also cancels in-flight reads without modifying another client", async () => {
  const f = await fixture({ totalTimeout: true }); assert.equal(f.abortedRequests, 2); assert.equal(f.logs[0].summary.observationIncomplete, true)
})
test("aborted streamed bodies are cancelled, released and do not retain timers", async () => {
  const f = await fixture({ hungStream: true }); assert.equal(f.cancelledStreams, 2); assert.equal(f.logs[0].summary.incompleteCards, 2)
})
test("a response arriving on the abort boundary has its unread body cancelled", async () => {
  const f = await fixture({ lateBody: true }); assert.equal(f.cancelledStreams, 2); assert.equal(f.logs[0].summary.incompleteCards, 2)
})
test("source fence rejects mutation verbs, RPC, other tables/origins and a broad company scan before transport", async () => {
  for (const attack of [
    { url: origin + "/rest/v1/phonebook_contacts?select=id", method: "DELETE" },
    { url: origin + "/rest/v1/rpc/claim_bunker_map_backup_lock", method: "POST" },
    { url: origin + "/rest/v1/office_calendar_store?select=payload", method: "GET" },
    { url: "https://other.invalid/rest/v1/phonebook_contacts?select=id", method: "GET" },
    { url: origin + "/rest/v1/phonebook_companies?select=name", method: "GET" },
  ]) { const f = await fixture({ attack }); assert.equal(f.calls.length, 0); assert.equal(f.logs[0].summary.observationIncomplete, true) }
})
test("provider reads are confined to canonical HTTPS iCloud CardDAV book members", async () => {
  for (const invalidBook of ["http://p00-contacts.icloud.com/123/carddavhome/card/", "https://contacts.icloud.com.attacker.invalid/123/carddavhome/card/", "https://p00-contacts.icloud.com:8443/123/carddavhome/card/", "https://p00-contacts.icloud.com/123/other/", "https://u:p@p00-contacts.icloud.com/123/carddavhome/card/"]) {
    const f = await fixture({ invalidBook }); assert.equal(f.calls.filter((call) => call.url.origin !== origin).length, 0); assert.equal(f.logs[0].summary.observationIncomplete, true)
  }
})
test("aggregate logs never include contact values, IDs, accounts, URLs, keys or private upstream failures", async () => {
  for (const option of [{}, { mismatch: true }, { privateError: true }, { sourceFailure: true }]) {
    const text = JSON.stringify((await fixture(option)).logs)
    assert.ok(!/SYNTHETIC|PRIVATE|example\.invalid|00000000-0000|icloud|https?:|Basic |Bearer /.test(text))
  }
})
test("logging failure cannot propagate or leave request timers", async () => assert.equal((await fixture({ loggingFails: true })).logs.length, 0))
test("StageS preserves exact original verification implementation, with comparator remaining observational only", () => {
  const current = readFileSync(new URL("../lib/phonebookCarddav.ts", import.meta.url), "utf8")
  const verification = (source: string) => source.slice(source.indexOf("export async function verifyContact("), source.indexOf("export async function putContact("))
  // Immutable SHA of the original production verifier, not an external checkout.
  assert.equal(createHash("sha256").update(verification(current)).digest("hex"), "4e631efd1b4e480401cda70ba66d3055ce58028b8d175f51e0c2e2872331a3e7")
})
