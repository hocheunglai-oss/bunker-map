// This module replaces only the authenticated client boundary in the browser
// fixture. Nothing here can connect to Supabase or Exchange.
type Contact = {
  id: string
  source_book: string
  source_card: string | null
  display_name: string
  primary_email: string
  nickname: string | null
  first_name: string | null
  last_name: string | null
  vcard: string | null
  properties: Record<string, unknown> | null
}
type Group = { id: string; source_book: string; source_uid: string; name: string; nickname: null; description: null; member_count: number }
type Member = { group_id: string; contact_id: string; source_book: string }
type Operation = {
  table: string
  method: string
  payload: Record<string, unknown> | Record<string, unknown>[] | null
  filters: { field: string; value: unknown }[]
  columns: string | null
  single: boolean
}
type QueryResult = { data: unknown; error: { message: string; code?: string } | null }
export type OutlookContactHarness = {
  contacts: Contact[]
  groups: Group[]
  members: Member[]
  baselineMembers: Member[]
  operations: Operation[]
  requests: { url: string; method: string }[]
  failNext: boolean
  throwNext: boolean
  deferNext: boolean
  releaseWrite: (() => void) | null
  deferUndo: boolean
  releaseUndo: (() => void) | null
  undone: boolean
}

declare global { interface Window { __outlookContactHarness: OutlookContactHarness } }
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function installOutlookContactHarness() {
  const contacts: Contact[] = [
    { id: "synthetic-contact-a", source_book: "FC-GENERAL", source_card: "original-card-a", display_name: "DORVAL-ORIGINAL PERSON", primary_email: "original@example.test", nickname: "Original", first_name: "Original", last_name: "Person", vcard: "UNCHANGED ORIGINAL VCARD", properties: { custom: "preserve me" } },
    { id: "synthetic-contact-b", source_book: "FC-GENERAL", source_card: "original-card-b", display_name: "SECOND CONTACT", primary_email: "second@example.test", nickname: null, first_name: null, last_name: null, vcard: null, properties: {} },
  ]
  const groups: Group[] = [{ id: "synthetic-group-a", source_book: "FC-GENERAL", source_uid: "original-group-a", name: "TEST SUPPLIERS", nickname: null, description: null, member_count: 2 }]
  const members: Member[] = contacts.map((contact) => ({ group_id: groups[0].id, contact_id: contact.id, source_book: "FC-GENERAL" }))
  window.__outlookContactHarness = { contacts, groups, members, baselineMembers: clone(members), operations: [], requests: [], failNext: false, throwNext: false, deferNext: false, releaseWrite: null, deferUndo: false, releaseUndo: null, undone: false }
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    const method = init?.method || (input instanceof Request ? input.method : "GET")
    const harness = window.__outlookContactHarness
    harness.requests.push({ url: url.pathname, method })
    if (url.origin !== window.location.origin) throw new Error(`External request blocked by local fixture: ${url.origin}`)
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } })
    if (url.pathname === "/api/outlook-addressbook/bootstrap" && method === "GET") return json({ contacts: harness.contacts, groups: harness.groups, members: harness.members })
    if (url.pathname === "/api/admin/audit-logs" && method === "GET") return json({ logs: [{
      id: "synthetic-audit-a", occurredAt: "2026-09-25T08:00:00.000Z", actorUserId: null, actorId: null, actorName: "TEST", actorSource: "test",
      tableSchema: "public", tableName: "shared_addressbook_contacts", operation: "UPDATE", recordPk: { id: "synthetic-contact-a" },
      changedFields: ["primary_email"], beforeRow: { display_name: "DORVAL-ORIGINAL PERSON", primary_email: "undo.original@example.test" }, afterRow: contacts[0],
      requestContext: {}, undoOfLogId: null, undoneAt: harness.undone ? "2026-09-25T08:10:00.000Z" : null, undoneByLogId: null,
    }] })
    if (url.pathname === "/api/admin/audit-logs" && method === "POST") {
      if (harness.deferUndo) await new Promise<void>((resolve) => { harness.releaseUndo = resolve })
      harness.releaseUndo = null
      harness.contacts[0].primary_email = "undo.original@example.test"
      harness.undone = true
      return json({ success: true })
    }
    if (url.pathname === "/api/outlook-addressbook/exchange-sync" && method === "GET") return json({ webhookConfigured: true, status: { status: "completed", message: "Synthetic fixture only", requestedAt: null } })
    // Any unexpected write is visible to assertions and never leaves memory.
    if (url.pathname === "/api/outlook-addressbook/exchange-sync") return json({ message: "The fixture never starts Exchange sync." }, 409)
    throw new Error(`Unexpected local fixture request: ${method} ${url.pathname}`)
  }
}

class Query implements PromiseLike<QueryResult> {
  private operation: Operation
  private execution: Promise<QueryResult> | null = null
  constructor(table: string) { this.operation = { table, method: "GET", payload: null, filters: [], columns: null, single: false } }
  update(payload: Record<string, unknown>) { this.operation.method = "PATCH"; this.operation.payload = payload; return this }
  upsert(payload: Record<string, unknown>) { this.operation.method = "UPSERT"; this.operation.payload = payload; return this }
  insert(payload: Record<string, unknown> | Record<string, unknown>[]) { this.operation.method = "POST"; this.operation.payload = payload; return this }
  delete() { this.operation.method = "DELETE"; return this }
  eq(field: string, value: unknown) { this.operation.filters.push({ field, value }); return this }
  select(columns: string) { this.operation.columns = columns; return this }
  single() { this.operation.single = true; return this }
  then<TResult1 = QueryResult, TResult2 = never>(onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    this.execution ??= this.execute()
    return this.execution.then(onfulfilled, onrejected)
  }
  private async execute(): Promise<QueryResult> {
    const harness = window.__outlookContactHarness
    const operation = clone(this.operation)
    harness.operations.push(operation)
    if (harness.deferNext) {
      harness.deferNext = false
      await new Promise<void>((resolve) => { harness.releaseWrite = resolve })
      harness.releaseWrite = null
    }
    if (harness.throwNext) { harness.throwNext = false; throw new Error("Synthetic network failure. Please retry.") }
    if (harness.failNext) { harness.failNext = false; return { data: null, error: { message: "Synthetic save failure. Please retry." } } }
    if (operation.table !== "shared_addressbook_contacts") return { data: null, error: { message: "Unexpected mutation outside contacts in local fixture." } }
    const payload = operation.payload as Record<string, unknown>
    const id = operation.filters.find((filter) => filter.field === "id")?.value
    if (operation.method === "PATCH") {
      const index = harness.contacts.findIndex((contact) => contact.id === id)
      if (index < 0) return { data: null, error: { message: "Contact no longer exists.", code: "PGRST116" } }
      harness.contacts[index] = { ...harness.contacts[index], ...payload }
      return { data: { id }, error: null }
    }
    if (operation.method === "POST") {
      harness.contacts.push(clone(payload) as Contact)
      return { data: operation.single ? payload : null, error: null }
    }
    if (operation.method === "DELETE") {
      harness.contacts = harness.contacts.filter((contact) => contact.id !== id)
      return { data: null, error: null }
    }
    return { data: null, error: { message: `Unexpected contact method: ${operation.method}` } }
  }
}

export const supabase = { from: (table: string) => new Query(table) }
export function useSimpleAdminAuth() { return { loading: false, authenticated: true } }
