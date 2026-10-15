param()

$ErrorActionPreference = "Stop"
# The fixture constructs the real HTTP exception without calling a web cmdlet.
# Load its owning module explicitly while keeping the network guards in place.
Import-Module Microsoft.PowerShell.Utility -NoClobber -ErrorAction Stop
. (Join-Path $PSScriptRoot "sync-fcuno-outlook-addressbook.ps1") -LibraryOnly

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "FAILED: $Message" }
}

function Reset-StartupTest($Outcomes) {
  $script:Outcomes = @($Outcomes)
  $script:Calls = [System.Collections.Generic.List[object]]::new()
  $script:Delays = [System.Collections.Generic.List[int]]::new()
  $script:CurrentQueueRunId = "11111111-1111-4111-8111-111111111111"
  $script:SyncLockLastRenewedAt = [DateTimeOffset]::MinValue
}

function Invoke-SupabaseRest($Method, $Path, $Body) {
  $script:Calls.Add([pscustomobject]@{ Method = $Method; Path = $Path; Body = $Body.Clone() })
  $index = $script:Calls.Count - 1
  if ($index -ge $script:Outcomes.Count) { throw "Unexpected retry" }
  $outcome = $script:Outcomes[$index]
  if ($outcome -is [Exception]) { throw $outcome }
  return $outcome
}
function Start-Sleep([int]$Seconds) { $script:Delays.Add($Seconds) }
function Invoke-RestMethod { throw "Unexpected network access" }
function Connect-ExchangeOnline { throw "Unexpected Exchange connection" }

function New-HttpFailure([int]$Status) {
  $response = [System.Net.Http.HttpResponseMessage]::new([Enum]::ToObject([System.Net.HttpStatusCode], $Status))
  return [Microsoft.PowerShell.Commands.HttpResponseException]::new("HTTP $Status", $response)
}

function Run-Acquisition {
  $result = $null
  $errorRecord = $null
  try { $result = Acquire-ExchangeSyncLock "full" 3> $null } catch { $errorRecord = $_ }
  return [pscustomobject]@{ Result = $result; Error = $errorRecord }
}

foreach ($status in @(408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524)) {
  Reset-StartupTest @((New-HttpFailure $status), $true)
  $result = Run-Acquisition
  Assert-True ($null -eq $result.Error -and $result.Result -eq $true) "HTTP $status must recover"
  Assert-True ($script:Calls.Count -eq 2 -and ($script:Delays -join ',') -eq '5') "Retry must be bounded"
  foreach ($call in $script:Calls) {
    Assert-True ($call.Method -eq 'POST' -and $call.Path -eq 'rpc/acquire_outlook_exchange_sync_lock') "Only the idempotent lock RPC may replay"
    Assert-True ($call.Body.p_run_id -eq $script:CurrentQueueRunId -and $call.Body.p_sync_mode -eq 'full' -and $call.Body.p_lease_minutes -eq 180) "Retries must retain exact owner, mode and lease"
  }
}

foreach ($failure in @([TimeoutException]::new('timeout'), [System.Threading.Tasks.TaskCanceledException]::new('timeout'))) {
  Reset-StartupTest @($failure, $true)
  $result = Run-Acquisition
  Assert-True ($null -eq $result.Error -and $result.Result -eq $true -and $script:Calls.Count -eq 2) "Transport timeout must recover"
}

Reset-StartupTest @((New-HttpFailure 522), (New-HttpFailure 522), (New-HttpFailure 522))
$result = Run-Acquisition
Assert-True ($null -ne $result.Error -and $script:Calls.Count -eq 3 -and ($script:Delays -join ',') -eq '5,10') "Exhaustion must preserve the real failure"
Assert-True ($script:SyncLockLastRenewedAt -eq [DateTimeOffset]::MinValue) "Unconfirmed acquisition must not mark the lock as held"

foreach ($status in @(400, 401, 403, 404, 409, 422)) {
  Reset-StartupTest @((New-HttpFailure $status))
  $result = Run-Acquisition
  Assert-True ($null -ne $result.Error -and $script:Calls.Count -eq 1 -and $script:Delays.Count -eq 0) "HTTP $status must fail without retry"
}

foreach ($outcome in @($false, 'true', 'false', $null, [InvalidOperationException]::new('bad configuration'))) {
  Reset-StartupTest @($outcome)
  $result = Run-Acquisition
  Assert-True ($script:Calls.Count -eq 1 -and $script:Delays.Count -eq 0) "Denied, malformed and permanent failures must not retry"
  if ($outcome -is [bool]) {
    Assert-True ($null -eq $result.Error -and $result.Result -eq $false) "An occupied lock must remain denied"
  } else {
    Assert-True ($null -ne $result.Error) "Malformed results must fail closed"
  }
}

Reset-StartupTest @((New-HttpFailure 522), $false)
$result = Run-Acquisition
Assert-True ($null -eq $result.Error -and $result.Result -eq $false -and $script:Calls.Count -eq 2) "Another owner winning during retry must remain denied"
Assert-True ($script:SyncLockLastRenewedAt -eq [DateTimeOffset]::MinValue) "A competing owner must not mark this run acquired"

Write-Output "PASS: Exchange startup retries only temporary failures of the exact idempotent lock RPC; permanent errors, occupied locks and malformed confirmations fail closed."
