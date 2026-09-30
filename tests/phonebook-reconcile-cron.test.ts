import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const require = createRequire(import.meta.url)
function fixture({ secret = "test-secret", backup = false, fails = false } = {}) {
  let calls = 0
  const source = readFileSync(new URL("../app/api/cron/phonebook-carddav-reconcile/route.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, unknown> = {}
  vm.runInNewContext(compiled, {
    exports, Buffer, process: { env: { CRON_SECRET: secret, NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-only" } }, console: { error() {} },
    require(name: string) {
      if (name === "next/server") return { NextResponse: { json: (body: unknown, init: ResponseInit) => Response.json(body, init) } }
      if (name === "@supabase/supabase-js") return { createClient: () => ({}) }
      if (name === "@/lib/backupMaintenance") return { isVerifiedBackupActive: async () => backup }
      if (name === "@/lib/phonebookCarddavReconcile") return { runPhonebookCarddavReconcile: async () => {
        calls++
        if (fails) throw new Error("private provider detail")
        return { verified: true, saved: 2, total: 2 }
      } }
      return require(name)
    },
  })
  return { get: exports.GET as (request: Request) => Promise<Response>, calls: () => calls }
}

test("reconciliation cron never mutates without its server secret", async () => {
  for (const authorization of ["", "Bearer wrong", "test-secret"]) {
    const f = fixture()
    const response = await f.get(new Request("https://fcuno.com/api/cron/phonebook-carddav-reconcile", { headers: { authorization } }))
    assert.equal(response.status, 401)
    assert.equal(f.calls(), 0)
    assert.match(response.headers.get("cache-control")!, /no-store/)
  }
  const f = fixture({ secret: "" })
  assert.equal((await f.get(new Request("https://fcuno.com"))).status, 503)
  assert.equal(f.calls(), 0)
})

test("verified backups defer the worker", async () => {
  const f = fixture({ backup: true })
  const response = await f.get(new Request("https://fcuno.com", { headers: { authorization: "Bearer test-secret" } }))
  assert.equal((await response.json()).deferred, true)
  assert.equal(f.calls(), 0)
})

test("authorized cron returns verified result and sanitizes failures", async () => {
  for (const fails of [false, true]) {
    const f = fixture({ fails })
    const response = await f.get(new Request("https://fcuno.com", { headers: { authorization: "Bearer test-secret" } }))
    assert.equal(f.calls(), 1)
    assert.equal(response.status, fails ? 503 : 200)
    assert.doesNotMatch(await response.text(), /private provider detail/)
  }
})

test("production runs phonebook reconciliation every five minutes", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"))
  assert.equal(config.crons.find((job: { path: string }) => job.path === "/api/cron/phonebook-carddav-reconcile")?.schedule, "*/5 * * * *")
})
