import assert from "node:assert/strict"
import test from "node:test"
import { createAdminGroupSave } from "./fixtures/admin-role-default-save.mjs"

for (const storage of ["table", "shared-store"]) test(`${storage}: actual SDK/store/API rejects stale editors and preserves disjoint saves`, async () => {
  const f = createAdminGroupSave({ storage }), oldBt = f.version("BT"), oldAc = f.version("AC")
  const save = (role, expectedVersion, permission) => f.request({ action: "save-role-default", roleDefault: { role, expectedVersion,
    permissions: { "user-management": permission, attendancerecord: permission } } })
  assert.equal((await save("BT", oldBt, "edit")).status, 200)
  assert.equal((await save("AC", oldAc, "none")).status, 200, "another group's change does not invalidate this target version")
  const before = structuredClone(f.state), stale = await save("BT", oldBt, "none")
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "ADMIN_PERMISSION_GROUP_CONFLICT")
  assert.deepEqual(f.state, before)
  assert.equal(f.requests.filter(r => r.method !== "GET" && r.table === "admin_users").length, 0)
})

test("missing/invalid browser versions fail before a privileged mutation", async () => {
  for (const expectedVersion of [undefined, "", "not-a-version", [], false]) {
    const f = createAdminGroupSave(), before = structuredClone(f.state)
    const result = await f.request({ action: "save-role-default", roleDefault: { role: "BT", expectedVersion, permissions: {} } })
    assert.equal(result.status, 409); assert.equal(result.body.code, "ADMIN_PERMISSION_GROUP_CONFLICT")
    assert.deepEqual(f.requests, []); assert.deepEqual(f.state, before)
  }
})

test("only the exact nonretryable business conflict is classified as a reload; real DB errors stay generic", async t => {
  for (const [name, error, status] of [
    ["exact conflict", { code: "P0001", message: "ADMIN_PERMISSION_GROUP_CONFLICT" }, 409],
    ["real serialization", { code: "40001", message: "ADMIN_PERMISSION_GROUP_CONFLICT" }, 500],
    ["unknown P0001", { code: "P0001", message: "PRIVATE_OTHER_ERROR" }, 500],
    ["marker suffix", { code: "P0001", message: "ADMIN_PERMISSION_GROUP_CONFLICT: PRIVATE_ROW" }, 500],
    ["marker only in details", { code: "P0001", message: "PRIVATE_OTHER_ERROR", details: "ADMIN_PERMISSION_GROUP_CONFLICT" }, 500],
    ["native constraint", { code: "23505", message: "PRIVATE_CONSTRAINT" }, 500],
    ["lock timeout", { code: "55P03", message: "PRIVATE_LOCK" }, 500],
  ]) await t.test(name, async () => {
    const f = createAdminGroupSave({ transport: () => Response.json(error, { status: 400 }) })
    const result = await f.request({ action: "save-role-default", roleDefault: { role: "BT", expectedVersion: "a".repeat(64), permissions: {} } })
    assert.equal(result.status, status)
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|40001|P0001|23505|55P03/)
    assert.equal(f.requests.length, 1, "POST is attempted once by the actual SDK")
  })
})

test("group deletion uses the target version and the database membership decision", async () => {
  const f = createAdminGroupSave(), oldVersion = f.version("CUSTOM GROUP")
  assert.equal((await f.request({ action: "delete-role-default", roleDefault: { role: "CUSTOM GROUP", expectedVersion: oldVersion } })).status, 200)
  const before = structuredClone(f.state)
  const stale = await f.request({ action: "delete-role-default", roleDefault: { role: "CUSTOM GROUP", expectedVersion: oldVersion } })
  assert.equal(stale.status, 409); assert.deepEqual(f.state, before)
})
