param([string]$WorkerPath = (Join-Path $PSScriptRoot 'sync-fcuno-outlook-addressbook.ps1'))

$ErrorActionPreference = 'Stop'
. $WorkerPath -LibraryOnly
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "FAILED: $Message" } }
function Get-ExchangeMonotonicMilliseconds { return [double]$script:ClockMilliseconds }
function Renew-ExchangeSyncLockIfDue { $script:Renewals += 1 }
function Start-Sleep([int]$Seconds) { $script:Delays.Add($Seconds); $script:ClockMilliseconds += $Seconds * 1000 }
function Reset-Test($Scenario) {
  $script:Scenario = $Scenario; $script:ClockMilliseconds = 0; $script:Renewals = 0
  $script:Calls = [System.Collections.Generic.List[object]]::new()
  $script:Delays = [System.Collections.Generic.List[int]]::new()
}
$script:RunId = '11111111-1111-4111-8111-111111111111'
$script:Fingerprint = 'a' * 64
function New-Receipt([bool]$Complete) {
  return [pscustomobject]@{
    processed = $true; idempotent = $false; reason = 'Synthetic receipt'
    supersededCount = 0; supersededRows = @()
    runId = $script:RunId; sourceFingerprint = $script:Fingerprint
    certifiedAt = '2026-10-22T00:00:00Z'; reconciledAt = '2026-10-22T00:00:01Z'
    complete = $Complete; currentTemplates = 1; remainingTemplates = $(if ($Complete) { 0 } else { 1 })
    batch = [pscustomobject]@{ limit = 25; selected = 1; updated = 1 }
    verification = $(if ($Complete) { [pscustomobject]@{
      schema = 'fcuno.outlook-template-recipient-truth/v2'; valid = $true; sourceTruthValid = $true
      certificationRunId = $script:RunId; sourceFingerprint = $script:Fingerprint
      templates = [pscustomobject]@{ total = 1; unresolved = 0; stale = 0; invalidShape = 0; withMissingRecipients = 0; withAmbiguousRecipients = 0; sendable = 1 }
    } } else { $null })
  }
}
function Invoke-SupabaseRest($Method, $Path, $Body, $ConnectionTimeoutSeconds, $OperationTimeoutSeconds) {
  $script:Calls.Add([pscustomobject]@{ Method = $Method; Path = $Path; Body = $Body.Clone(); Connection = $ConnectionTimeoutSeconds; Operation = $OperationTimeoutSeconds })
  switch ($script:Scenario) {
    'slow-batches' { $script:ClockMilliseconds += 400000; if ($script:Calls.Count -gt 2) { throw 'Unexpected work after total budget' }; return New-Receipt $false }
    'late-rejection' { $script:ClockMilliseconds += 599500; throw 'Synthetic ambiguous response' }
    'late-success' { $script:ClockMilliseconds += 601000; return New-Receipt $true }
    'retry-success' { $script:ClockMilliseconds += 100; if ($script:Calls.Count -eq 1) { throw 'Synthetic lost response' }; return New-Receipt $true }
    'clamped-last-request' { if ($script:Calls.Count -eq 1) { $script:ClockMilliseconds += 590000; return New-Receipt $false }; $script:ClockMilliseconds += 100; return New-Receipt $true }
    default { throw 'Unexpected scenario' }
  }
}
function Run-Reconciliation {
  $result = $null; $failure = $null
  try { $result = Commit-OutlookTemplateRecipientReconciliation @{ runId = $script:RunId } $script:Fingerprint } catch { $failure = $_ }
  return [pscustomobject]@{ Result = $result; Failure = $failure }
}
foreach ($scenario in @('slow-batches', 'late-rejection', 'late-success')) {
  Reset-Test $scenario
  $observed = Run-Reconciliation
  Assert-True ($null -eq $observed.Result -and $null -ne $observed.Failure) 'Exceeded budget must never report reconciliation success'
  Assert-True ($observed.Failure.Exception.Message -like 'OUTLOOK_TEMPLATE_RECONCILIATION_BUDGET_EXHAUSTED:*') 'A monotonic total budget must stop new requests/retries rather than running100 slow batches'
  Assert-True ($script:Calls.Count -eq $(if ($scenario -eq 'slow-batches') { 2 } else { 1 })) 'No retry or next batch may begin after the shared budget is exhausted'
  Assert-True ($script:Delays.Count -eq 0) 'The retry delay must not outlive the remaining budget'
}
Reset-Test 'retry-success'
$observed = Run-Reconciliation
Assert-True ($null -eq $observed.Failure -and $observed.Result.reconciled) 'An ordinary ambiguous response must still recover within the budget'
Assert-True ($script:Calls.Count -eq 2 -and ($script:Delays -join ',') -eq '2') 'The existing bounded idempotent retry must remain unchanged'
foreach ($call in $script:Calls) {
  Assert-True ($call.Method -eq 'POST' -and $call.Path -eq 'rpc/reconcile_outlook_templates_with_certification_batch') 'Only the exact existing derived-state RPC may run'
  Assert-True ($call.Body.p_run_id -eq $script:RunId -and $call.Body.p_source_fingerprint -ceq $script:Fingerprint -and $call.Body.p_batch_limit -eq 25) 'Retries must retain the exact certification, fingerprint and batch limit'
  Assert-True ($call.Connection -ge 1 -and $call.Connection -le 60 -and $call.Operation -ge 1 -and $call.Operation -le 60) 'Derived calls must have finite timeout limits within the remaining budget'
}
Reset-Test 'clamped-last-request'
$observed = Run-Reconciliation
Assert-True ($null -eq $observed.Failure -and $observed.Result.reconciled) 'A final bounded request may finish within the remaining budget'
Assert-True ($script:Calls.Count -eq 2 -and $script:Calls[1].Connection -eq 10 -and $script:Calls[1].Operation -eq 10) 'Connection and idle-read limits must shrink to the actual remaining10seconds'
Write-Output 'PASS: Derived reconciliation shares one monotonic10minute budget across batches, retries and backoff; late success is not acknowledged and exact idempotent retries remain intact.'
