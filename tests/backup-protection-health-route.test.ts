import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import { BackupProtectionObservationError } from "../lib/backupProtectionPolicy"

function fixture(options: { permissionError?: string; previewError?: boolean } = {}) {
  const calls: string[] = []
  const preview = async () => { calls.push("read-only-preview"); if (options.previewError) throw new BackupProtectionObservationError(); return { accepted: true } }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Object.assign(Response, { json: Response.json }) },
    "@/lib/adminAuth": { async requireAdminPagePermission(page: string, permission: string) { calls.push(`${page}:${permission}`); if (options.permissionError) throw Error(options.permissionError) } },
    "@/lib/systemHealth": { async getSystemHealth(input: { backupGapObserver: unknown }) {
      calls.push("health")
      assert.equal(input.backupGapObserver, preview)
      await preview()
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
  new Function("require", "module", "exports", "fetch", code)((name: string) => { assert.ok(name in modules, name); return modules[name] }, loaded, loaded.exports, () => assert.fail("No network in health-route fixture"))
  return { calls, request(refresh = false) { return loaded.exports.GET(new Request(`https://fixture.invalid/api/admin/system-health${refresh ? "?refresh=1" : ""}`)) } }
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
