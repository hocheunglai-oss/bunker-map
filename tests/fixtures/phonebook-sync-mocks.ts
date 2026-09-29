// Only the authenticated browser boundary is replaced. The real Phonebook
// page and sync coordinator execute, but no request can leave this fixture.
type Row = Record<string, unknown> & { id: string }
type SyncPlan = { failedIds?: string[]; status?: number; malformed?: boolean; reject?: boolean; defer?: boolean }
type RecordedRequest = { url: string; method: string; body: Record<string, unknown> | null }
type Operation = { table: string; method: string; payload: Record<string, unknown> | null; filters: { field: string; value: unknown }[] }
type QueryResult = { data: unknown; error: { message: string } | null }
export type PhonebookSyncHarness = {
  contacts: Row[]
  companies: Row[]
  requests: RecordedRequest[]
  operations: Operation[]
  syncPlan: SyncPlan[]
  malformedContacts: boolean
  releaseSync: (() => void) | null
  activeSyncs: number
  maxConcurrentSyncs: number
}
declare global { interface Window { __phonebookSyncHarness: PhonebookSyncHarness } }
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function installPhonebookSyncHarness() {
  const companies: Row[] = [
    { id: "synthetic-company-a", name: "ALPHA SHIPPING", source_key: "company-a", country: "HONG KONG", tel_country: "852", tel_no_1: "22334455" },
    { id: "synthetic-company-b", name: "BETA SHIPPING", source_key: "company-b", country: "SINGAPORE", tel_country: "65", tel_no_1: "61234567" },
  ]
  const contacts: Row[] = [
    { id: "synthetic-contact-a", full_name: "ALICE TEST", company: "ALPHA SHIPPING", company_source_id: "company-a", favorite: false, mobile_1: "+85291112222", personal_email: "alice@example.test" },
    { id: "synthetic-contact-b", full_name: "BOB TEST", company: "ALPHA SHIPPING", company_source_id: "company-a", favorite: false, mobile_1: "+85292223333", personal_email: "bob@example.test" },
    { id: "synthetic-contact-c", full_name: "CAROL TEST", company: "ALPHA SHIPPING", company_source_id: "company-a", favorite: false, mobile_1: "+85293334444", personal_email: "carol@example.test" },
    { id: "synthetic-contact-d", full_name: "DAVE TEST", company: "BETA SHIPPING", company_source_id: "company-b", favorite: false, mobile_1: "+6591112222", personal_email: "dave@example.test" },
  ]
  window.__phonebookSyncHarness = { contacts, companies, requests: [], operations: [], syncPlan: [], malformedContacts: false, releaseSync: null, activeSyncs: 0, maxConcurrentSyncs: 0 }
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    const method = init?.method || (input instanceof Request ? input.method : "GET")
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null
    const harness = window.__phonebookSyncHarness
    harness.requests.push({ url: `${url.pathname}${url.search}`, method, body })
    if (url.origin !== window.location.origin) throw new Error(`External request blocked by local fixture: ${url.origin}`)
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } })
    if (url.pathname === "/api/phonebook/bootstrap" && method === "GET") return json({ companies: harness.companies, contactCount: harness.contacts.length })
    if (url.pathname === "/api/phonebook/contacts" && method === "GET") {
      if (harness.malformedContacts) return json({})
      const company = url.searchParams.get("company")
      return json({ contacts: company ? harness.contacts.filter((contact) => contact.company === company) : harness.contacts, limited: false })
    }
    if (url.pathname === "/api/phonebook/carddav-sync" && method === "POST" && body) {
      const plan = harness.syncPlan.shift() || {}
      harness.activeSyncs++
      harness.maxConcurrentSyncs = Math.max(harness.maxConcurrentSyncs, harness.activeSyncs)
      try {
        if (plan.defer) await new Promise<void>((resolve) => { harness.releaseSync = resolve })
        harness.releaseSync = null
        if (plan.reject) throw new Error("Synthetic CardDAV network failure")
        if (plan.malformed) return json({ message: "Not a verified result" })
        if (plan.status && plan.status >= 400) return json({ message: "Synthetic upstream sync failure" }, plan.status)
        const fullResync = body.fullRebuild === true
        const cursor = Number(body.cursor || 0)
        const allIds = harness.contacts.map((contact) => contact.id).sort()
        const ids = fullResync ? allIds.slice(cursor, cursor + 2) : (body.contactIds || body.deleteContactIds || []) as string[]
        const failed = ids.filter((id) => plan.failedIds?.includes(id)).map((id) => ({ id, label: "Synthetic contact", error: "Synthetic verification failure" }))
        const verifiedIds = ids.filter((id) => !plan.failedIds?.includes(id))
        const done = !fullResync || cursor + ids.length >= allIds.length
        return json({ message: `${verifiedIds.length} contact(s) verified`, verifiedIds, verifiedCount: verifiedIds.length, syncedCount: verifiedIds.length, failed, total: fullResync ? allIds.length : ids.length, done, nextCursor: done ? null : cursor + ids.length, phase: "upload" }, failed.length ? 207 : 200)
      } finally {
        harness.activeSyncs--
      }
    }
    throw new Error(`Unexpected local fixture request: ${method} ${url.pathname}`)
  }
}

class Query implements PromiseLike<QueryResult> {
  private operation: Operation
  private execution: Promise<QueryResult> | null = null
  private singular = false
  constructor(table: string) { this.operation = { table, method: "GET", payload: null, filters: [] } }
  update(payload: Record<string, unknown>) { this.operation.method = "PATCH"; this.operation.payload = payload; return this }
  insert(payload: Record<string, unknown>) { this.operation.method = "POST"; this.operation.payload = payload; return this }
  delete() { this.operation.method = "DELETE"; return this }
  eq(field: string, value: unknown) { this.operation.filters.push({ field, value }); return this }
  select() { return this }
  single() { this.singular = true; return this }
  maybeSingle() { this.singular = true; return this }
  then<TResult1 = QueryResult, TResult2 = never>(onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    this.execution ??= this.execute()
    return this.execution.then(onfulfilled, onrejected)
  }
  private async execute(): Promise<QueryResult> {
    const harness = window.__phonebookSyncHarness
    const operation = clone(this.operation)
    const rows = operation.table === "phonebook_contacts" ? harness.contacts : operation.table === "phonebook_companies" ? harness.companies : null
    if (!rows) throw new Error(`Unexpected table in local fixture: ${operation.table}`)
    const matches = (row: Row) => operation.filters.every(({ field, value }) => row[field] === value)
    if (operation.method === "GET") {
      const result = clone(rows.filter(matches))
      return { data: this.singular ? result[0] || null : result, error: null }
    }
    harness.operations.push(operation)
    if (operation.method === "PATCH") {
      const matched = rows.filter(matches)
      matched.forEach((row) => Object.assign(row, operation.payload))
      return { data: this.singular ? clone(matched[0] || null) : clone(matched), error: null }
    }
    if (operation.method === "DELETE") {
      for (let index = rows.length - 1; index >= 0; index--) if (matches(rows[index])) rows.splice(index, 1)
      return { data: null, error: null }
    }
    if (operation.method === "POST") {
      const inserted = { ...operation.payload, id: crypto.randomUUID() } as Row
      rows.push(inserted)
      return { data: clone(inserted), error: null }
    }
    throw new Error(`Unexpected local fixture operation: ${operation.method}`)
  }
}

export const supabase = { from: (table: string) => new Query(table) }
export function useSimpleAdminAuth() { return { loading: false, authenticated: true } }
