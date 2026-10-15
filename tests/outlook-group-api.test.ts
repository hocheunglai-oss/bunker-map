import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import * as validation from "../lib/outlookGroupValidation"

const source = readFileSync(new URL("../app/api/outlook-addressbook/groups/route.ts", import.meta.url), "utf8")
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
const initial = { id: "group-synthetic-stable", source_uid: "immutable-source", name: "ORIGINAL GROUP", source_book: "FC-GENERAL", nickname: null, description: "Keep description", member_count: 2, updated_at: "2026-10-14T10:00:00.123456+00:00" }
type Group = typeof initial
type Handler = (request: Request) => Promise<Response>

function fixture(options: { permissionError?: string; serviceKey?: string; reply?: unknown; databaseError?: { code: string; message: string } } = {}) {
  let row: Group | null = structuredClone(initial)
  let memberCount = 2
  let hold: (() => Promise<void>) | undefined
  const calls: Array<{ action: string; changes?: unknown; filters: Array<[string, unknown]> }> = []
  const permissions: unknown[] = []
  const audit: unknown[] = []
  const exports: { POST?: Handler } = {}
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "@/lib/outlookGroupValidation": validation,
    "@/lib/adminAuth": { requireAdminPagePermissionForRequest: async (_request: Request, page: string, permission: string) => {
      permissions.push([page, permission])
      if (options.permissionError) throw new Error(options.permissionError)
      return { username: "synthetic-editor", displayName: "Synthetic Editor", role: "USER" }
    } },
    "@/lib/adminAudit": {
      createAdminAuditContext(session: unknown, request: unknown, page: string) { audit.push({ session, request, page }); return { username: "synthetic-editor", pageId: page } },
      createAdminAuditedSupabaseClient(context: unknown, configuration: unknown) {
        audit.push({ context, configuration })
        return { from(table: string) {
          assert.equal(table, "shared_addressbook_groups")
          const mutate = (action: string, changes?: unknown) => {
            const call = { action, changes, filters: [] as Array<[string, unknown]> }
            calls.push(call)
            const query = {
              eq(field: string, value: unknown) { call.filters.push([field, value]); return query },
              select(columns: string) { assert.equal(columns, "*"); return query },
              async maybeSingle() {
                if (hold) await hold()
                if (options.databaseError) return { data: null, error: options.databaseError }
                if (!row || call.filters.some(([field, value]) => row![field as keyof Group] !== value)) return { data: null, error: null }
                let data: unknown
                if (action === "delete") { data = structuredClone(row); row = null; memberCount = 0 }
                else { row = { ...row, ...(changes as Partial<Group>), updated_at: "2026-10-14T10:00:00.123457+00:00" }; data = structuredClone(row) }
                return { data: Object.prototype.hasOwnProperty.call(options, "reply") ? options.reply : data, error: null }
              },
            }
            return query
          }
          return { update: (changes: unknown) => mutate("update", changes), delete: () => mutate("delete") }
        } }
      },
    },
  }
  vm.runInNewContext(output, { exports, Error, Date, Object, Array, String, Number, process: { env: { SUPABASE_SERVICE_ROLE_KEY: options.serviceKey ?? "fixture-key-not-live" } },
    require(name: string) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
    fetch() { throw new Error("No network access is allowed in this group fixture") },
  })
  const invoke = (body: unknown) => exports.POST!(new Request("https://fixture.invalid/api/outlook-addressbook/groups", { method: "POST", headers: { "content-type": "application/json", "referer": "https://forged.invalid/admin/user-management", "x-bunker-admin-user": "forged-user" }, body: JSON.stringify(body) }))
  return { invoke, calls, permissions, audit, current: () => row, members: () => memberCount,
    setRow(value: Group | null) { row = value },
    holdNext(value: () => Promise<void>) { hold = value },
  }
}

const save = (changes: unknown = { name: "EDITED GROUP" }, expectedUpdatedAt = initial.updated_at) => ({ action: "save", id: initial.id, expectedUpdatedAt, changes })
const remove = () => ({ action: "delete", id: initial.id, expectedUpdatedAt: initial.updated_at })

test("group saves are one authenticated audited UPDATE with raw-version CAS and returned canonical row", async () => {
  const f = fixture()
  const response = await f.invoke(save({ name: "  EDITED   GROUP  ", nickname: " " }))
  assert.equal(response.status, 200)
  assert.match(response.headers.get("cache-control") || "", /private.*no-store/)
  assert.deepEqual(f.permissions, [["outlook-addressbook", "edit"]])
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].action, "update")
  assert.deepEqual(f.calls[0].filters, [["id", initial.id], ["updated_at", initial.updated_at]])
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].changes)), { name: "EDITED GROUP", nickname: null })
  const payload = await response.json()
  assert.equal(payload.group.updated_at, "2026-10-14T10:00:00.123457+00:00")
  assert.equal(payload.group.source_uid, initial.source_uid)
  assert.equal(payload.group.member_count, 2)
  assert.equal(f.members(), 2)
  assert.equal((f.audit[0] as { request: unknown }).request, undefined, "Referer cannot supply audit identity/page")
  assert.equal((f.audit[0] as { page: string }).page, "outlook-addressbook")
})

test("group deletes use the same raw-version predicate and only acknowledge the returned identity", async () => {
  const f = fixture()
  const response = await f.invoke(remove())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { deleted: { id: initial.id, updated_at: initial.updated_at } })
  assert.equal(f.calls[0].action, "delete")
  assert.deepEqual(f.calls[0].filters, [["id", initial.id], ["updated_at", initial.updated_at]])
  assert.equal(f.current(), null)
  assert.equal(f.members(), 0)
})

test("stale same-user or membership-advanced versions cannot overwrite or delete a group", async () => {
  for (const body of [save(), remove()]) {
    const f = fixture()
    const changed = { ...initial, member_count: 3, updated_at: "2026-10-14T10:00:00.123457+00:00" }
    f.setRow(changed)
    const response = await f.invoke(body)
    assert.equal(response.status, 409)
    assert.match((await response.json()).message, /edits are still here/)
    assert.deepEqual(f.current(), changed)
  }
})

test("the held-save / delete race cannot resurrect a group or restore lost membership", async () => {
  const f = fixture()
  let release!: () => void
  let held!: () => void
  const reached = new Promise<void>(resolve => { held = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  f.holdNext(async () => { f.holdNext(async () => {}); held(); await waiting })
  const pendingSave = f.invoke(save())
  await reached
  assert.equal((await f.invoke(remove())).status, 200)
  release()
  assert.equal((await pendingSave).status, 409)
  assert.equal(f.current(), null)
  assert.equal(f.members(), 0)
  assert.deepEqual(f.calls.map(call => call.action), ["update", "delete"])
})

test("deleted targets remain absent rather than becoming new groups", async () => {
  for (const body of [save(), remove()]) {
    const f = fixture(); f.setRow(null)
    assert.equal((await f.invoke(body)).status, 409)
    assert.equal(f.current(), null)
  }
})

test("invalid actions, shapes, blank required values and protected columns stop before any write", async () => {
  for (const body of [null, [], { ...save(), action: ["save"] }, { ...save(), action: "upsert" }, { ...save(), id: "" }, { ...save(), id: "bad\nidentity" }, { ...save(), expectedUpdatedAt: "2026-02-30T10:00:00Z" }, { ...save(), expectedUpdatedAt: "2026-10-14" }, save({}), save([]), save({ name: "" }), save({ source_book: " " }), save({ nickname: 5 }), save({ description: {} }), save({ name: "A\u0000B" }), save({ id: "different" }), save({ source_uid: "replacement" }), save({ member_count: 0 }), save({ updated_at: "2099-01-01T00:00:00Z" }), { ...save(), username: "forged" }, { ...remove(), changes: {} }]) {
    const f = fixture()
    const response = await f.invoke(body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(f.calls.length, 0)
  }
})

test("authentication and view-only permissions reject before accessing group data", async () => {
  for (const [permissionError, expected] of [["Unauthorized", 401], ["Forbidden", 403]] as const) {
    const f = fixture({ permissionError })
    const response = await f.invoke(save())
    assert.equal(response.status, expected)
    assert.match(response.headers.get("cache-control") || "", /private.*no-store/)
    assert.equal(f.calls.length, 0)
  }
})

test("missing service credentials fail closed, without anonymous fallback", async () => {
  const f = fixture({ serviceKey: "" })
  assert.equal((await f.invoke(save())).status, 503)
  assert.equal(f.calls.length, 0)
})

test("malformed and inconsistent save acknowledgements cannot claim success", async () => {
  for (const reply of [{ ...initial, name: "EDITED GROUP" }, { ...initial, id: "wrong", updated_at: "2026-10-14T10:00:01Z" }, { ...initial, name: "WRONG", updated_at: "2026-10-14T10:00:01Z" }, { ...initial, name: "EDITED GROUP", updated_at: "invalid" }, { ...initial, name: "EDITED GROUP", member_count: -1, updated_at: "2026-10-14T10:00:01Z" }, {}]) {
    const f = fixture({ reply })
    assert.equal((await f.invoke(save())).status, 500)
  }
})

test("malformed deletion acknowledgements cannot claim the wrong group was deleted", async () => {
  for (const reply of [{ ...initial, id: "wrong" }, { ...initial, updated_at: "2026-10-14T10:00:01Z" }]) {
    const f = fixture({ reply })
    assert.equal((await f.invoke(remove())).status, 500)
  }
})

test("database errors are classified without leaking technical details", async () => {
  for (const [code, expected] of [["PGRST116", 409], ["23505", 400], ["23514", 400], ["XX000", 500]] as const) {
    const f = fixture({ databaseError: { code, message: "PRIVATE DATABASE DETAIL" } })
    const response = await f.invoke(save())
    assert.equal(response.status, expected)
    assert.ok(!(await response.text()).includes("PRIVATE DATABASE DETAIL"))
  }
})
