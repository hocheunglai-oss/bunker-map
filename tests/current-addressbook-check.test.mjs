import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Deliberately no skip/fallback/download. Caller must name a trusted runtime.
// Children receive no inherited application tokens, provider settings or keys.
const executable = process.env.FCUNO_PWSH_PATH
assert.ok(executable && isAbsolute(executable), 'Set FCUNO_PWSH_PATH to the explicitly trusted PowerShell7.6 executable')
const root = fileURLToPath(new URL('../', import.meta.url))
const checker = join(root, 'scripts/azure-automation/check-fcuno-outlook-addressbook.ps1')
const fixture = join(root, 'scripts/azure-automation/test-current-addressbook-check.ps1')
const builder = join(root, 'scripts/azure-automation/build-current-addressbook-check.ps1')
const worker = readFileSync(join(root, 'scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1'), 'utf8')
const baseline = JSON.parse(readFileSync(join(root, 'scripts/azure-automation/exchange-publication-baseline.json'), 'utf8'))
const digest = value => createHash('sha256').update(value).digest('hex')
const quote = value => `'${value.replaceAll("'", "''")}'`

function runPowerShell(script, { timeout = 60_000, env = {} } = {}) {
  const cache = mkdtempSync(join(tmpdir(), 'fcuno-current-addressbook-test-'))
  try {
    const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      cwd: root, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', DOTNET_CLI_TELEMETRY_OPTOUT: '1', POWERSHELL_TELEMETRY_OPTOUT: '1', PSModuleAnalysisCachePath: join(cache, 'analysis'), ...env },
    })
    assert.ifError(result.error)
    assert.equal(result.signal, null, 'Synthetic comparison must finish within its bounded outer deadline')
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    return result.stdout.trim()
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
}

const guards = `
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSVersion.Minor -ne 6) { throw 'Trusted PowerShell7.6 is required' }
function global:Invoke-RestMethod { throw 'TEST GUARD: network access forbidden' }
function global:Invoke-WebRequest { throw 'TEST GUARD: network access forbidden' }
function global:Get-AutomationVariable { throw 'TEST GUARD: provider settings forbidden' }
function global:Connect-ExchangeOnline { throw 'TEST GUARD: Exchange connection forbidden' }
function global:Disconnect-ExchangeOnline { throw 'TEST GUARD: Exchange connection forbidden' }
function global:Import-Module { throw 'TEST GUARD: provider module import forbidden' }
function global:Send-MailMessage { throw 'TEST GUARD: email forbidden' }
foreach ($name in @('Set-MailContact','New-MailContact','Remove-MailContact','Set-Contact','Set-DistributionGroup','New-DistributionGroup','Remove-DistributionGroup','Update-DistributionGroupMember','Add-DistributionGroupMember','Remove-DistributionGroupMember','Set-Group','Send-ExchangeSmtpMail','Save-SyncStatus','Acquire-ExchangeSyncLock','Renew-ExchangeSyncLockIfDue','Release-ExchangeSyncLock','Commit-FullExchangeQueueCertification','Commit-OutlookTemplateRecipientReconciliation')) {
  Set-Item -Path "Function:global:$name" -Value { throw 'TEST GUARD: mutation/certification/status/lease/email forbidden' }
}
`

test('read-only work leaves the independently reviewed current mutation worker byte-for-byte unchanged', () => {
  assert.equal(digest(worker), baseline.sourceSha256)
  assert.equal(baseline.workerVersion, 'fcuno-exchange-runbook/2026-10-27.1')
})

test('raw checker imports under denied providers and runs complete adversarial synthetic workflow', t => {
  const output = runPowerShell(`${guards}\n. ${quote(fixture)} -CheckerPath ${quote(checker)}`)
  const receipt = JSON.parse(output)
  assert.equal(receipt.schema, 'fcuno.current-addressbook.synthetic-tests/v1')
  assert.equal(receipt.passed, true)
  assert.ok(receipt.caseCount >= 40, 'The actual workflow must run all positive, mismatch and unstable-read fixtures')
  assert.equal(receipt.caseCount, receipt.cases.length)
  assert.equal(new Set(receipt.cases.map(item => item.name)).size, receipt.caseCount)
  assert.ok(receipt.assertionCount > receipt.caseCount * 3)
  assert.ok(receipt.cases.every(item => item.passed === true))
  t.diagnostic(`${receipt.caseCount} offline synthetic cases; ${receipt.assertionCount} assertions; no provider requests`)
})

test('guarded real entrypoint refuses unavailable settings without leaking the raw guard error', () => {
  const output = runPowerShell(`${guards}\n& ${quote(checker)}`)
  const receipt = JSON.parse(output)
  assert.equal(receipt.status, 'INCONCLUSIVE')
  assert.equal(receipt.readOnly, true)
  assert.equal(receipt.certified, false)
  assert.equal(receipt.certificationWritten, false)
  assert.equal(receipt.observationOnly, true)
  assert.doesNotMatch(output, /TEST GUARD|provider settings forbidden|apikey|Authorization/i)
})

test('checker source has no direct Exchange mutation, certification, email, status or lease commands', () => {
  const script = readFileSync(checker, 'utf8')
  const forbidden = [
    'Set-MailContact', 'New-MailContact', 'Remove-MailContact', 'Set-Contact',
    'Set-DistributionGroup', 'New-DistributionGroup', 'Remove-DistributionGroup',
    'Update-DistributionGroupMember', 'Add-DistributionGroupMember', 'Remove-DistributionGroupMember', 'Set-Group',
    'Send-MailMessage', 'Send-ExchangeSmtpMail', 'Save-SyncStatus', 'Acquire-ExchangeSyncLock',
    'Renew-ExchangeSyncLockIfDue', 'Release-ExchangeSyncLock', 'Commit-FullExchangeQueueCertification',
    'Commit-OutlookTemplateRecipientReconciliation',
  ]
  // Match executable command tokens, not explanatory comments/string deny-lists.
  const names = JSON.parse(runPowerShell(`
    $errors=$null; $tokens=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(checker)},[ref]$tokens,[ref]$errors)
    if (@($errors).Count) { throw 'Checker parse failed' }
    $names=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst]},$true) | ForEach-Object { $_.GetCommandName() } | Where-Object { $_ } | Sort-Object -Unique)
    ConvertTo-Json -InputObject $names -Compress
  `))
  for (const command of forbidden) assert.ok(!names.some(name => name.toLowerCase() === command.toLowerCase()), `Forbidden command: ${command}`)
  assert.doesNotMatch(script, /(?:^|[\s"'])rpc\//im, 'Comparison may not call even read-looking worker RPCs')
  assert.doesNotMatch(script, /^\s*\.\s+[^\n]*sync-fcuno-outlook-addressbook/im, 'Never dot-source the whole mutation worker')
})

function miniRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'fcuno-current-addressbook-bundle-'))
  mkdirSync(join(directory, 'scripts/azure-automation'), { recursive: true })
  mkdirSync(join(directory, 'config'))
  for (const path of [
    'scripts/azure-automation/check-fcuno-outlook-addressbook.ps1',
    'scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1',
    'scripts/azure-automation/exchange-publication-baseline.json',
    'config/fcunoConnections.ts',
  ]) copyFileSync(join(root, path), join(directory, path))
  return directory
}

test('bundle assembly is offline, deterministic, source/config pinned and uses exact real helper AST bodies', () => {
  const directory = miniRepository()
  try {
    const first = join(directory, 'first.ps1'), second = join(directory, 'second.ps1')
    runPowerShell(`${guards}\n& ${quote(builder)} -RepositoryRoot ${quote(directory)} -OutputPath ${quote(first)}\n& ${quote(builder)} -RepositoryRoot ${quote(directory)} -OutputPath ${quote(second)}\n& ${quote(builder)} -RepositoryRoot ${quote(directory)} -OutputPath ${quote(first)} -Check`)
    const bundle = readFileSync(first, 'utf8')
    assert.equal(bundle, readFileSync(second, 'utf8'), 'Two builds from identical inputs must be byte-identical')
    assert.equal(bundle, readFileSync(checker, 'utf8'), 'Checked-in checker must be the current exact deterministic bundle')
    const selectedConfig = readFileSync(join(directory, 'config/fcunoConnections.ts'), 'utf8')
    assert.match(bundle, new RegExp(`CurrentCheckWorkerSourceSha256 = '${digest(worker)}'`))
    assert.match(bundle, new RegExp(`CurrentCheckConfigSha256 = '${digest(selectedConfig)}'`))
    const comparison = JSON.parse(runPowerShell(`${guards}\n. ${quote(fixture)} -CheckerPath ${quote(first)}`))
    assert.equal(comparison.passed, true, 'Generated bundle must run the same actual synthetic workflow, not a surrogate comparator')
    const sourceAndBundle = JSON.parse(runPowerShell(`
      $errors=$null;$tokens=$null
      $source=[System.Management.Automation.Language.Parser]::ParseFile(${quote(join(directory, 'scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1'))},[ref]$tokens,[ref]$errors)
      if (@($errors).Count) {throw 'Worker parser failure'}
      $bundle=[System.Management.Automation.Language.Parser]::ParseFile(${quote(first)},[ref]$tokens,[ref]$errors)
      if (@($errors).Count) {throw 'Bundle parser failure'}
      $workerFunctions=@{}; $bundleFunctions=@{}
      foreach($item in $source.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)) {$workerFunctions[$item.Name]=$item.Extent.Text}
      foreach($item in $bundle.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)) {$bundleFunctions[$item.Name]=$item.Extent.Text}
      $names=@('Build-ExchangeRows','Get-ExchangeMailContactMismatches','Get-ExchangeDistributionGroupMismatches','Resolve-ExchangeContactProfileHint','Resolve-ExchangeGroupProfileHint','Get-ExchangeGroupMembershipMismatches','Get-CanonicalExchangeProjectionJson')
      $results=@($names | ForEach-Object {@{name=$_;same=($workerFunctions.ContainsKey($_) -and $bundleFunctions.ContainsKey($_) -and $workerFunctions[$_] -ceq $bundleFunctions[$_])}})
      ConvertTo-Json -InputObject $results -Compress
    `))
    assert.equal(sourceAndBundle.length, 7)
    for (const item of sourceAndBundle) assert.equal(item.same, true, `${item.name} must retain exact selected worker semantics`)
    writeFileSync(first, `${bundle}\n# synthetic stale bundle\n`)
    const stale = runPowerShell(`
      try {& ${quote(builder)} -RepositoryRoot ${quote(directory)} -OutputPath ${quote(first)} -Check;throw 'TEST_EXPECTED_STALE_REJECTION'}
      catch {if($_.Exception.Message -cne 'Current checker bundle is stale or altered.') {throw};'stale-rejected'}
    `)
    assert.equal(stale, 'stale-rejected')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('builder rejects altered worker bytes before raw worker code can execute', () => {
  const directory = miniRepository()
  try {
    const path = join(directory, 'scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1')
    writeFileSync(path, `throw 'TEST_RAW_WORKER_MUST_NEVER_EXECUTE'\n${worker}`)
    const result = runPowerShell(`${guards}
      try {& ${quote(builder)} -RepositoryRoot ${quote(directory)} -OutputPath ${quote(join(directory, 'rejected.ps1'))};throw 'TEST_EXPECTED_HASH_REJECTION'}
      catch {if($_.Exception.Message -cne 'Worker bytes do not match the pinned publication baseline.') {throw};'worker-hash-rejected'}
    `)
    assert.equal(result, 'worker-hash-rejected')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('builder rejects contradictory canonical account/environment config rather than inheriting another target', () => {
  const directory = miniRepository()
  try {
    const path = join(directory, 'config/fcunoConnections.ts')
    const config = readFileSync(path, 'utf8')
    assert.match(config, /exchangeAddressBook:/, 'Real canonical Exchange connection pins must exist')
    writeFileSync(path, config.replace(/(exchangeAddressBook:\s*\{[\s\S]*?tenantId:\s*)"[^"]+"/, '$1"00000000-0000-4000-8000-000000000000"'))
    assert.notEqual(readFileSync(path, 'utf8'), config, 'Synthetic target mutation must actually change a pin')
    const result = runPowerShell(`${guards}
      try {& ${quote(builder)} -RepositoryRoot ${quote(directory)} -OutputPath ${quote(join(directory, 'rejected.ps1'))};throw 'TEST_EXPECTED_TARGET_REJECTION'}
      catch {if($_.Exception.Message -notmatch 'Canonical (Exchange policy|connection policy)') {throw};'target-rejected'}
    `)
    assert.equal(result, 'target-rejected')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
