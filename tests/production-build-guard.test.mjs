import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { readFileSync, existsSync } from "node:fs"
import { createImportErrorDetector, runProductionBuild } from "../scripts/build-production.mjs"

function compiler({ stdout = [], stderr = [], code = 0, signal = null, error = false } = {}) {
  let out = "", err = ""
  return {
    output: () => ({ out, err }),
    options: {
      stdout: { write: chunk => { out += chunk } }, stderr: { write: chunk => { err += chunk } },
      spawn(executable, args, options) {
        assert.equal(executable, process.execPath)
        assert.equal(args.at(-2), "build"); assert.equal(args.at(-1), "--webpack")
        assert.ok(args[0].endsWith("/node_modules/next/dist/bin/next"))
        assert.deepEqual(options.stdio, ["inherit", "pipe", "pipe"])
        const child = new EventEmitter()
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
        process.nextTick(() => {
          for (const value of stdout) child.stdout.write(value)
          for (const value of stderr) child.stderr.write(value)
          child.stdout.end(); child.stderr.end()
          if (error) child.emit("error", Error("private transport detail"))
          child.emit("close", code, signal)
        })
        return child
      },
    },
  }
}

test("zero-exit unresolved-import output is rejected on either stream, including split chunks", async () => {
  for (const fixture of [{ stdout: ["Attempted import error: 'a' is not exported"] },
    { stderr: ["\u001b[33mAttempted imp", "ort error:", " missing export\u001b[0m"] },
    { stdout: ["Module not found: invalid dependency"] },
    { stderr: ["export 'a' was not found in './dependency'"] }]) {
    const f = compiler(fixture), result = await runProductionBuild(f.options)
    assert.equal(result.compilerExitCode, 0); assert.equal(result.exitCode, 1); assert.equal(result.unresolvedImport, true)
    assert.match(f.output().err, /Production build rejected/)
  }
})

test("ordinary compiler output and unrelated warnings preserve a genuinely successful exit", async () => {
  const f = compiler({ stdout: ["Compiled successfully\n"], stderr: ["A non-import informational warning\n"] })
  assert.equal((await runProductionBuild(f.options)).exitCode, 0)
  assert.doesNotMatch(f.output().err, /rejected/)
})

test("nonzero exits, termination and spawn errors cannot become successful builds", async () => {
  for (const fixture of [{ code: 2 }, { code: null, signal: "SIGTERM" }, { code: null, error: true }]) {
    const f = compiler(fixture), result = await runProductionBuild(f.options)
    assert.notEqual(result.exitCode, 0)
    assert.doesNotMatch(f.output().err, /private transport detail/)
  }
})

test("the bounded detector does not forget an earlier import error after large later output", () => {
  const detector = createImportErrorDetector()
  detector.write("Attempted import error: broken symbol\n")
  for (let index = 0; index < 100; index++) detector.write("x".repeat(10000))
  assert.equal(detector.failed(), true)
})

test("local and Vercel builds share the guard; health orchestration has an unambiguous filename", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(pkg.scripts.build, "node scripts/build-production.mjs")
  assert.equal(pkg.scripts["vercel-build"], pkg.scripts.build)
  assert.equal(existsSync(new URL("../lib/storageMediaBackupHealth.ts", import.meta.url)), false)
  assert.equal(existsSync(new URL("../lib/storageMediaBackupHealthService.ts", import.meta.url)), true)
  assert.equal(existsSync(new URL("../lib/storageMediaBackupHealth.mjs", import.meta.url)), true)
  const health = readFileSync(new URL("../lib/systemHealth.ts", import.meta.url), "utf8")
  assert.match(health, /from "@\/lib\/storageMediaBackupHealthService"/)
  assert.doesNotMatch(health, /from "@\/lib\/storageMediaBackupHealth"/)
})
