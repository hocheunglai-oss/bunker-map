import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import test from "node:test"

const executable = process.env.FCUNO_PWSH_PATH
assert.ok(executable && isAbsolute(executable), "Use the explicit pinned PowerShell7.6 executable; no download or skipped fallback")
const source = process.env.FCUNO_EXCHANGE_DATE_TEST_SOURCE || fileURLToPath(new URL("../scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1", import.meta.url))
assert.ok(isAbsolute(source))
const sourceSha256 = createHash("sha256").update(readFileSync(source)).digest("hex")
const quote = value => `'${String(value).replaceAll("'", "''")}'`
const testCache = mkdtempSync(join(tmpdir(), "fcuno-pwsh-dates-"))
const runId = "11111111-1111-4111-8111-111111111111"
const certificationRunId = "22222222-2222-4222-8222-222222222222"
const fingerprint = "a".repeat(64)
const instant = Math.floor((Date.now() - 60_000) / 1000) * 1000
const timestamp = (milliseconds, suffix = "Z") => new Date(milliseconds).toISOString().replace(".000Z", ".1234567" + suffix)
const utc = timestamp(instant)
const offset = timestamp(instant + 8 * 3_600_000, "+08:00")
const withoutOffset = timestamp(instant, "")
const refresh = (certifiedAt = utc) => ({
  schema: "fcuno.outlook-template-recipient-refresh-state/v1", runId,
  executionMode: "incremental", verificationScope: "full", mode: "reconcile",
  queueSettled: true, reasons: ["stale-template-envelope"],
  certificationRunId, sourceFingerprint: fingerprint, certifiedAt,
})
const atomic = (certifiedAt = utc) => ({
  certified: true, atomicTemplateActivation: true, verificationScope: "full",
  executionMode: "incremental", readOnlyVerification: true, certifiedAt,
  templateReconciliation: {
    reconciled: true, idempotent: false, runId, sourceFingerprint: fingerprint,
    certifiedAt, updatedTemplates: 2,
    verification: {
      schema: "fcuno.outlook-template-recipient-truth/v2", valid: true,
      sourceTruthValid: true, certificationRunId: runId, sourceFingerprint: fingerprint,
      certifiedAt, templates: { total: 2, unresolved: 0, stale: 0, invalidShape: 0,
        withMissingRecipients: 0, withAmbiguousRecipients: 0, sendable: 2 },
    },
  },
})

// Real Invoke-SupabaseRest -> Invoke-RestMethod -> JSON conversion, then the
// actual source validator. The only overridden setting points at this owned
// loopback server; no credential, Exchange command or provider is accessible.
async function scenario({ kind, payload, injection = "", culture = "en-US", timezone = "UTC" }) {
  const sockets = new Set(), requests = []
  const expectedPath = kind === "refresh"
    ? `/rest/v1/rpc/get_outlook_template_recipient_refresh_state?p_run_id=${runId}`
    : "/rest/v1/owned-atomic-date-fixture"
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, loopback: request.socket.remoteAddress === "127.0.0.1" })
    if (request.socket.remoteAddress !== "127.0.0.1" || request.method !== "GET" || request.url !== expectedPath) {
      response.writeHead(400); response.end(); return
    }
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" })
    response.end(JSON.stringify(payload))
  })
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const script = `
    $ErrorActionPreference='Stop'
    if ($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSVersion.Minor -ne 6) { throw 'Pinned PowerShell7.6 is required' }
    function global:Connect-ExchangeOnline { throw 'TEST GUARD: no Exchange' }
    function global:Get-AutomationVariable { throw 'TEST GUARD: no live settings' }
    function global:Send-MailMessage { throw 'TEST GUARD: no email' }
    . ${quote(source)} -LibraryOnly
    [Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo(${quote(culture)})
    [Threading.Thread]::CurrentThread.CurrentUICulture=[Globalization.CultureInfo]::GetCultureInfo(${quote(culture)})
    function Get-AutomationSetting($Name) {
      if ($Name -ceq 'NEXT_PUBLIC_SUPABASE_URL') { return 'http://127.0.0.1:${port}' }
      if ($Name -ceq 'SUPABASE_SERVICE_ROLE_KEY') { return 'synthetic-loopback-test-key' }
      throw 'Unexpected test setting'
    }
    $script:CurrentQueueRunId=${quote(runId)}
    $script:CurrentSyncMode='incremental'
    $script:OriginalDateRest=(Get-Item function:Invoke-SupabaseRest).ScriptBlock
    $script:RawDateType='null';$script:RawDateKind='none'
    function Invoke-SupabaseRest($Method,$Path,$Body=$null) {
      $value=& $script:OriginalDateRest -Method $Method -Path $Path -Body $Body -ConnectionTimeoutSeconds 2 -OperationTimeoutSeconds 2
      if ($null -ne $value.certifiedAt) {
        $script:RawDateType=$value.certifiedAt.GetType().FullName
        if ($value.certifiedAt -is [DateTime]) { $script:RawDateKind=[string]$value.certifiedAt.Kind }
      }
      ${injection === "offset-object" ? `$value.certifiedAt=[DateTimeOffset]::Parse(${quote(offset)},[Globalization.CultureInfo]::InvariantCulture)` : ""}
      ${injection === "string" ? `$value.certifiedAt=${quote(utc)}` : ""}
      return $value
    }
    try {
      if (${quote(kind)} -ceq 'refresh') {
        $result=Get-OutlookTemplateRecipientRefreshState
        $normalized=$result.certifiedAt
        $utcText=if ($null -eq $normalized) { $null } else { ([DateTimeOffset]::Parse($normalized,[Globalization.CultureInfo]::InvariantCulture)).UtcDateTime.ToString('o',[Globalization.CultureInfo]::InvariantCulture) }
        [pscustomobject]@{accepted=$true;normalized=$normalized;normalizedType=$(if ($null -eq $normalized){'null'}else{$normalized.GetType().FullName});utcText=$utcText;reasonsArray=($result.reasons -is [array]);queueSettledBool=($result.queueSettled -is [bool]);mode=$result.mode;runId=$result.runId;rawDateType=$script:RawDateType;rawDateKind=$script:RawDateKind;powerShell=[string]$PSVersionTable.PSVersion} | ConvertTo-Json -Depth 8 -Compress
      } else {
        $result=Invoke-SupabaseRest -Method GET -Path 'owned-atomic-date-fixture'
        $errorText=Get-AtomicExchangeTemplateActivationContractError $result ${quote(runId)} ${quote(fingerprint)} $true
        [pscustomobject]@{accepted=(-not $errorText);error=$errorText;rawDateType=$script:RawDateType;rawDateKind=$script:RawDateKind;certifiedBool=($result.certified -is [bool]);updatedTemplatesInteger=(Test-NativeNonnegativeInt64 $result.templateReconciliation.updatedTemplates);powerShell=[string]$PSVersionTable.PSVersion} | ConvertTo-Json -Depth 8 -Compress
      }
    } catch {
      [pscustomobject]@{accepted=$false;error=$_.Exception.Message;rawDateType=$script:RawDateType;rawDateKind=$script:RawDateKind;powerShell=[string]$PSVersionTable.PSVersion} | ConvertTo-Json -Depth 8 -Compress
    }
  `
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C", TZ: timezone, TMPDIR: testCache,
      DOTNET_CLI_TELEMETRY_OPTOUT: "1", POWERSHELL_TELEMETRY_OPTOUT: "1", PSModuleAnalysisCachePath: join(testCache, "module-analysis") },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "", stderr = "", expired = false
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
  child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 65536) child.kill("SIGTERM") })
  child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 65536) child.kill("SIGTERM") })
  const outer = setTimeout(() => { expired = true; child.kill("SIGTERM") }, 8000)
  try {
    const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })) })
    assert.equal(expired, false, "actual local HTTP/PowerShell operation must settle within its test bound")
    assert.equal(result.code, 0, stderr)
    assert.deepEqual(requests, [{ method: "GET", url: expectedPath, loopback: true }])
    const value = JSON.parse(stdout.trim())
    assert.match(value.powerShell, /^7\.6\./)
    return value
  } finally {
    clearTimeout(outer)
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL")
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"), sourceSha256, "worker source must stay frozen during verification")
  }
}

for (const entry of [
  { label: "UTC native DateTime with fractional ticks", payload: refresh() },
  { label: "offset native DateTime in French/Hong Kong", payload: refresh(offset), culture: "fr-FR", timezone: "Asia/Hong_Kong" },
  { label: "UTC native DateTime in Turkish/New York", payload: refresh(), culture: "tr-TR", timezone: "America/New_York" },
  { label: "typed DateTimeOffset after real HTTP conversion", payload: refresh(), injection: "offset-object" },
  { label: "existing string after real HTTP conversion", payload: refresh(), injection: "string" },
]) test(`refresh: ${entry.label} preserves the exact instant and native non-date fields`, async () => {
  const value = await scenario({ kind: "refresh", ...entry })
  assert.equal(value.accepted, true, value.error)
  assert.equal(value.rawDateType, "System.DateTime", "actual IRM must demonstrate the native conversion, not a hand-made fixture only")
  assert.equal(value.normalizedType, "System.String")
  assert.equal(value.utcText, utc)
  assert.equal(value.reasonsArray, true); assert.equal(value.queueSettledBool, true)
  assert.equal(value.mode, "reconcile"); assert.equal(value.runId, runId)
})

test("refresh: a valid35-hour certificate remains eligible", async () => {
  const value = await scenario({ kind: "refresh", payload: refresh(timestamp(instant - 35 * 3_600_000)) })
  assert.equal(value.accepted, true, value.error)
})
test("refresh: full mode may honestly require a new certification with null old identity", async () => {
  const value = await scenario({ kind: "refresh", payload: { ...refresh(null), mode: "full", certificationRunId: null, sourceFingerprint: null } })
  assert.equal(value.accepted, true, value.error); assert.equal(value.normalized, null)
  assert.equal(value.reasonsArray, true); assert.equal(value.queueSettledBool, true)
})
for (const [label, patch] of [
  ["37-hour stale certificate", { certifiedAt: timestamp(instant - 37 * 3_600_000) }],
  ["future certificate", { certifiedAt: timestamp(instant + 7 * 60_000) }],
  ["boolean date", { certifiedAt: true }], ["numeric date", { certifiedAt: 42 }],
  ["object date", { certifiedAt: { value: utc } }], ["array date", { certifiedAt: [utc] }],
  ["native unspecified date", { certifiedAt: withoutOffset }],
  ["invalid certification UUID", { certificationRunId: "not-a-uuid" }],
  ["invalid fingerprint", { sourceFingerprint: "A".repeat(64) }],
  ["string boolean flag", { queueSettled: "true" }], ["non-array reasons", { reasons: "stale-template-envelope" }],
]) test(`refresh: ${label} remains rejected`, async () => {
  const value = await scenario({ kind: "refresh", payload: { ...refresh(), ...patch } })
  assert.equal(value.accepted, false)
})

for (const entry of [
  { label: "UTC fractional native dates", payload: atomic() },
  { label: "offset fractional native dates French/Hong Kong", payload: atomic(offset), culture: "fr-FR", timezone: "Asia/Hong_Kong" },
  { label: "UTC fractional native dates Turkish/New York", payload: atomic(), culture: "tr-TR", timezone: "America/New_York" },
  { label: "typed top-level DateTimeOffset after HTTP conversion", payload: atomic(), injection: "offset-object" },
]) test(`atomic activation: ${entry.label} retains exact three-way timestamp equality`, async () => {
  const value = await scenario({ kind: "atomic", ...entry })
  assert.equal(value.accepted, true, value.error)
  assert.equal(value.rawDateType, "System.DateTime")
  assert.equal(value.certifiedBool, true); assert.equal(value.updatedTemplatesInteger, true)
})
const oneTickLater = utc.replace(".1234567Z", ".1234568Z")
for (const [label, mutate] of [
  ["one tick nested reconciliation mismatch", value => { value.templateReconciliation.certifiedAt = oneTickLater }],
  ["one tick nested verification mismatch", value => { value.templateReconciliation.verification.certifiedAt = oneTickLater }],
  ["array certification time", value => { value.certifiedAt = [utc] }],
  ["boolean certification time", value => { value.certifiedAt = true }],
  ["numeric certification time", value => { value.certifiedAt = 42 }],
  ["object certification time", value => { value.certifiedAt = { value: utc } }],
  ["native unspecified certification time", value => { value.certifiedAt = withoutOffset }],
  ["string certified flag", value => { value.certified = "true" }],
  ["string updated-template count", value => { value.templateReconciliation.updatedTemplates = "2" }],
]) test(`atomic activation: ${label} remains rejected`, async () => {
  const payload = atomic(); mutate(payload)
  const value = await scenario({ kind: "atomic", payload })
  assert.equal(value.accepted, false)
})
