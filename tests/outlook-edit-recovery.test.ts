import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import * as contactValidation from "../lib/outlookContactValidation"
import { reapplyEmailTemplateDraft } from "../lib/emailTemplateDraftRecovery"
import type { EmailTemplate } from "../lib/emailTemplates"

function functions(file: string, names: string[]) {
  const raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
  const source = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found = new Map<string, string>()
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(source)); ts.forEachChild(node, visit) }
  visit(source)
  assert.equal(found.size, names.length)
  return ts.transpileModule(names.map(name => found.get(name)).join("\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
}

function contactFixture() {
  const rows: Record<string, unknown>[] = [], inserts: Record<string, unknown>[] = []
  const controls = { precommit: false, lostReply: false, readFailure: false, thrownReply: false }
  const state = { contacts: [] as unknown[], message: "", saving: "" }
  const setter = (key: keyof typeof state) => (value: unknown) => { (state as Record<string, unknown>)[key] = typeof value === "function" ? value(state[key]) : value }
  const context = {
    ...contactValidation, crypto: { randomUUID }, console, mountedRef: { current: true }, createContactIdRef: { current: null as string | null },
    setSaving: setter("saving"), setMessage: setter("message"), setContacts: setter("contacts"),
    setContactDraft() {}, markExchangeNeedsSync() {}, setSelectedSourceBook() {}, setActiveView() {}, setSelectedContactId() {}, setContactNotice() {}, loadRecentActivities() {}, SOURCE_ALL: "all",
    supabase: { from(table: string) {
      assert.equal(table, "shared_addressbook_contacts")
      let row: Record<string, unknown> | null = null, id: unknown
      const query = {
        insert(value: Record<string, unknown>) { row = value; return query }, select() { return query }, eq(field: string, value: unknown) { assert.equal(field, "id"); id = value; return query },
        async single() {
          assert.ok(row); inserts.push(structuredClone(row))
          if (controls.precommit) return { data: null, error: { message: "precommit" } }
          if (rows.some(existing => existing.id === row!.id)) return { data: null, error: { code: "23505" } }
          rows.push(structuredClone(row))
          if (controls.thrownReply) throw Error("response lost")
          return controls.lostReply ? { data: null, error: { message: "reply lost" } } : { data: structuredClone(row), error: null }
        },
        async maybeSingle() { return controls.readFailure ? { data: null, error: { message: "read outage" } } : { data: structuredClone(rows.find(row => row.id === id) || null), error: null } },
      }
      return query
    } },
  }
  vm.createContext(context)
  vm.runInContext(functions("app/admin/outlookaddressbook/page.tsx", ["newId", "createContact"]), context)
  const create = () => (context as typeof context & { createContact: (...args: string[]) => Promise<boolean> }).createContact("FC-GENERAL", "SYNTHETIC CREATE", "same@example.invalid")
  return { rows, inserts, controls, state, context, create }
}

test("actual contact creation reuses one intent after precommit failure and repeated retries", async () => {
  const f = contactFixture(); f.controls.precommit = true
  assert.equal(await f.create(), false); assert.equal(await f.create(), false)
  f.controls.precommit = false
  assert.equal(await f.create(), true)
  assert.equal(f.rows.length, 1); assert.equal(new Set(f.inserts.map(row => row.id)).size, 1)
})
test("actual committed creation lost acknowledgement + failed readback never duplicates on retry", async () => {
  for (const thrown of [false, true]) {
    const f = contactFixture(); f.controls.lostReply = true; f.controls.thrownReply = thrown; f.controls.readFailure = true
    assert.equal(await f.create(), false); assert.equal(await f.create(), false)
    assert.equal(f.rows.length, 1); assert.equal(f.inserts.length, 1)
    f.controls.readFailure = false
    assert.equal(await f.create(), true); assert.equal(f.rows.length, 1); assert.equal(f.inserts.length, 1)
    assert.equal(f.state.contacts.length, 1)
  }
})
test("actual retry does not overwrite a concurrently edited committed contact or merge unrelated email duplicates", async () => {
  const f = contactFixture(); f.controls.lostReply = true; f.controls.readFailure = true
  assert.equal(await f.create(), false)
  f.rows[0].display_name = "COLLEAGUE EDIT"
  f.controls.readFailure = false
  assert.equal(await f.create(), false); assert.equal(f.rows[0].display_name, "COLLEAGUE EDIT"); assert.equal(f.inserts.length, 1)
  const unrelated = contactFixture()
  unrelated.rows.push({ id: "unrelated", primary_email: "same@example.invalid" })
  assert.equal(await unrelated.create(), true); assert.equal(unrelated.rows.length, 2)
})

const template = (changes: Partial<EmailTemplate> = {}): EmailTemplate => ({ id: "synthetic", title: "Base", subject: "Base subject", folder: "Synthetic", sourcePath: "", from: "", to: "person@example.invalid", cc: "", bcc: "", bodyHtml: "<p>Base</p>", bodyText: "Base", tags: [], slug: "synthetic", isActive: true, placeholders: [], recipientResolution: {}, revision: 1, updatedAt: "2026-10-16T00:00:00Z", ...changes })
test("explicit draft reapply retains unrelated colleague fields and clears obsolete recipient proof only when necessary", () => {
  const base = template(), draft = template({ title: "My draft", bodyHtml: "<p>My work</p>" }), server = template({ revision: 2, subject: "Colleague subject", recipientResolution: { proof: "current" } })
  const next = reapplyEmailTemplateDraft(base, draft, server)
  assert.equal(next.title, "My draft"); assert.equal(next.bodyHtml, "<p>My work</p>"); assert.equal(next.subject, "Colleague subject"); assert.equal(next.revision, 2); assert.deepEqual(next.recipientResolution, server.recipientResolution)
  assert.deepEqual(reapplyEmailTemplateDraft(base, { ...draft, to: "changed@example.invalid" }, server).recipientResolution, {})
  assert.throws(() => reapplyEmailTemplateDraft(base, draft, { ...server, id: "wrong" }))
})

test("actual conflict handler keeps draft after success, transport failure or wrong identity/version; autosave stays paused", async () => {
  for (const failedRead of [false, "transport", "wrong-id", "wrong-revision"] as const) {
    const draft = template({ title: "UNSAVED DRAFT", bodyHtml: "<p>Unsaved work</p>" }), server = template({ title: "COLLEAGUE COPY", revision: 2 })
    const state = { templates: [draft], conflict: null as unknown, saveState: "", draftConflicts: new Map() }
    const context = {
      console, Date, Error, Map, Set, mountedRef: { current: true },
      templateConflictVersionsRef: { current: new Map() }, pendingTemplatesRef: { current: new Map([[draft.id, draft]]) }, editBasesRef: { current: new Map([[draft.id, template()]]) }, draftConflictsRef: { current: new Map() },
      dirtyVersionsRef: { current: new Map([[draft.id, 1]]) }, failedSavesRef: { current: new Set() }, templatesRef: { current: state.templates }, deletingTemplateIdsRef: { current: new Set() },
      clearAutosaveTimer() {}, clearAdminClientCache() {}, OUTLOOK_TEMPLATES_INDEX_CACHE_KEY: "synthetic",
      setTemplateSaveState(_id: string, value: string) { state.saveState = value }, setConflictAlert(value: unknown) { state.conflict = typeof value === "function" ? value(state.conflict) : value }, setDraftConflicts(value: Map<unknown, unknown>) { state.draftConflicts = value },
      async fetch() { if (failedRead === "transport") throw Error("Synthetic read failure"); return Response.json({ template: { ...server, ...(failedRead === "wrong-id" ? { id: "wrong" } : failedRead === "wrong-revision" ? { revision: 0 } : {}) } }) },
    }
    vm.createContext(context)
    vm.runInContext(functions("app/admin/emailtemplates/page.tsx", ["templateFromDetail", "updateDraftConflict", "readCurrentTemplate", "reloadTemplateAfterConflict", "savePendingTemplateNow"]), context)
    const actual = context as typeof context & { reloadTemplateAfterConflict: (id: string, message: string) => Promise<void>; savePendingTemplateNow: (id: string) => Promise<boolean> }
    await actual.reloadTemplateAfterConflict(draft.id, "Save conflict.")
    assert.equal(context.pendingTemplatesRef.current.get(draft.id), draft); assert.equal(context.dirtyVersionsRef.current.get(draft.id), 1); assert.equal(state.templates[0], draft)
    assert.equal(state.saveState, "conflict"); assert.equal(await actual.savePendingTemplateNow(draft.id), false)
    const conflict = context.draftConflictsRef.current.get(draft.id)
    assert.equal(conflict.server?.title || null, failedRead ? null : "COLLEAGUE COPY")
    assert.match(conflict.message, /draft is kept/)
  }
})
