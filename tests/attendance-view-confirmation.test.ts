import assert from "node:assert/strict"
import test from "node:test"
import { isViewOnlyAttendanceConfirmation } from "../lib/adminViewOnlyRequests"

const origin = "https://fcuno.com"
const path = "/api/admin/attendance"
const payload = { action: "save-confirmation", confirmation: { personId: "own-person", year: 2026, month: 9, status: "confirmed" } }
const options = (body: unknown = payload): RequestInit => ({ method: "POST", body: JSON.stringify(body) })
const allowed = (input: RequestInfo | URL = path, init: RequestInit | undefined = options(), page = "attendance-record", canView = true) =>
  isViewOnlyAttendanceConfirmation(input, init, origin, page, canView)

test("View attendance confirmation reaches the server for its ownership and closed-month checks", async () => {
  assert.equal(await allowed(), true)
  assert.equal(await allowed(new URL(path, origin)), true)
  assert.equal(await allowed(path, { ...options(), method: "post" }), true)
})

test("the exception is restricted to the attendance page with View access and its same-origin POST endpoint", async () => {
  for (const url of ["https://example.com/api/admin/attendance", "/api/admin/attendance/other", "/api/admin/users", "/api/admin/attendance/"]) {
    assert.equal(await allowed(url), false, url)
  }
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"]) {
    assert.equal(await allowed(path, { ...options(), method }), false, method)
  }
  assert.equal(await allowed(path, options(), "user-management"), false)
  assert.equal(await allowed(path, options(), "attendance-record", false), false)
})

test("edits, reminders, syncs, resets and malformed confirmation payloads remain blocked", async () => {
  for (const action of ["save-day-edit", "save-person", "send-reminder", "sync", "delete-leave"]) {
    assert.equal(await allowed(path, options({ ...payload, action })), false, action)
  }
  for (const body of [null, [], {}, { action: "save-confirmation" }, { ...payload, confirmation: [] }, { ...payload, confirmation: { status: "pending" } }]) {
    assert.equal(await allowed(path, options(body)), false)
  }
  assert.equal(await allowed(path, { method: "POST", body: "not-json" }), false)
  assert.equal(await allowed(path, { method: "POST", body: new FormData() }), false)
  assert.equal(await allowed(path, { method: "POST" }), false)
})

test("Request payload inspection preserves the body and respects init overrides", async () => {
  const request = new Request(new URL(path, origin), options())
  assert.equal(await isViewOnlyAttendanceConfirmation(request, undefined, origin, "attendance-record", true), true)
  assert.equal(request.bodyUsed, false)
  assert.equal(await allowed(request, options({ action: "save-day-edit" })), false)
  assert.equal(await allowed(request, { method: "DELETE" }), false)
  assert.deepEqual(await request.json(), payload)
  assert.equal(await isViewOnlyAttendanceConfirmation(request, undefined, origin, "attendance-record", true), false)
})
