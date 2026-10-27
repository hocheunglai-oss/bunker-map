import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import { BackupProtectionObservationError } from "../lib/backupProtectionPolicy"

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("Synthetic health fixture did not settle")), 2_000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

function fixture(options: { permissionError?: string; previewError?: boolean } = {}) {
  const calls: string[] = []
  let permissionError = options.permissionError, clock = Date.parse("2026-10-27T00:00:00Z")
  const holds: Array<{ started: ReturnType<typeof deferred<void>>; result: ReturnType<typeof deferred<void>> }> = []
  const preview = async () => { calls.push("read-only-preview"); if (options.previewError) throw new BackupProtectionObservationError(); return { accepted: true } }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Object.assign(Response, { json: Response.json }) },
    "@/lib/adminAuth": { async requireAdminPagePermission(page: string, permission: string) { calls.push(`${page}:${permission}`); if (permissionError) throw Error(permissionError) } },
    "@/lib/systemHealth": { async getSystemHealth(input: { backupGapObserver: unknown }) {
      calls.push("health")
      assert.equal(input.backupGapObserver, preview)
      await preview()
      const hold = holds.shift()
      if (hold) { hold.started.resolve(); await hold.result.promise }
      return { status: "error", checks: [{ id: "backup", status: "error", message: "The overnight backup is missing." }] }
    } },
    "@/lib/serverTiming": { timedJson(_path: string, _startedAt: number, health: unknown) { return Response.json(health) } },
    "@/lib/backupProtectionGapStore": {
      createBackupProtectionGapPreviewObserver() { calls.push("preview-created"); return preview },
      createBackupProtectionGapObserver() { assert.fail("GET must never create the writable observer") },
    },
    "@/lib/backupProtectionPolicy": { BackupProtectionObservationError },
  }
  const loaded = { exports: {} as { GET(request: Request): Promise<Response> } }
  const code = transformSync(readFileSync(new URL("../app/api/admin/system-health/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "fetch", "Date", code)((name: string) => { assert.ok(name in modules, name); return modules[name] }, loaded, loaded.exports, () => assert.fail("No network in health-route fixture"), class extends Date { static now() { return clock } })
  return { calls,
    advance(ms: number) { clock += ms },
    permission(error?: string) { permissionError = error },
    holdNextCheck() {
      const hold = { started: deferred<void>(), result: deferred<void>() }; holds.push(hold)
      return { started: hold.started.promise, release() { hold.result.resolve() }, fail(error: Error) { hold.result.reject(error) } }
    },
    request(refresh = false) { return loaded.exports.GET(new Request(`https://fixture.invalid/api/admin/system-health${refresh ? "?refresh=1" : ""}`)) } }
}

test("actual dashboard GET denies signed-out/forbidden requests before any preview RPC or health cache access", async () => {
  for (const message of ["Unauthorized", "Forbidden"]) {
    const f = fixture({ permissionError: message })
    assert.equal((await f.request(true)).status, message === "Unauthorized" ? 401 : 403)
    assert.deepEqual(f.calls, ["system-health:view"])
  }
})

test("actual signed-in GET supplies only read-only projection and preserves cache/refresh behavior", async () => {
  const f = fixture()
  const first = await f.request()
  assert.equal(first.status, 200)
  assert.equal((await first.json()).checks[0].status, "error")
  assert.equal((await f.request()).status, 200)
  assert.equal(f.calls.filter((call) => call === "read-only-preview").length, 1, "ordinary GET reuses the existing60s cache")
  assert.equal((await f.request(true)).status, 200)
  assert.equal(f.calls.filter((call) => call === "read-only-preview").length, 2)
  assert.equal(f.calls.filter((call) => call === "system-health:view").length, 3, "cache never bypasses authorization")
})

test("preview failure fails closed and is not cached as a false healthy result", async () => {
  const f = fixture({ previewError: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await f.request()
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { message: "Backup protection is temporarily unavailable. Please try again." })
  }
  assert.equal(f.calls.filter((call) => call === "read-only-preview").length, 2)
})

test("actual route joins simultaneous forced refreshes into one read-only health load", async () => {
  const f = fixture(), hold = f.holdNextCheck()
  const first = f.request(true)
  try {
    await bounded(hold.started)
    const others = [f.request(true), f.request(true), f.request()]
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(f.calls.filter((call) => call === "health").length, 1)
    assert.equal(f.calls.filter((call) => call === "system-health:view").length, 4)
    hold.release()
    const responses = await bounded(Promise.all([first, ...others]))
    assert.ok(responses.every((response) => response.status === 200))
    const bodies = await Promise.all(responses.map((response) => response.json()))
    assert.ok(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0])))
  } finally { hold.release(); await first.catch(() => {}) }
})

test("forced refresh joins a normal load, and normal reads join refresh even when completed cache exists", async () => {
  const f = fixture(), initial = f.holdNextCheck()
  const first = f.request()
  try {
    await bounded(initial.started)
    const refresh = f.request(true)
    initial.release()
    assert.ok((await bounded(Promise.all([first, refresh]))).every((response) => response.status === 200))
    assert.equal(f.calls.filter((call) => call === "health").length, 1)
    const next = f.holdNextCheck(), fresh = f.request(true)
    try {
      await bounded(next.started)
      let cachedReadFinished = false
      const cachedRead = f.request().then((response) => { cachedReadFinished = true; return response })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(cachedReadFinished, false, "join the pending refresh instead of returning older cached health")
      assert.equal(f.calls.filter((call) => call === "health").length, 2)
      next.release()
      assert.ok((await bounded(Promise.all([fresh, cachedRead]))).every((response) => response.status === 200))
    } finally { next.release(); await fresh.catch(() => {}) }
  } finally { initial.release(); await first.catch(() => {}) }
})

test("every denied request authenticates before reading cached or in-flight results", async () => {
  const f = fixture()
  await f.request()
  for (const error of ["Unauthorized", "Forbidden"]) {
    f.permission(error)
    const before = f.calls.length
    assert.equal((await f.request()).status, error === "Unauthorized" ? 401 : 403)
    assert.deepEqual(f.calls.slice(before), ["system-health:view"])
  }
  f.permission()
  const hold = f.holdNextCheck(), active = f.request(true)
  try {
    await bounded(hold.started)
    f.permission("Forbidden")
    assert.equal((await f.request(true)).status, 403)
    assert.equal(f.calls.filter((call) => call === "health").length, 2)
  } finally { hold.release(); await active }
})

test("a shared rejected load fails closed for all waiters and clears ownership for the next request", async () => {
  for (const fault of [new BackupProtectionObservationError(), Error("Synthetic unavailable health")]) {
    const f = fixture(), hold = f.holdNextCheck()
    const first = f.request(true), firstSettled = Promise.allSettled([first])
    try {
      await bounded(hold.started)
      const second = f.request(), secondSettled = Promise.allSettled([second])
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(f.calls.filter((call) => call === "health").length, 1)
      hold.fail(fault)
      const settled = [...await bounded(firstSettled), ...await bounded(secondSettled)]
      if (fault instanceof BackupProtectionObservationError) {
        for (const result of settled) {
          assert.equal(result.status, "fulfilled")
          if (result.status === "fulfilled") assert.equal(result.value.status, 500)
        }
      } else {
        for (const result of settled) { assert.equal(result.status, "rejected"); if (result.status === "rejected") assert.equal(result.reason, fault) }
      }
      assert.equal((await f.request()).status, 200)
      assert.equal(f.calls.filter((call) => call === "health").length, 2, "failure is not cached or left as a stuck Promise")
    } finally { hold.release(); await firstSettled }
  }
})

test("completed success keeps the 60s cache while force still bypasses it and expiry triggers a new check", async () => {
  const f = fixture()
  await f.request()
  f.advance(59_999)
  await f.request()
  assert.equal(f.calls.filter((call) => call === "health").length, 1)
  await f.request(true)
  assert.equal(f.calls.filter((call) => call === "health").length, 2)
  f.advance(59_999)
  await f.request()
  assert.equal(f.calls.filter((call) => call === "health").length, 2)
  f.advance(1)
  await f.request()
  assert.equal(f.calls.filter((call) => call === "health").length, 3)
})
