// Only the authenticated browser boundary is replaced. The real Phonebook
// page and sync coordinator execute, but no request can leave this fixture.
import { ADMIN_PAGE_DEFINITIONS } from "../../lib/adminPages"

type Row = Record<string, unknown> & { id: string }
type FixtureAuth = { loading: boolean; authenticated: boolean; actorKey: string; resetRequired: boolean; username: string; displayName: string; role: string; permissions: Record<string, "view" | "edit" | "none">; pages: typeof ADMIN_PAGE_DEFINITIONS }
type SyncPlan = { failedIds?: string[]; status?: number; malformed?: boolean; reject?: boolean; defer?: boolean }
type RecordedRequest = { url: string; method: string; body: Record<string, unknown> | null }
type Operation = { table: string; method: string; payload: Record<string, unknown> | null; filters: { field: string; value: unknown; operator?: "in" }[] }
type QueryResult = { data: unknown; error: { message: string; code?: string } | null }
export type PhonebookSyncHarness = {
  contacts: Row[]
  companies: Row[]
  requests: RecordedRequest[]
  operations: Operation[]
  contactReads: Operation[]
  syncPlan: SyncPlan[]
  malformedContacts: boolean
  releaseSync: (() => void) | null
  activeSyncs: number
  maxConcurrentSyncs: number
  failCompanyDeletes: boolean
  companyDeleteRetrySnapshots: Array<Array<{ id: string; operation: string }>>
  countOverrides: Record<string, number>
  contactWriteFailure: "reject" | "commit-reject" | "error" | null
  malformedContactReply?: boolean | "false" | "zero" | "empty-string" | "null"
  deferContactWrite: boolean
  releaseContactWrite: (() => void) | null
  companySaveStatus?: number
  deferCompanySave?: boolean
  releaseCompanySave?: () => void
  companyReadPlan?: boolean[]
  releaseCompanyReads?: Array<() => void>
  contactWriteSequence?: number
  auth: FixtureAuth
  rerender?: () => void
  unmount?: () => void
  contactReadFailure?: "reject" | "error" | "malformed" | "hold" | "false" | "zero" | "null" | "empty-string"
  releaseContactRead?: () => void
  deferCacheFetch?: boolean
  releaseCacheFetch?: () => void
}
declare global { interface Window { __phonebookSyncHarness: PhonebookSyncHarness } }
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function installPhonebookSyncHarness() {
  const companies: Row[] = [
    { id: "synthetic-company-a", name: "ALPHA SHIPPING", source_key: "company-a", country: "HONG KONG", tel_country: "852", tel_no_1: "22334455", updated_at: "2026-10-14T00:00:00.123456Z" },
    { id: "synthetic-company-b", name: "BETA SHIPPING", source_key: "company-b", country: "SINGAPORE", tel_country: "65", tel_no_1: "61234567", updated_at: "2026-10-14T00:00:00.123456Z" },
  ]
  const contacts: Row[] = [
    { id: "synthetic-contact-a", full_name: "ALICE TEST", company: "ALPHA SHIPPING", company_source_id: "company-a", favorite: false, mobile_1: "+85291112222", personal_email: "alice@example.test" },
    { id: "synthetic-contact-b", full_name: "BOB TEST", company: "ALPHA SHIPPING", company_source_id: "company-a", favorite: false, mobile_1: "+85292223333", personal_email: "bob@example.test" },
    { id: "synthetic-contact-c", full_name: "CAROL TEST", company: "ALPHA SHIPPING", company_source_id: "company-a", favorite: false, mobile_1: "+85293334444", personal_email: "carol@example.test" },
    { id: "synthetic-contact-d", full_name: "DAVE TEST", company: "BETA SHIPPING", company_source_id: "company-b", favorite: false, mobile_1: "+6591112222", personal_email: "dave@example.test" },
  ]
  contacts.forEach((contact) => { contact.updated_at = "2026-10-14T00:00:00.123456Z"; contact.created_at = "2026-10-01T00:00:00Z"; contact.source_key = `source-${contact.id}` })
  const mode = new URLSearchParams(location.search).get("mode")
  const auth: FixtureAuth = { loading: false, authenticated: mode !== "signedout", actorKey: "synthetic-actor-a", resetRequired: false, username: "synthetic-user", displayName: "Synthetic User", role: "USER", permissions: { phonebook: mode === "view" ? "view" : "edit" }, pages: ADMIN_PAGE_DEFINITIONS }
  window.__phonebookSyncHarness = { contacts, companies, requests: [], operations: [], contactReads: [], syncPlan: [], malformedContacts: false, releaseSync: null, activeSyncs: 0, maxConcurrentSyncs: 0, failCompanyDeletes: false, companyDeleteRetrySnapshots: [], countOverrides: {}, contactWriteFailure: null, deferContactWrite: false, releaseContactWrite: null, auth }
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    const method = init?.method || (input instanceof Request ? input.method : "GET")
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null
    const harness = window.__phonebookSyncHarness
    harness.requests.push({ url: `${url.pathname}${url.search}`, method, body })
    if (url.origin !== window.location.origin) throw new Error(`External request blocked by local fixture: ${url.origin}`)
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } })
    if (url.pathname === "/api/phonebook/bootstrap" && method === "GET") return json({ companies: harness.companies, contactCount: harness.contacts.length })
    if (url.pathname === "/api/phonebook/company" && method === "POST" && body) {
      if (harness.deferCompanySave) await new Promise<void>((resolve) => { harness.releaseCompanySave = resolve })
      harness.releaseCompanySave = undefined
      if (harness.companySaveStatus) return json({ message: "This company changed or was removed. Your edits are still here; reopen it before saving again." }, harness.companySaveStatus)
      const company = harness.companies.find((row) => row.id === body.id)
      if (!company || company.updated_at !== body.expectedUpdatedAt) return json({ message: "Company changed; reopen before saving." },409)
      const previousName = company.name
      const affected = harness.contacts.filter((row) => row.company === previousName || row.company_source_id === company.source_key)
      Object.assign(company, body.patch, { updated_at: "2026-10-14T00:00:01.123456Z" })
      affected.forEach((row) => { row.company = company.name })
      return json({ company: clone(company), contactIds: affected.map((row) => row.id) })
    }
    if (url.pathname === "/api/phonebook/carddav-sync" && method === "GET") return json({ savedContactCount: harness.contacts.length, carddavContactCount: harness.contacts.length, carddavTotalCount: harness.contacts.length + 5, carddavOtherCount: 5, carddavMatchedCount: harness.contacts.length, carddavMissingCount: 0, carddavOrphanCount: 0, ...harness.countOverrides, checkedAt: new Date().toISOString() })
    if (url.pathname === "/api/phonebook/contacts" && method === "GET") {
      if (harness.malformedContacts) return json({})
      if (url.searchParams.get("all") === "1" && harness.deferCacheFetch) {
        const snapshot = clone(harness.contacts)
        await new Promise<void>(resolve => { harness.releaseCacheFetch = resolve })
        harness.deferCacheFetch = false
        harness.releaseCacheFetch = undefined
        return json({ contacts: snapshot, limited: false })
      }
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
  in(field: string, value: unknown[]) { this.operation.filters.push({ field, value, operator: "in" }); return this }
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
    const matches = (row: Row) => operation.filters.every(({ field, value, operator }) => operator === "in" ? (value as unknown[]).includes(row[field]) : row[field] === value)
    if (operation.method === "GET") {
      if (operation.table === "phonebook_contacts" && operation.filters.some(filter => filter.field === "id")) {
        harness.contactReads.push(operation)
        const failure = harness.contactReadFailure
        harness.contactReadFailure = undefined
        if (failure === "hold") await new Promise<void>(resolve => { harness.releaseContactRead = resolve })
        if (failure === "reject") throw new Error("Synthetic read network failure")
        if (failure === "error") return { data: null, error: { message: "Synthetic read database failure" } }
        if (failure === "malformed") return { data: { id: rows.find(matches)?.id }, error: null }
        if (failure === "false") return { data: false, error: null }
        if (failure === "zero") return { data: 0, error: null }
        if (failure === "null") return { data: null, error: null }
        if (failure === "empty-string") return { data: "", error: null }
      }
      const result = clone(rows.filter(matches))
      if (operation.table === "phonebook_companies" && this.singular && harness.companyReadPlan?.shift()) {
        await new Promise<void>((resolve) => { (harness.releaseCompanyReads ||= []).push(resolve) })
      }
      return { data: this.singular ? result[0] || null : result, error: null }
    }
    harness.operations.push(operation)
    if (operation.table === "phonebook_contacts" && ["POST", "PATCH"].includes(operation.method) && harness.deferContactWrite) {
      await new Promise<void>((resolve) => { harness.releaseContactWrite = resolve })
      harness.releaseContactWrite = null
      harness.deferContactWrite = false
    }
    const contactWriteFailure = operation.table === "phonebook_contacts" && ["POST", "PATCH"].includes(operation.method)
      ? harness.contactWriteFailure : null
    if (contactWriteFailure) harness.contactWriteFailure = null
    if (contactWriteFailure === "reject") throw new Error("Synthetic contact write network failure")
    if (contactWriteFailure === "error") return { data: null, error: { code: "XX000", message: "Synthetic database failure" } }
    if (operation.table === "phonebook_companies" && operation.method === "DELETE") {
      harness.companyDeleteRetrySnapshots.push(JSON.parse(localStorage.getItem("phonebook_carddav_pending:v2") || "[]") as Array<{ id: string; operation: string }>)
      if (harness.failCompanyDeletes) return { data: null, error: { message: "Synthetic company deletion failure" } }
    }
    if (operation.method === "PATCH") {
      const matched = rows.filter(matches)
      if (this.singular && matched.length === 0) return { data: null, error: { code: "PGRST116", message: "Cannot coerce zero rows to a single JSON object" } }
      matched.forEach((row) => Object.assign(row, operation.payload))
      if (operation.table === "phonebook_contacts") matched.forEach((row) => { row.updated_at = `2026-10-14T00:00:01.${String(harness.contactWriteSequence = (harness.contactWriteSequence || 0) + 1).padStart(6, "0")}Z` })
      if (contactWriteFailure === "commit-reject") throw new Error("Synthetic lost contact write response")
      if (operation.table === "phonebook_contacts" && harness.malformedContactReply) {
        const reply = harness.malformedContactReply
        harness.malformedContactReply = false
        return { data: reply === "false" ? false : reply === "zero" ? 0 : reply === "empty-string" ? "" : reply === "null" ? null : { id: matched[0]?.id }, error: null }
      }
      return { data: this.singular ? clone(matched[0] || null) : clone(matched), error: null }
    }
    if (operation.method === "DELETE") {
      const matched = clone(rows.filter(matches))
      if (this.singular && matched.length === 0) return { data: null, error: { code: "PGRST116", message: "Cannot coerce zero rows to a single JSON object" } }
      for (let index = rows.length - 1; index >= 0; index--) if (matches(rows[index])) rows.splice(index, 1)
      return { data: this.singular ? matched[0] || null : null, error: null }
    }
    if (operation.method === "POST") {
      const inserted = { ...operation.payload, id: operation.payload?.id || crypto.randomUUID() } as Row
      if (operation.table === "phonebook_contacts" && !inserted.updated_at) inserted.updated_at = `2026-10-14T00:00:01.${String(harness.contactWriteSequence = (harness.contactWriteSequence || 0) + 1).padStart(6, "0")}Z`
      if (rows.some((row) => row.id === inserted.id)) return { data: null, error: { code: "23505", message: "Synthetic duplicate primary key" } }
      rows.push(inserted)
      if (contactWriteFailure === "commit-reject") throw new Error("Synthetic lost contact write response")
      return { data: clone(inserted), error: null }
    }
    throw new Error(`Unexpected local fixture operation: ${operation.method}`)
  }
}

export const supabase = { from: (table: string) => new Query(table) }
export function useSimpleAdminAuth() { return window.__phonebookSyncHarness.auth }
