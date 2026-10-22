import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { createAdminGroupSave, groupTestUser, groupTestPages } from "./fixtures/admin-role-default-save.mjs"

const userWrites = h => h.requests.filter(r => r.table === "admin_users" && r.method !== "GET")
const changedPolicy = { "user-management": "edit", attendancerecord: "none" }

for (const storage of ["table", "shared-store"]) {
  test(`${storage}: held user snapshot cannot revert a newer role or attendance edit`, async () => {
    let latest
    const h = createAdminGroupSave({ storage, afterUsersRead: async state => {
      state.users[0] = { ...state.users[0], role: "VN", updated_at: "2026-10-22T02:00:00.234567Z", permissions: { ...state.users[0].permissions, __adminRole: "VN", __attendanceGroup: "AC", __concurrent: "keep" } }
      latest = structuredClone(state.users)
    } })
    const result = await h.post()
    assert.equal(result.status, 200)
    assert.equal(result.body.roleDefault.memberCount, 1, "informational count is the captured membership snapshot")
    assert.deepEqual(h.state.users, latest)
    assert.deepEqual(userWrites(h), [])
    const actual = await h.load("@/lib/adminUsers").getDatabaseAdminUserByIdStrict(groupTestUser.id, groupTestPages)
    assert.equal(actual.role, "VN"); assert.equal(actual.attendanceGroup, "AC")
    assert.equal(actual.permissions["user-management"], "none", "latest group remains authoritative")
  })
  test(`${storage}: only the authoritative group is written; user snapshots and identity fields remain untouched`, async () => {
    const h = createAdminGroupSave({ storage }), before = structuredClone(h.state.users)
    const result = await h.post()
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.roleDefault.permissions, changedPolicy)
    assert.deepEqual(h.state.users, before)
    assert.deepEqual(userWrites(h), [])
    const writes = h.requests.filter(r => r.method !== "GET" && !(storage === "shared-store" && r.table === "admin_role_defaults"))
    assert.equal(writes.length, 1)
    assert.equal(writes[0].table, storage === "table" ? "admin_role_defaults" : "office_calendar_store")
    assert.equal(writes[0].headers["x-bunker-admin-user"], "operator@example.invalid")
    const actual = await h.load("@/lib/adminUsers").getDatabaseAdminUserByIdStrict(groupTestUser.id, groupTestPages)
    assert.deepEqual(actual.permissions, changedPolicy)
    assert.equal(actual.attendanceGroup, "BT")
  })
  test(`${storage}: persisted built-in, custom and alias defaults override stale copies without touching metadata`, async () => {
    for (const [metadataRole, expectedRole] of [["BT", "BT"], ["custom  group", "CUSTOM GROUP"], ["USER", "AC"], ["ADMIN", "ADMIN"]]) {
      const user = structuredClone(groupTestUser); user.permissions.__adminRole = metadataRole
      const h = createAdminGroupSave({ storage, users: [user] })
      const result = await h.save(expectedRole, { "user-management": "none", attendancerecord: "edit", unexpected: "edit" })
      const actual = await h.load("@/lib/adminUsers").getDatabaseAdminUserByIdStrict(user.id, groupTestPages)
      assert.equal(actual.role, expectedRole)
      assert.deepEqual(actual.permissions, expectedRole === "ADMIN" ? { "user-management": "edit", attendancerecord: "edit" } : { "user-management": "none", attendancerecord: "edit" })
      assert.deepEqual(actual.permissions, result.permissions)
      assert.deepEqual(h.state.users[0], user)
      assert.deepEqual(userWrites(h), [])
    }
  })
  test(`${storage}: unpersisted legacy group still derives its original stored-copy policy`, async () => {
    const user = structuredClone(groupTestUser); user.permissions.__adminRole = "LEGACY GROUP"
    const h = createAdminGroupSave({ storage, users: [user] }), api = h.load("@/lib/adminUsers")
    const groups = await api.listManagedAdminRoleDefaults(groupTestPages)
    const legacy = groups.find(g => g.role === "LEGACY GROUP")
    assert.equal(legacy.persisted, false)
    assert.deepEqual(legacy.permissions, { "user-management": "view", attendancerecord: "view" })
    assert.deepEqual((await api.getDatabaseAdminUserByIdStrict(user.id, groupTestPages)).permissions, legacy.permissions)
    assert.deepEqual(h.state.users[0], user)
  })
  test(`${storage}: group write failure does not create member writes or false success`, async () => {
    const h = createAdminGroupSave({ storage, failGroupWrite: true }), before = structuredClone(h.state)
    const result = await h.post()
    assert.equal(result.status, 500)
    assert.equal(result.body.success, undefined)
    assert.deepEqual(h.state, before)
    assert.deepEqual(userWrites(h), [])
  })
}

test("View, denied and signed-out group writes stop before privileged transport", async () => {
  for (const [options, status] of [[{ permission: "view" }, 403], [{ permission: "none" }, 403], [{ authenticated: false }, 401]]) {
    const h = createAdminGroupSave(options), result = await h.post()
    assert.equal(result.status, status); assert.deepEqual(h.requests, [])
  }
})

test("the signed identity contracts remain exact and contain no group-policy field", () => {
  const manifest = JSON.parse(readFileSync(new URL("../contracts/fcuno-fcos/v1/contract-manifest.json", import.meta.url), "utf8"))
  assert.equal(manifest.aggregateSha256, "7fc54e7c3bd79fb014ad81dc6d9190d021549d9428486ef85ed78fdff95d7cc2")
  for (const spec of manifest.files) {
    const data = readFileSync(new URL("../contracts/fcuno-fcos/v1/" + spec.path, import.meta.url))
    assert.equal(createHash("sha256").update(data).digest("hex"), spec.sha256)
  }
  const sync = JSON.parse(readFileSync(new URL("../contracts/fcuno-fcos/v1/identity-sync-event.schema.json", import.meta.url), "utf8"))
  assert.equal(sync.properties.identity.additionalProperties, false)
  assert.equal(sync.properties.identity.properties.permissions, undefined)
  assert.equal(sync.properties.identity.properties.role, undefined)
})
