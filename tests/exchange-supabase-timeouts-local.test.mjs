import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import test from "node:test"

const executable = process.env.FCUNO_PWSH_PATH
assert.ok(executable && isAbsolute(executable), "Use the explicitly pinned PowerShell7.6 executable; no skipped or downloaded fallback")
const source = fileURLToPath(new URL("../scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1", import.meta.url))
const quote = value => `'${value.replaceAll("'", "''")}'`
const testCache = mkdtempSync(join(tmpdir(), "fcuno-pwsh-http-cache-"))

async function scenario(mode, connection, operation) {
  const sockets = new Set(), requests = []
  let timer
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, apikey: request.headers.apikey, authorization: request.headers.authorization })
    assert.equal(request.socket.remoteAddress, "127.0.0.1")
    if (mode === "before-headers") return
    response.writeHead(200, { "Content-Type": "application/json", "Connection": "close" })
    if (mode === "idle-body") { response.write('{"ok":'); return }
    const chunks = ['{"ok":', 'true', '}']
    response.write(chunks.shift())
    timer = setInterval(() => { if (chunks.length) response.write(chunks.shift()); else { clearInterval(timer); response.end() } }, 400)
  })
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const script = `
    $ErrorActionPreference='Stop'
    if ($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSVersion.Minor -ne 6) { throw 'Pinned PowerShell7.6 is required' }
    function global:Connect-ExchangeOnline { throw 'TEST GUARD: no Exchange calls' }
    function global:Get-AutomationVariable { throw 'TEST GUARD: no live settings' }
    function global:Send-MailMessage { throw 'TEST GUARD: no email' }
    . ${quote(source)} -LibraryOnly
    function Get-AutomationSetting($Name) {
      if ($Name -eq 'NEXT_PUBLIC_SUPABASE_URL') { return 'http://127.0.0.1:${port}' }
      if ($Name -eq 'SUPABASE_SERVICE_ROLE_KEY') { return 'synthetic-local-test-key-not-real' }
      throw 'Unexpected setting'
    }
    $clock=[System.Diagnostics.Stopwatch]::StartNew()
    try {
      $value=Invoke-SupabaseRest -Method GET -Path 'owned-timeout-fixture' -ConnectionTimeoutSeconds ${connection} -OperationTimeoutSeconds ${operation}
      [pscustomobject]@{ timedOut=$false; ok=$value.ok; elapsedMilliseconds=$clock.ElapsedMilliseconds } | ConvertTo-Json -Compress
    } catch {
      [pscustomobject]@{ timedOut=$true; errorType=$_.Exception.GetType().FullName; elapsedMilliseconds=$clock.ElapsedMilliseconds } | ConvertTo-Json -Compress
    }
  `
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C", DOTNET_CLI_TELEMETRY_OPTOUT: "1", POWERSHELL_TELEMETRY_OPTOUT: "1", PSModuleAnalysisCachePath: join(testCache, "module-analysis") }, stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "", stderr = "", expired = false
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
  child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 65536) child.kill("SIGTERM") })
  child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 65536) child.kill("SIGTERM") })
  const outer = setTimeout(() => { expired = true; child.kill("SIGTERM") }, 6000)
  try {
    const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })) })
    assert.equal(expired, false, "The real HTTP command exceeded its explicit test timeout instead of settling")
    assert.equal(result.code, 0, stderr)
    assert.equal(requests.length, 1, "The REST helper must not invent a retry or call another endpoint")
    assert.deepEqual(requests[0], { method: "GET", url: "/rest/v1/owned-timeout-fixture", apikey: "synthetic-local-test-key-not-real", authorization: "Bearer synthetic-local-test-key-not-real" })
    return JSON.parse(stdout.trim())
  } finally {
    clearTimeout(outer); clearInterval(timer)
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL")
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

test("actual PowerShell7.6 REST connection timeout bounds a localhost server withholding headers", async () => {
  const result = await scenario("before-headers", 1, 1)
  assert.equal(result.timedOut, true)
  assert.ok(result.elapsedMilliseconds >= 700 && result.elapsedMilliseconds < 4500)
})

test("actual PowerShell7.6 REST idle-read timeout bounds a localhost body that stops sending", async () => {
  const result = await scenario("idle-body", 5, 1)
  assert.equal(result.timedOut, true)
  assert.ok(result.elapsedMilliseconds >= 700 && result.elapsedMilliseconds < 4500)
})

test("idle-read timeout is not misrepresented as a strict whole-stream deadline", async () => {
  const result = await scenario("stream", 5, 1)
  assert.equal(result.timedOut, false)
  assert.equal(result.ok, true)
  assert.ok(result.elapsedMilliseconds >= 1000)
})
