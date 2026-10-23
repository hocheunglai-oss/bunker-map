import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import test from "node:test"

const executable = process.env.FCUNO_PWSH_PATH
assert.ok(executable && isAbsolute(executable), "Use the pinned PowerShell7.6 executable; no skipped/downloaded fallback")
const source = process.env.FCUNO_CANCELLATION_WORKER_PATH || fileURLToPath(new URL("../scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1", import.meta.url))
assert.ok(isAbsolute(source), "Only an explicit absolute worker source is supported")
const quote = value => `'${value.replaceAll("'", "''")}'`
const cache = mkdtempSync(join(tmpdir(), "fcuno-atomic-cancellation-cache-"))
const hourly = "rpc/certify_staged_read_only_outlook_exchange_truth"
const daily = "rpc/certify_staged_full_outlook_truth_and_activate_templates"
const receipt = {
  certified: true, staged: true, reconciled: true, idempotent: true,
  reason: "Synthetic owned-loopback receipt, not a database certification",
  supersededCount: 0, supersededRows: [], certifiedAt: "2026-10-23T00:00:00.123456Z",
  sourceFingerprint: "a".repeat(64), queueFence: { sequence: 7 }, receipt: { owned: true },
}

async function scenario({ path = hourly, errorBody = JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), status = 500, contentType = "application/json", lostReply = false, expectedFailure = false, leaseFailure = null }) {
  const requests = [], leaseRequests = [], certificationRequests = [], sockets = new Set()
  const server = createServer((request, response) => {
    assert.equal(request.socket.remoteAddress, "127.0.0.1")
    const chunks = []
    request.on("data", chunk => chunks.push(chunk))
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString("utf8"), apikey: request.headers.apikey, authorization: request.headers.authorization })
      if (leaseFailure) {
        if (request.url === "/rest/v1/rpc/renew_outlook_exchange_sync_lock") {
          leaseRequests.push(requests.at(-1))
          const cancelled = leaseRequests.length === (leaseFailure === "before" ? 1 : 2)
          response.writeHead(cancelled ? 500 : 200, { "Content-Type": "application/json", Connection: "close" })
          response.end(cancelled ? errorBody : "true")
        } else {
          certificationRequests.push(requests.at(-1))
          response.writeHead(200, { "Content-Type": "application/json", Connection: "close" })
          response.end(JSON.stringify({ ...receipt, idempotent: certificationRequests.length > 1 }))
        }
        return
      }
      certificationRequests.push(requests.at(-1))
      if (requests.length === 1) {
        if (lostReply) { request.socket.destroy(); return }
        response.writeHead(status, { "Content-Type": contentType, Connection: "close" })
        response.end(errorBody)
      } else {
        response.writeHead(200, { "Content-Type": "application/json", Connection: "close" })
        response.end(JSON.stringify(receipt))
      }
    })
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
    function global:Invoke-WebRequest { throw 'TEST GUARD: no alternative transport' }
    . ${quote(source)} -LibraryOnly
    function Get-AutomationSetting($Name) {
      if ($Name -ceq 'NEXT_PUBLIC_SUPABASE_URL') { return 'http://127.0.0.1:${port}' }
      if ($Name -ceq 'SUPABASE_SERVICE_ROLE_KEY') { return 'synthetic-owned-loopback-key-not-real' }
      throw 'Unexpected setting'
    }
    $script:ActualRest=(Get-Item Function:Invoke-SupabaseRest).ScriptBlock
    $script:FirstError=$null
    function Invoke-SupabaseRest($Method,$Path,$Body,$ConnectionTimeoutSeconds=60,$OperationTimeoutSeconds=60) {
      try { & $script:ActualRest @PSBoundParameters } catch {
        if ($null -eq $script:FirstError) { $script:FirstError=$_ }
        throw
      }
    }
    $script:ActualLeaseCheck=(Get-Item Function:Renew-ExchangeSyncLockIfDue).ScriptBlock
    $script:SleepCalls=@();$script:LeaseChecks=0
    function Start-Sleep([int]$Seconds) { $script:SleepCalls+=,$Seconds }
    if (${leaseFailure ? "$true" : "$false"}) {
      $script:CurrentQueueRunId='11111111-1111-4111-8111-111111111111'
      $script:CurrentSyncMode='incremental';$script:SyncLockAcquired=$true
      $script:SyncLockRenewInterval=[TimeSpan]::Zero
      function Renew-ExchangeSyncLockIfDue { $script:LeaseChecks++; & $script:ActualLeaseCheck }
    } else {
      function Renew-ExchangeSyncLockIfDue { $script:LeaseChecks++ }
    }
    $body=@{p_run_id='11111111-1111-4111-8111-111111111111';p_source_fingerprint=('a'*64);p_queue_high_water_sequence=[long]7}
    $result=$null;$failure=$null
    try { $result=Invoke-ExchangeAtomicRpcWithRetry ${quote(path)} $body 'certified' 'queueFence' 'Owned loopback certification' } catch { $failure=$_ }
    $sameRecord=$false;$sameException=$false;$sameErrorContent=$false;$sqlCode=$null;$detailsLength=0;$statusCode=$null
    if ($null -ne $failure) {
      $sameRecord=[object]::ReferenceEquals($failure,$script:FirstError)
      $sameException=[object]::ReferenceEquals($failure.Exception,$script:FirstError.Exception)
      $sameErrorContent=$failure.ErrorDetails.Message -ceq $script:FirstError.ErrorDetails.Message -and
        $failure.FullyQualifiedErrorId -ceq $script:FirstError.FullyQualifiedErrorId -and
        $failure.CategoryInfo.Category -eq $script:FirstError.CategoryInfo.Category -and
        [object]::ReferenceEquals($failure.TargetObject,$script:FirstError.TargetObject)
      $detailsLength=$failure.ErrorDetails.Message.Length
      try { $parsed=ConvertFrom-Json -InputObject $failure.ErrorDetails.Message -AsHashtable -NoEnumerate -ErrorAction Stop; if($parsed -is [System.Collections.IDictionary] -and $parsed['code'] -is [string]){$sqlCode=$parsed['code']} } catch {}
      try { $statusCode=[int]$failure.Exception.Response.StatusCode } catch {}
    }
    [pscustomobject]@{failed=($null -ne $failure);success=($null -ne $result);sleeps=@($script:SleepCalls);leaseChecks=$script:LeaseChecks;sameErrorRecordWrapper=$sameRecord;sameException=$sameException;sameErrorContent=$sameErrorContent;sqlCode=$sqlCode;detailsLength=$detailsLength;statusCode=$statusCode;certified=$(if($result){$result.certified}else{$false});idempotent=$(if($result){$result.idempotent}else{$false});certifiedAt=$(if($result){$result.certifiedAt.ToUniversalTime().ToString('o')}else{$null});workerVersion=$ExchangeTruthWorkerVersion} | ConvertTo-Json -Compress -Depth 8
  `
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C", DOTNET_CLI_TELEMETRY_OPTOUT: "1", POWERSHELL_TELEMETRY_OPTOUT: "1", PSModuleAnalysisCachePath: join(cache, "module-analysis") }, stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "", stderr = "", expired = false
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
  child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 65536) child.kill("SIGTERM") })
  child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 65536) child.kill("SIGTERM") })
  const outer = setTimeout(() => { expired = true; child.kill("SIGTERM") }, 10000)
  try {
    const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })) })
    assert.equal(expired, false, "The owned PowerShell request must settle without a supervisor kill")
    assert.equal(result.code, 0, stderr)
    const observed = JSON.parse(stdout.trim())
    assert.equal(observed.failed, expectedFailure)
    assert.equal(observed.success, !expectedFailure)
    assert.equal(requests.length, leaseFailure ? (leaseFailure === "before" ? 4 : 6) : expectedFailure ? 1 : 2, "Count actual HTTP requests, not mocked calls")
    assert.deepEqual(observed.sleeps, expectedFailure ? [] : [2])
    assert.equal(observed.leaseChecks, leaseFailure === "after" ? 4 : expectedFailure ? 1 : 3)
    assert.equal(observed.certified, !expectedFailure)
    for (const request of requests) {
      assert.equal(request.method, "POST")
      assert.equal(request.apikey, "synthetic-owned-loopback-key-not-real")
      assert.equal(request.authorization, "Bearer synthetic-owned-loopback-key-not-real")
    }
    for (const request of certificationRequests) {
      assert.equal(request.url, `/rest/v1/${path}`)
      assert.deepEqual(JSON.parse(request.body), { p_run_id: "11111111-1111-4111-8111-111111111111", p_source_fingerprint: "a".repeat(64), p_queue_high_water_sequence: 7 })
      assert.equal(request.body, certificationRequests[0].body, "An ambiguous retry must retain exactly the same run/evidence body")
    }
    if (leaseFailure) {
      assert.equal(certificationRequests.length, leaseFailure === "before" ? 1 : 2)
      assert.equal(leaseRequests.length, leaseFailure === "before" ? 3 : 4)
      for (const request of leaseRequests) {
        assert.equal(request.url, "/rest/v1/rpc/renew_outlook_exchange_sync_lock")
        assert.deepEqual(JSON.parse(request.body), { p_run_id: "11111111-1111-4111-8111-111111111111", p_lease_minutes: 30 })
      }
      assert.equal(observed.idempotent, leaseFailure === "after")
      assert.equal(observed.certifiedAt, "2026-10-23T00:00:00.1234560Z")
    }
    if (expectedFailure) {
      // PowerShell can recreate its outer ErrorRecord wrapper when it crosses
      // function scopes. Preserve the actual exception and full error identity,
      // not an unsupported wrapper-object-reference assumption.
      assert.equal(observed.sameException, true, JSON.stringify(observed))
      assert.equal(observed.sameErrorContent, true, JSON.stringify(observed))
      assert.equal(observed.sqlCode, "57014")
      assert.equal(observed.statusCode, 500)
    }
    return { ...observed, requests: requests.length, certificationRequests: certificationRequests.length, leaseRequests: leaseRequests.length, childExited: true }
  } finally {
    clearTimeout(outer)
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL")
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    assert.equal(server.listening, false)
    assert.equal(sockets.size, 0, "All owned HTTP sockets must close")
  }
}

for (const path of [hourly, daily]) {
  test(`real HTTP500 typed cancellation defers ${path} after exactly one request preserving the original HTTP error`, async t => {
    const result = await scenario({ path, expectedFailure: true })
    t.diagnostic(JSON.stringify({ path, requests: result.requests, sleeps: result.sleeps.length, originalExceptionPreserved: result.sameException, originalErrorIdentityPreserved: result.sameErrorContent, sameErrorRecordWrapper: result.sameErrorRecordWrapper, childExited: result.childExited }))
  })
}

for (const path of [hourly, daily]) for (const leaseFailure of ["before", "after"]) {
  test(`real HTTP typed57014 from ${leaseFailure} due lease renewal retains certification replay: ${path}`, async t => {
    const result = await scenario({ path, leaseFailure })
    t.diagnostic(JSON.stringify({ path, leaseFailure, requests: result.requests, certificationRequests: result.certificationRequests, leaseRequests: result.leaseRequests, sleeps: result.sleeps.length, idempotent: result.idempotent, childExited: result.childExited }))
  })
}

for (const [name, options] of [
  ["lost reply", { lostReply: true }],
  ["transient HTTP503", { status: 503, errorBody: JSON.stringify({ code: "PGRST001", message: "Temporarily unavailable" }) }],
  ["SQL lock contention55P03", { errorBody: JSON.stringify({ code: "55P03", message: "canceling statement due to lock timeout" }) }],
]) test(`${name} retains same-run bounded idempotent retry`, async () => { await scenario(options) })

for (const [name, body, contentType = "application/json"] of [
  ["malformed JSON", "{"], ["empty body", ""], ["null root", "null"], ["empty array", "[]"],
  ["singleton object array", '[{"code":"57014"}]'], ["string root", '"57014"'],
  ["numeric code", '{"code":57014}'], ["null code", '{"code":null}'], ["boolean code", '{"code":true}'],
  ["array code", '{"code":["57014"]}'], ["object code", '{"code":{"code":"57014"}}'],
  ["missing code", '{"message":"57014"}'], ["code only in text", '{"code":"XX000","message":"SQLSTATE57014"}'],
  ["code only in hint", '{"hint":"57014"}'], ["nested code", '{"details":{"code":"57014"}}'],
  ["padded code", '{"code":" 57014 "}'], ["prefix code", '{"code":"570140"}'],
  ["oversized JSON", JSON.stringify({ code: "57014", message: "x".repeat(17000) })],
  ["excessive JSON depth", JSON.stringify({ code: "57014", details: { a: { b: { c: { d: { e: { f: { g: { h: {} } } } } } } } } })],
  ["HTML diagnostic", "<p>SQLSTATE57014</p>", "text/html"],
]) test(`${name} cannot classify a received error as exact SQL cancellation`, async () => { await scenario({ errorBody: body, contentType }) })

for (const path of ["rpc/stage_outlook_exchange_projection_snapshot", "rpc/stage_outlook_exchange_raw_source_snapshot", "rpc/reconcile_outlook_templates_with_certification_batch", hourly.toUpperCase(), `${hourly}?unrecognized=1`]) {
  test(`typed57014 does not alter retry policy outside exact final RPC path: ${path}`, async () => { await scenario({ path }) })
}
