import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { setupNativeCcinfo, literal } from "./fixtures/native-postgres-ccinfo.mjs"

// This test deliberately joins the real worker and real SQL policy. Only the
// upstream certification error and SMTP transport are synthetic boundaries.
// PowerShell's production REST wrapper, HTTP JSON conversion, classifier,
// delivery receipt validation and service-role database RPCs are not mocked.
const executable = process.env.FCUNO_PWSH_PATH
assert.ok(executable && isAbsolute(executable), "Use an explicit pinned PowerShell7.6 executable; no downloaded or skipped fallback")
assert.ok(process.env.NATIVE_PG_BIN && isAbsolute(process.env.NATIVE_PG_BIN), "A private native PostgreSQL17.6 runtime is required; no hosted/PGlite fallback")
const workerPath = fileURLToPath(new URL("../scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1", import.meta.url))
const sqlPath = fileURLToPath(new URL("../supabase/migrations/20261007065554_outlook_exchange_alert_delivery.sql", import.meta.url))
const hash = value => createHash("sha256").update(value).digest("hex")
const workerHash = hash(readFileSync(workerPath))
const sql = readFileSync(sqlPath, "utf8")
const sqlHash = hash(sql)
const quote = value => `'${String(value).replaceAll("'", "''")}'`
const legacyKey = hash("full|verification|Durable full certification")
const legacyServiceKey = hash("full|verification|service")
const serviceAccessKey = hash("full|service_access|service")
const operationAccessKey = hash("full|service_access|Durable full certification")
const storeKey = "outlook-addressbook-exchange-alerts:full"
const syntheticKey = "synthetic-owned-loopback-alert-key-not-a-provider-credential"
const allowedPaths = new Set([
  "/rest/v1/rpc/observe_outlook_exchange_alert",
  "/rest/v1/rpc/complete_outlook_exchange_alert",
])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const json = value => `${literal(JSON.stringify(value))}::jsonb`

test("actual worker → owned loopback HTTP → native PostgreSQL alert delivery across independent worker runs", { timeout: 120000 }, async t => {
  let fixture
  let server
  let dbSequence = 0
  let adapterMode = "native"
  const requests = [], violations = [], sockets = new Set()
  const cache = mkdtempSync(join(tmpdir(), "fcuno-alert-worker-native-"))
  const nativeCall = async (operation, body) => {
    const session = await fixture.session(`alert-http-${++dbSequence}`, true)
    try {
      if (operation === "observe") {
        assert.deepEqual(Object.keys(body).sort(), ["p_incidents", "p_observation_complete", "p_recovery_proven", "p_run_id", "p_scope"])
        assert.match(body.p_run_id, uuid)
        assert.equal(body.p_scope, "full")
        assert.ok(Array.isArray(body.p_incidents) && body.p_incidents.length <= 1000)
        assert.equal(typeof body.p_recovery_proven, "boolean")
        assert.equal(typeof body.p_observation_complete, "boolean")
        return await session.one(`select public.observe_outlook_exchange_alert(${literal(body.p_run_id)}::uuid,'full',${json(body.p_incidents)},${body.p_recovery_proven},${body.p_observation_complete});`)
      }
      assert.equal(operation, "complete")
      assert.deepEqual(Object.keys(body).sort(), ["p_claim_id", "p_delivered", "p_scope"])
      assert.equal(body.p_scope, "full")
      assert.match(body.p_claim_id, uuid)
      assert.equal(typeof body.p_delivered, "boolean")
      return await session.one(`select public.complete_outlook_exchange_alert('full',${literal(body.p_claim_id)}::uuid,${body.p_delivered});`)
    } finally { await session.close() }
  }
  const state = () => fixture.owner.one(`select coalesce((select payload from public.office_calendar_store where key=${literal(storeKey)}),'null'::jsonb);`)
  const reset = async () => { await fixture.owner.query("truncate public.office_calendar_store;"); adapterMode = "native"; requests.length = 0 }
  const seedDelivered = async ({ includeService = false } = {}) => {
    const incidents = [{ key: legacyKey, kind: "verification", immediate: true }]
    if (includeService) incidents.push({ key: legacyServiceKey, kind: "verification", immediate: true })
    const claimed = await nativeCall("observe", { p_run_id: randomUUID(), p_scope: "full", p_incidents: incidents, p_recovery_proven: false, p_observation_complete: false })
    assert.equal(claimed.shouldNotify, true)
    assert.equal((await nativeCall("complete", { p_scope: "full", p_claim_id: claimed.claimId, p_delivered: true })).delivered, true)
    await fixture.owner.query(`update public.office_calendar_store set payload=jsonb_set(payload,'{incidents}',(
      select jsonb_object_agg(key,value||jsonb_build_object('firstSeen',clock_timestamp()-interval '3 days','lastSeen',clock_timestamp()-interval '2 days','notifiedAt',clock_timestamp()-interval '2 days'))
      from jsonb_each(payload->'incidents')))where key=${literal(storeKey)};`)
    return state()
  }
  const worker = async ({ status = 521, outerStatus = null, completed = false, omit = null, falseFlag = null, smtpFailure = false, day = "2026-10-27", repeatInProcess = false } = {}) => {
    const runId = randomUUID(), countBefore = requests.length
    const source = `
      $ErrorActionPreference='Stop'
      $WarningPreference='Continue'
      if ($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSVersion.Minor -ne 6) { throw 'Pinned PowerShell7.6 is required' }
      function global:Connect-ExchangeOnline { throw 'TEST GUARD: no Exchange connection' }
      function global:Get-AutomationVariable { throw 'TEST GUARD: no live settings' }
      function global:Send-MailMessage { throw 'TEST GUARD: no real email' }
      function global:Invoke-WebRequest { throw 'TEST GUARD: no alternative network transport' }
      . ${quote(workerPath)} -LibraryOnly
      function Get-AutomationSetting($Name) {
        if ($Name -ceq 'NEXT_PUBLIC_SUPABASE_URL') { return 'http://127.0.0.1:${server.address().port}' }
        if ($Name -ceq 'SUPABASE_SERVICE_ROLE_KEY') { return ${quote(syntheticKey)} }
        throw 'TEST GUARD: unexpected required Automation setting'
      }
      function Get-OptionalAutomationSetting($Name) {
        if ($Name -ceq 'EXCHANGE_SYNC_NOTIFY_EMAILS') { return 'admin@example.invalid' }
        if ($Name -ceq 'EMAIL_NOTICE_FROM') { return 'FC Uno <sender@example.invalid>' }
        throw 'TEST GUARD: unexpected optional Automation setting'
      }
      $script:NativeAlertHttp=(Get-Command Microsoft.PowerShell.Utility\\Invoke-RestMethod -CommandType Cmdlet)
      function Invoke-RestMethod {
        [CmdletBinding()]
        param($Method,[uri]$Uri,$Headers,$Body,$ConnectionTimeoutSeconds,$OperationTimeoutSeconds)
        if ($Method -cne 'POST' -or $Uri.Scheme -cne 'http' -or $Uri.Host -cne '127.0.0.1' -or $Uri.Port -ne ${server.address().port} -or
            $Uri.Query -or $Uri.Fragment -or $Uri.UserInfo -or
            $Uri.AbsolutePath -cnotin @('/rest/v1/rpc/observe_outlook_exchange_alert','/rest/v1/rpc/complete_outlook_exchange_alert')) {
          throw 'TEST GUARD: request outside the owned alert RPC adapter'
        }
        & $script:NativeAlertHttp @PSBoundParameters
      }
      $script:SentMail=@()
      function Send-ExchangeSmtpMail($From,$To,$Subject,$Html) {
        if ($From -cne 'FC Uno <sender@example.invalid>' -or @($To).Count -ne 1 -or $To[0] -cne 'admin@example.invalid') { throw 'TEST GUARD: unexpected mail target' }
        $script:SentMail+=,[pscustomobject]@{from=$From;to=@($To);subject=$Subject;html=$Html}
        if (${smtpFailure ? "$true" : "$false"}) { throw 'Synthetic SMTP rejection; no network attempted' }
        return $true
      }
      function New-OwnedAlertHttpError([int]$Code) {
        $response=[System.Net.Http.HttpResponseMessage]::new([Enum]::ToObject([System.Net.HttpStatusCode],$Code))
        $exception=[Microsoft.PowerShell.Commands.HttpResponseException]::new("Response status code does not indicate success: $Code ().",$response)
        return [System.Management.Automation.ErrorRecord]::new($exception,'SyntheticHttpFailure',[System.Management.Automation.ErrorCategory]::InvalidOperation,$null)
      }
      # The only upstream certification seam: actual full-certification failure
      # handling must construct the detail and carry the typed error to policy.
      $script:CertificationError=New-OwnedAlertHttpError ${status}
      function Commit-FullExchangeQueueCertification { throw $script:CertificationError }
      $script:CurrentQueueRunId=${quote(runId)}
      $script:CurrentSyncMode='full'
      $details=@{runId=${quote(runId)};syncMode='full';failedQueueRows=0;backlogRows=0;terminalBacklogRows=0;changeDetails=@();
        contacts=0;groups=0;groupMembers=0;verifiedManagedContacts=0;verifiedManagedGroups=0;
        fullCertificationCommitted=$false;templateRecipientTruthReconciled=$false;truthLedgerCheckpointVerified=$false;
        requestedAt=${quote(day + "T22:10:00.000Z")}}
      if (${completed ? "$true" : "$false"}) {
        $details.truthLedgerCheckpointVerified=$true;$details.fullCertificationCommitted=$true;$details.templateRecipientTruthReconciled=$true
        ${omit ? `$details.Remove(${quote(omit)})` : ""}
        ${falseFlag ? `$details[${quote(falseFlag)}]=$false` : ""}
        $message='Verified full completion';$outcome='completed'
      } else {
        Complete-FullExchangeQueueCertificationIfEligible $details '10' ('a'*64) '{}' @{contacts=1} @() | Out-Null
        if ($details.failedQueueRows -ne 1 -or $details.fullCertificationCommitted -or $details.templateRecipientTruthReconciled) { throw 'Failure builder incorrectly certified the test run' }
        $message='Exchange full reconciliation failed with 1 validation or verification error(s).';$outcome='failed'
        if (${outerStatus !== null ? "$true" : "$false"}) {
          $outer=New-OwnedAlertHttpError ${outerStatus ?? 521}
          $message=$outer.Exception.Message
          $details.failureStage='verification'
          $details.failureRetryable=[bool](Test-ExchangeAlertTemporaryFailure $outer)
          $details.failureServiceAccess=[bool](Test-ExchangeAlertServiceAccessFailure $outer)
        }
      }
      $incidents=@(Get-ExchangeAlertIncidents $outcome $message $details 'full')
      $receipt=Invoke-ExchangeSyncNotificationPolicy $outcome $message $details @{}
      $repeat=$null
      if (${repeatInProcess ? "$true" : "$false"}) { $repeat=Invoke-ExchangeSyncNotificationPolicy $outcome $message $details @{} }
      [pscustomobject]@{runId=$script:CurrentQueueRunId;processId=$PID;powerShell=[string]$PSVersionTable.PSVersion;workerVersion=$ExchangeTruthWorkerVersion;
        receipt=$receipt;repeatReceipt=$repeat;incidents=@($incidents);mail=@($script:SentMail);details=$details} |
        ConvertTo-Json -Depth 18 -Compress | ForEach-Object { 'FCUNO_ALERT_RESULT '+$_ }
    `
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
      env: { PATH: `${dirname(executable)}:/usr/bin:/bin`, LANG: "C", LC_ALL: "C", TZ: "UTC", TMPDIR: cache,
        DOTNET_CLI_TELEMETRY_OPTOUT: "1", POWERSHELL_TELEMETRY_OPTOUT: "1", PSModulePath: join(dirname(executable), "Modules"), PSModuleAnalysisCachePath: join(cache, "module-analysis") },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "", stderr = "", expired = false, oversized = false
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 131072) { oversized = true; child.kill("SIGTERM") } })
    child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 65536) { oversized = true; child.kill("SIGTERM") } })
    const timer = setTimeout(() => { expired = true; child.kill("SIGTERM") }, 10000)
    try {
      const ended = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })) })
      assert.equal(expired, false, "actual worker/HTTP/native operation must settle inside its10-second bound")
      assert.equal(oversized, false)
      assert.equal(ended.code, 0, stderr || stdout)
      const resultLines = stdout.split(/\r?\n/).filter(line => line.startsWith("FCUNO_ALERT_RESULT "))
      assert.equal(resultLines.length, 1, stdout)
      const value = JSON.parse(resultLines[0].slice("FCUNO_ALERT_RESULT ".length))
      assert.equal(value.runId, runId)
      assert.match(value.powerShell, /^7\.6\./)
      assert.equal(value.processId, child.pid, "Evidence must come from this actual independent PowerShell process")
      return { ...value, requests: requests.slice(countBefore) }
    } finally {
      clearTimeout(timer)
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL")
      assert.equal(hash(readFileSync(workerPath)), workerHash, "Worker source must remain frozen throughout cross-run verification")
      assert.equal(hash(readFileSync(sqlPath)), sqlHash, "Alert SQL source must remain frozen throughout verification")
    }
  }
  const assertSilent = value => {
    assert.equal(value.receipt.Attempted, false)
    assert.equal(value.receipt.Delivered, false)
    assert.equal(value.mail.length, 0)
    assert.equal(value.requests.filter(request => request.operation === "complete").length, 0)
  }
  const assertOneDelivery = value => {
    assert.equal(value.receipt.Status, "delivered")
    assert.equal(value.receipt.Attempted, true)
    assert.equal(value.receipt.Delivered, true)
    assert.equal(value.details.notificationHistorySaved, true)
    assert.equal(value.mail.length, 1)
    const completions = value.requests.filter(request => request.operation === "complete")
    assert.equal(completions.length, 1)
    assert.equal(completions[0].body.p_delivered, true)
    assert.equal(completions[0].native, true)
  }
  try {
    fixture = await setupNativeCcinfo(`create role anon;create role authenticated;create role service_role bypassrls;
      create table public.office_calendar_store(key text primary key,payload jsonb not null,updated_at timestamptz not null default now());
      alter table public.office_calendar_store enable row level security;
      grant select,insert,update,delete on public.office_calendar_store to service_role;
      ${sql}`)
    t.diagnostic(`Owned native cluster ${JSON.stringify({root: fixture.root, version: fixture.version, runtimeSha256: fixture.runtimeSha256, workerSha256: workerHash, alertSqlSha256: sqlHash})}`)
    server = createServer((request, response) => {
      const chunks = []; let bytes = 0
      request.on("data", chunk => { bytes += chunk.length; if (bytes > 262144) request.destroy(); else chunks.push(chunk) })
      request.on("end", async () => {
        try {
          assert.equal(request.socket.remoteAddress, "127.0.0.1")
          assert.equal(request.method, "POST")
          assert.ok(allowedPaths.has(request.url), "Only the two exact alert RPC paths are allowed")
          assert.equal(request.headers.host, `127.0.0.1:${server.address().port}`)
          assert.equal(request.headers.apikey, syntheticKey)
          assert.equal(request.headers.authorization, `Bearer ${syntheticKey}`)
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          const operation = request.url.endsWith("/observe_outlook_exchange_alert") ? "observe" : "complete"
          const entry = { operation, body, native: false }; requests.push(entry)
          if (adapterMode === "unavailable") {
            response.writeHead(503, { "Content-Type": "application/json", Connection: "close" }); response.end(JSON.stringify({ code: "synthetic_unavailable", message: "Owned adapter unavailable" })); return
          }
          if (adapterMode === "malformed") {
            response.writeHead(200, { "Content-Type": "application/json", Connection: "close" }); response.end(JSON.stringify({ shouldNotify: "false" })); return
          }
          let result
          try { result = await nativeCall(operation, body); entry.native = true }
          catch (error) {
            // Native SQL rejection is a real policy failure, not an adapter
            // assertion failure. Do not reset/correct its corrupt stored state.
            entry.sqlError = error.code ?? "P0001"
            response.writeHead(500, { "Content-Type": "application/json", Connection: "close" }); response.end(JSON.stringify({ code: entry.sqlError, message: "Owned native alert policy rejected the operation" })); return
          }
          response.writeHead(200, { "Content-Type": "application/json", Connection: "close" }); response.end(JSON.stringify(result))
        } catch (error) {
          violations.push(error.message)
          response.writeHead(400, { Connection: "close" }); response.end("Owned adapter guard rejected the request")
        }
      })
    })
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)) })
    server.requestTimeout = 5000; server.headersTimeout = 5000
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })

    await t.test("already-delivered legacy certification remains silent over two days and two fresh PowerShell processes, including HTTP521 outer catch", async () => {
      await reset(); const before = await seedDelivered()
      const first = await worker({ status: 500, day: "2026-10-26" })
      const second = await worker({ status: 521, outerStatus: 521, day: "2026-10-27", repeatInProcess: true })
      assert.notEqual(first.runId, second.runId); assert.notEqual(first.processId, second.processId)
      for (const value of [first, second]) {
        assertSilent(value)
        assert.equal(value.receipt.Status, "not_required")
        assert.equal(value.details.notificationDecisionReason, "already_notified")
        assert.deepEqual(value.incidents.map(i => ({key: i.key, kind: i.kind, immediate: i.immediate})), [{key: legacyKey, kind: "verification", immediate: false}])
        assert.equal(value.requests.length, 1, "A process-local replay must not make another HTTP request")
        assert.equal(value.requests[0].native, true)
      }
      const after = await state()
      assert.deepEqual(Object.keys(after.incidents), [legacyKey])
      assert.equal(after.incidents[legacyKey].notifiedAt, before.incidents[legacyKey].notifiedAt)
      assert.equal(after.incidents[legacyKey].firstSeen, before.incidents[legacyKey].firstSeen)
      assert.equal(after.incidents[legacyKey].distinctRuns, 2)
    })

    for (const code of [401, 403]) await t.test(`new typed HTTP${code} inside certification alerts once and saves a durable delivery acknowledgement`, async () => {
      await reset(); const before = await seedDelivered()
      const first = await worker({ status: code, day: "2026-10-26" })
      const second = await worker({ status: code, day: "2026-10-27" })
      assertOneDelivery(first); assertSilent(second)
      assert.equal(second.receipt.Status, "not_required")
      for (const value of [first, second]) {
        assert.deepEqual(value.incidents.map(i => ({key: i.key, kind: i.kind, immediate: i.immediate})), [{key: operationAccessKey, kind: "service_access", immediate: true}])
        assert.equal(value.details.changeDetails[0].serviceAccessFailure, true)
      }
      const after = await state()
      assert.equal(after.incidents[legacyKey].notifiedAt, before.incidents[legacyKey].notifiedAt)
      assert.ok(after.incidents[operationAccessKey].notifiedAt)
      assert.equal(after.lastCompletion.delivered, true)
      assert.equal(after.claim, undefined)
    })

    for (const code of [401, 403]) await t.test(`new outer HTTP${code} is not hidden by either delivered legacy verification hash`, async () => {
      await reset(); const before = await seedDelivered({includeService: true})
      const first = await worker({ status: 521, outerStatus: code })
      const second = await worker({ status: 521, outerStatus: code })
      assertOneDelivery(first); assertSilent(second)
      const observedKeys = first.incidents.map(i => i.key).sort()
      assert.deepEqual(observedKeys, [legacyKey, serviceAccessKey].sort())
      assert.equal(first.details.failureServiceAccess, true)
      const after = await state()
      for (const key of [legacyKey, legacyServiceKey]) assert.equal(after.incidents[key].notifiedAt, before.incidents[key].notifiedAt)
      assert.ok(after.incidents[serviceAccessKey].notifiedAt)
    })

    await t.test("corrupt native history fails closed without SMTP or silently resetting delivery history", async () => {
      await reset()
      const corrupt = {version: 0, incidents: {[legacyKey]: {kind: "verification", notifiedAt: "2026-10-24T00:00:00Z"}}}
      await fixture.owner.query(`insert into public.office_calendar_store(key,payload)values(${literal(storeKey)},${json(corrupt)});`)
      const value = await worker({status: 401})
      assertSilent(value); assert.equal(value.receipt.Status, "failed")
      assert.equal(value.details.notificationDecisionReason, "policy_unavailable")
      assert.equal(value.requests.length, 1)
      assert.equal(value.requests[0].sqlError, "P0001")
      assert.deepEqual(await state(), corrupt)
    })

    for (const mode of ["unavailable", "malformed"]) await t.test(`${mode} HTTP policy response cannot cause uncontrolled fallback mail`, async () => {
      await reset(); const before = await seedDelivered(); adapterMode = mode
      const first = await worker({status: 401}), second = await worker({status: 401})
      for (const value of [first, second]) {
        assertSilent(value); assert.equal(value.receipt.Status, "failed")
        assert.equal(value.details.notificationDecisionReason, "policy_unavailable")
        assert.equal(value.requests.length, 1)
        assert.equal(value.requests[0].native, false)
      }
      assert.deepEqual(await state(), before)
    })

    for (const flag of ["truthLedgerCheckpointVerified", "fullCertificationCommitted", "templateRecipientTruthReconciled"]) {
      for (const missing of [false, true]) await t.test(`a ${missing ? "missing" : "false"} ${flag} cannot clear/rearm delivered history`, async () => {
        await reset(); const before = await seedDelivered()
        const value = await worker({completed: true, ...(missing ? {omit: flag} : {falseFlag: flag})})
        assertSilent(value)
        assert.equal(value.requests.length, 1)
        assert.equal(value.requests[0].body.p_recovery_proven, false)
        assert.equal(value.requests[0].body.p_observation_complete, false)
        assert.deepEqual((await state()).incidents, before.incidents)
      })
    }

    await t.test("only verified complete recovery rearms history; the same later access failure may alert again", async () => {
      await reset(); await seedDelivered({includeService: true})
      const recovered = await worker({completed: true})
      assertSilent(recovered)
      assert.equal(recovered.details.notificationDecisionReason, "recovered")
      assert.equal(recovered.requests[0].body.p_recovery_proven, true)
      assert.equal(recovered.requests[0].body.p_observation_complete, true)
      assert.deepEqual((await state()).incidents, {})
      const failure = await worker({status: 401})
      assertOneDelivery(failure)
      assert.ok((await state()).incidents[operationAccessKey].notifiedAt)
    })

    await t.test("failed SMTP releases the real claim without acknowledging delivery or retrying mail in the same process", async () => {
      await reset()
      const rejected = await worker({status: 401, smtpFailure: true, repeatInProcess: true})
      assert.equal(rejected.receipt.Status, "failed")
      assert.equal(rejected.receipt.Attempted, true); assert.equal(rejected.receipt.Delivered, false)
      assert.equal(rejected.mail.length, 1)
      assert.equal(rejected.details.notificationHistorySaved, true)
      assert.equal(rejected.requests.length, 2)
      assert.equal(rejected.requests[1].body.p_delivered, false)
      const failedState = await state()
      assert.equal(failedState.incidents[operationAccessKey].notifiedAt, undefined)
      assert.equal(failedState.lastCompletion.delivered, false)
      assert.equal(failedState.claim, undefined)
      const retry = await worker({status: 401})
      assertOneDelivery(retry)
      assert.ok((await state()).incidents[operationAccessKey].notifiedAt)
    })
    assert.deepEqual(violations, [], "No request may escape the exact loopback method/path/auth/payload boundary")
  } finally {
    for (const socket of sockets) socket.destroy()
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    if (fixture) {
      await fixture.close()
      t.diagnostic(`Owned native cluster and all worker/SQL clients stopped: ${fixture.root}`)
    }
    assert.equal(hash(readFileSync(workerPath)), workerHash)
    assert.equal(hash(readFileSync(sqlPath)), sqlHash)
  }
})
