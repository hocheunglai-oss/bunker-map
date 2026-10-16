import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
import test from "node:test"
import * as validation from "../lib/taiwanRemarksSave"
import * as transport from "../lib/priceSetterRequest"

const change = (id: 1 | 2 | 3 = 2, content = "NEW\nNOTICE") => ({ id, expected: { id, exists: true, content: "OLD" }, content })
test("Taiwan baselines distinguish absent rows and existing nulls, retain exact bytes and reject incomplete reads", () => {
  assert.deepEqual(validation.captureTaiwanRemarkBaselines([{ id: 1, content: null }, { id: 2, content: " X\r\nY " }]), [
    { id: 1, exists: true, content: null }, { id: 2, exists: true, content: " X\r\nY " }, { id: 3, exists: false, content: null },
  ])
  for (const value of [null, [{ id: 1 }], [{ id: 1, content: "A" }, { id: 1, content: "B" }], [{ id: 101, content: "X" }]]) assert.throws(() => validation.captureTaiwanRemarkBaselines(value))
})
test("Taiwan save/confirmation requires exact changed IDs, captured baselines and safe completed wording", () => {
  assert.deepEqual(validation.parseTaiwanRemarksSave({ changes: [change()] }), [change()])
  for (const value of [null, {}, { changes: [] }, { changes: [change(), change()] }, { changes: [{ ...change(), expected: undefined }] },
    { changes: [{ ...change(), id: 101 }] }, { changes: [{ ...change(), expected: { id: 2, exists: false, content: "OLD" } }] },
    { changes: [change(2, "UNFINISHED [DATE]")] }, { changes: [change(3, '{"active":"false"}')] }, { changes: [change(2, "\0")] }]) assert.throws(() => validation.parseTaiwanRemarksSave(value))
  assert.equal(validation.confirmedTaiwanRemarksSave({ rows: [{ id: 2, content: "NEW\nNOTICE" }], replayed: false }, [change()]), true)
  for (const value of [null, {}, { rows: [], replayed: false }, { rows: [{ id: 1, content: "NEW\nNOTICE" }], replayed: false }, { rows: [{ id: 2, content: "WRONG" }], replayed: false }, { rows: [{ id: 2, content: "NEW\nNOTICE" }], replayed: false, extra: true }]) assert.equal(validation.confirmedTaiwanRemarksSave(value, [change()]), false)
})

function harness() {
  const calls: Array<{ name: string; args: unknown }> = [], permissions: Array<{ page: string; access: string }> = []
  const controls = { auth: "", error: null as null | { code: string; message: string }, data: { rows: [{ id: 2, content: "NEW\nNOTICE" }], replayed: false } as unknown, throw: false }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/taiwanRemarksSave": validation, "@/lib/priceSetterRequest": transport,
    "@/lib/adminAuth": { async requireAdminPagePermissionForRequest(_request: Request, page: string, access: string) { permissions.push({ page, access }); if (controls.auth) throw Error(controls.auth); return { username: "SERVER-EDITOR" } } },
    "@/lib/adminAudit": { createAdminAuditContext(session: unknown, _unused: unknown, page: string) { assert.equal(page, "taiwan-remarks"); return session },
      createAdminAuditedSupabaseClient(_context: unknown, options: unknown) { assert.deepEqual(options, { useServiceRole: true }); return { async rpc(name: string, args: unknown) { calls.push({ name, args }); if (controls.throw) throw Error("PRIVATE FAILURE"); return { data: controls.data, error: controls.error } } } } },
  }
  const loaded = { exports: {} as { POST: (request: Request) => Promise<Response> } }
  const code = transformSync(readFileSync(new URL("../app/api/admin/taiwan-remarks/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code
  new Function("require", "module", "exports", "process", code)((name: string) => { assert.ok(name in modules, name); return modules[name] }, loaded, loaded.exports, { env: { SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } })
  return { controls, calls, permissions, send: (payload: unknown = { changes: [change()] }) => loaded.exports.POST(new Request("https://synthetic.invalid/api/admin/taiwan-remarks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })) }
}
test("actual Taiwan save route pins Edit permission/audit client, rejects old missing baselines and verifies canonical response", async () => {
  const f = harness(), response = await f.send()
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /private, no-store/)
  assert.deepEqual(f.permissions, [{ page: "taiwan-remarks", access: "edit" }]); assert.deepEqual(f.calls, [{ name: "save_taiwan_remarks", args: { p_changes: [change()] } }])
  for (const [auth, status] of [["Unauthorized", 401], ["Forbidden", 403]] as const) { const denied = harness(); denied.controls.auth = auth; assert.equal((await denied.send()).status, status); assert.deepEqual(denied.calls, []) }
  for (const payload of [{ changes: [{ id: 2, content: "NEW" }] }, { id: 2, content: "NEW" }]) { const old = harness(); assert.equal((await old.send(payload)).status, 409); assert.deepEqual(old.calls, []) }
  for (const code of ["40001", "P0002", "55P03", "40P01"]) { const failed = harness(); failed.controls.error = { code, message: "PRIVATE" }; const res = await failed.send(); assert.equal(res.status, 409); assert.doesNotMatch(await res.text(), /PRIVATE/) }
  for (const data of [null, {}, { rows: [{ id: 2, content: "WRONG" }], replayed: false }]) { const bad = harness(); bad.controls.data = data; assert.equal((await bad.send()).status, 503) }
  const lost = harness(); lost.controls.throw = true; assert.equal((await lost.send()).status, 503)
})
