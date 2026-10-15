param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "sync-fcuno-outlook-addressbook.ps1") -LibraryOnly

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "FAILED: $Message" }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
  if ([string]$Expected -cne [string]$Actual) {
    throw "FAILED: $Message. Expected '$Expected'; got '$Actual'."
  }
}

function New-TestError([string]$Message, [switch]$Timeout) {
  $exception = if ($Timeout) {
    [System.TimeoutException]::new($Message)
  } else {
    [System.InvalidOperationException]::new($Message)
  }
  return [System.Management.Automation.ErrorRecord]::new(
    $exception,
    "MockExchangeConnectionError",
    [System.Management.Automation.ErrorCategory]::ConnectionError,
    $null
  )
}

$script:FormationMessage = "Module could not be correctly formed. Please run Connect-ExchangeOnline again."
$script:TemporaryMessage = "A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support."
$script:TestCredentials = @{
  AppId = "11111111-1111-4111-8111-111111111111"
  CertificateFilePath = "/not-a-real-certificate/exchange-test.pfx"
  CertificatePassword = (ConvertTo-SecureString "test-only-not-a-real-password" -AsPlainText -Force)
  Organization = "unit-test.invalid"
}

function Reset-TestConnection($Outcomes, [bool]$CleanupThrows = $false) {
  $script:MockOutcomes = @($Outcomes)
  $script:MockConnectCalls = [System.Collections.Generic.List[object]]::new()
  $script:MockDisconnectCalls = [System.Collections.Generic.List[object]]::new()
  $script:MockSleeps = [System.Collections.Generic.List[int]]::new()
  $script:MockEvents = [System.Collections.Generic.List[string]]::new()
  $script:MockCleanupThrows = $CleanupThrows
  $script:ExchangeOnlineConnected = $false
}

# Mock the actual cmdlet boundaries, not the retry or cleanup implementation.
# No Exchange module, certificate, Azure account, or network connection is used.
function Connect-ExchangeOnline {
  [CmdletBinding()]
  param($AppId, $CertificateFilePath, [securestring]$CertificatePassword, $Organization, [bool]$ShowBanner)
  $script:MockEvents.Add("connect")
  $script:MockConnectCalls.Add([pscustomobject]@{
    AppId = $AppId
    CertificateFilePath = $CertificateFilePath
    CertificatePassword = $CertificatePassword
    Organization = $Organization
    ShowBanner = $ShowBanner
    ErrorAction = $PSBoundParameters["ErrorAction"]
    ConnectedBefore = $script:ExchangeOnlineConnected
  })
  $index = $script:MockConnectCalls.Count - 1
  if ($index -ge $script:MockOutcomes.Count) {
    throw "TEST GUARD: unexpected extra connection attempt"
  }
  # Failed initialization can emit objects before its terminating exception.
  # Neither this output nor successful connection objects belong in sync data.
  Write-Output "discard this Connect-ExchangeOnline output"
  $outcome = $script:MockOutcomes[$index]
  if ($outcome -is [System.Management.Automation.ErrorRecord]) {
    $PSCmdlet.ThrowTerminatingError($outcome)
  }
  Assert-Equal "success" $outcome "The mock outcome must be explicitly configured"
}

function Disconnect-ExchangeOnline {
  [CmdletBinding()]
  param([switch]$Confirm)
  $script:MockEvents.Add("disconnect")
  $script:MockDisconnectCalls.Add([pscustomobject]@{
    Confirm = [bool]$Confirm
    ErrorAction = $PSBoundParameters["ErrorAction"]
    ConnectedBefore = $script:ExchangeOnlineConnected
  })
  Write-Output "discard this Disconnect-ExchangeOnline output"
  if ($script:MockCleanupThrows) { throw "Mock partial-session cleanup failed" }
}

function Start-Sleep {
  param([int]$Seconds)
  $script:MockEvents.Add("sleep:$Seconds")
  $script:MockSleeps.Add($Seconds)
}

# Fail closed if connection handling unexpectedly begins queue work, sends an
# alert, or performs a network request. Library-only loading must remain local.
function Invoke-RestMethod { throw "TEST GUARD: unexpected network request" }
function Invoke-WebRequest { throw "TEST GUARD: unexpected network request" }
function Invoke-SupabaseRest { throw "TEST GUARD: unexpected database access" }
function Renew-ExchangeSyncLockIfDue { throw "TEST GUARD: unexpected lock renewal during connection setup" }
function Invoke-ExchangeIncrementalQueue { throw "TEST GUARD: unexpected queue processing during connection setup" }

function Invoke-TestConnection([hashtable]$Options = @{}) {
  $caught = $null
  $output = @()
  try {
    $output = @(Connect-ExchangeOnlineWithRetry @script:TestCredentials @Options 3> $null)
  } catch {
    $caught = $_
  }
  return [pscustomobject]@{ Error = $caught; Output = $output }
}

function Assert-TestCalls([int]$Connects, [int]$Disconnects, [string]$Delays) {
  Assert-Equal $Connects $script:MockConnectCalls.Count "Connection attempt count"
  Assert-Equal $Disconnects $script:MockDisconnectCalls.Count "Partial sessions must be cleaned after each failed attempt"
  Assert-Equal $Delays ($script:MockSleeps -join ",") "Retry delays must be bounded and apply only between attempts"
  foreach ($call in $script:MockConnectCalls) {
    Assert-Equal $script:TestCredentials.AppId $call.AppId "Retries must retain the original application ID"
    Assert-Equal $script:TestCredentials.CertificateFilePath $call.CertificateFilePath "Retries must retain the original certificate path"
    Assert-Equal $script:TestCredentials.Organization $call.Organization "Retries must retain the original tenant"
    Assert-True ([object]::ReferenceEquals($script:TestCredentials.CertificatePassword, $call.CertificatePassword)) "Retries must pass the same secure password without conversion"
    Assert-Equal "Stop" $call.ErrorAction "Connection errors must terminate the attempt"
    Assert-True (-not $call.ShowBanner) "Connection banners must remain disabled"
    Assert-True (-not $call.ConnectedBefore) "A failed or not-yet-completed attempt must never be flagged connected"
  }
  foreach ($call in $script:MockDisconnectCalls) {
    Assert-True (-not $call.Confirm) "Cleanup must never ask for an interactive confirmation"
    Assert-Equal "Stop" $call.ErrorAction "Cleanup errors must be caught locally"
  }
}

$formationError = New-TestError $script:FormationMessage
Assert-True (Test-ExchangeConnectionRetryableError $formationError) "The exact observed module-initialization failure must be retryable"
Assert-True (Test-ExchangeConnectionRetryableError (New-TestError $script:TemporaryMessage)) "Known temporary Exchange server failures must remain retryable"
Assert-True (Test-ExchangeConnectionRetryableError (New-TestError "Network request timed out" -Timeout)) "Typed timeouts must remain retryable"
Assert-True (-not (Test-ExchangeConnectionRetryableError $null)) "An absent error must not be classified as transient"
foreach ($message in @(
  "AADSTS7000215: Invalid client secret provided.",
  "The certificate is expired.",
  "Access is denied.",
  "Missing Automation variable: EXCHANGE_APP_ID",
  "A contact failed permanent validation.",
  "Some other module could not be correctly formed.",
  "Please run Connect-ExchangeOnline again.",
  "An unrelated outer error contains: $($script:FormationMessage)",
  "$($script:FormationMessage) The certificate is invalid."
)) {
  Assert-True (-not (Test-ExchangeConnectionRetryableError (New-TestError $message))) "Unrecognised/auth/configuration error must not retry: $message"
}

Reset-TestConnection @("success")
$result = Invoke-TestConnection
Assert-True ($null -eq $result.Error) "A successful first connection must complete"
Assert-Equal 0 $result.Output.Count "Connection cmdlet objects must not leak into caller output"
Assert-True $script:ExchangeOnlineConnected "A successful connection must set the connected flag"
Assert-TestCalls 1 0 ""

Reset-TestConnection @($formationError, "success")
$result = Invoke-TestConnection
Assert-True ($null -eq $result.Error) "A temporary module failure must recover in the same run"
Assert-Equal 0 $result.Output.Count "Recovered attempts must not leak partial connection or cleanup output"
Assert-True $script:ExchangeOnlineConnected "Successful retry must mark the connection ready"
Assert-TestCalls 2 1 "5"
Assert-Equal "connect,disconnect,sleep:5,connect" ($script:MockEvents -join ",") "Partial connection cleanup must happen before waiting and reconnecting"

Reset-TestConnection @($formationError, (New-TestError "Timed out" -Timeout), "success")
$result = Invoke-TestConnection
Assert-True ($null -eq $result.Error) "The last permitted attempt must still be allowed to recover"
Assert-True $script:ExchangeOnlineConnected "Third-attempt recovery must set the connected flag"
Assert-TestCalls 3 2 "5,10"

$lastFormationError = New-TestError $script:FormationMessage
Reset-TestConnection @($formationError, $formationError, $lastFormationError)
$result = Invoke-TestConnection
Assert-True ($null -ne $result.Error) "Exhausted transient failures must reach existing failure handling"
Assert-Equal $script:FormationMessage $result.Error.Exception.Message "Exhaustion must preserve the real Exchange error"
Assert-True ([object]::ReferenceEquals($lastFormationError.Exception, $result.Error.Exception)) "Exhaustion must retain the original exception object"
Assert-True (-not $script:ExchangeOnlineConnected) "Exhaustion must leave the connection flag false"
Assert-TestCalls 3 3 "5,10"

$authError = New-TestError "AADSTS7000215: Invalid client secret provided."
Reset-TestConnection @($authError, "success")
$result = Invoke-TestConnection
Assert-Equal $authError.Exception.Message $result.Error.Exception.Message "Authentication failure must be reported unchanged"
Assert-True (-not $script:ExchangeOnlineConnected) "Permanent failure must not mark the connection ready"
Assert-TestCalls 1 1 ""

Reset-TestConnection @($formationError, $authError, "success")
$result = Invoke-TestConnection
Assert-Equal $authError.Exception.Message $result.Error.Exception.Message "A permanent second-attempt failure must stop retries immediately"
Assert-TestCalls 2 2 "5"

Reset-TestConnection @($formationError, "success") $true
$result = Invoke-TestConnection
Assert-True ($null -eq $result.Error) "Best-effort cleanup failure must not prevent a transient retry"
Assert-True $script:ExchangeOnlineConnected "Recovery after cleanup failure must retain the successful connected flag"
Assert-TestCalls 2 1 "5"

Reset-TestConnection @($authError) $true
$result = Invoke-TestConnection
Assert-Equal $authError.Exception.Message $result.Error.Exception.Message "Cleanup failure must never replace the original authentication exception"
Assert-True (-not $script:ExchangeOnlineConnected) "Failed cleanup must still clear the connected flag"
Assert-TestCalls 1 1 ""

Reset-TestConnection @("success")
$script:ExchangeOnlineConnected = $true
$cleanupOutput = @(Disconnect-ExchangeOnlineSafely 3> $null)
Assert-Equal 0 $cleanupOutput.Count "Normal cleanup must discard disconnect output"
Assert-True (-not $script:ExchangeOnlineConnected) "Normal final cleanup must clear the connected flag"
Assert-Equal 1 $script:MockDisconnectCalls.Count "Normal final cleanup must disconnect exactly once"

Reset-TestConnection @("success") $true
$script:ExchangeOnlineConnected = $true
Disconnect-ExchangeOnlineSafely 3> $null
Assert-True (-not $script:ExchangeOnlineConnected) "Throwing final cleanup must still clear the connected flag"

Reset-TestConnection @($formationError, "success")
$result = Invoke-TestConnection @{ MaxAttempts = 1 }
Assert-Equal $script:FormationMessage $result.Error.Exception.Message "One requested attempt must not silently consume extra attempts"
Assert-TestCalls 1 1 ""

Reset-TestConnection @($formationError, "success")
$result = Invoke-TestConnection @{ MaxAttempts = 2; RetryDelaySeconds = 0 }
Assert-True ($null -eq $result.Error) "Zero-delay tests must still retry safely"
Assert-TestCalls 2 1 ""

Reset-TestConnection @($formationError, $formationError, "success")
$result = Invoke-TestConnection @{ MaxAttempts = 3; RetryDelaySeconds = 30 }
Assert-True ($null -eq $result.Error) "The maximum accepted delay must support recovery"
Assert-TestCalls 3 2 "30,60"

foreach ($options in @(
  @{ MaxAttempts = 0 },
  @{ MaxAttempts = -1 },
  @{ MaxAttempts = 4 },
  @{ RetryDelaySeconds = -1 },
  @{ RetryDelaySeconds = 31 }
)) {
  Reset-TestConnection @("success")
  $result = Invoke-TestConnection $options
  Assert-True ($null -ne $result.Error) "Invalid retry limits must fail before attempting any connection"
  Assert-TestCalls 0 0 ""
}

Write-Output "PASS: Exchange connection retry classifier, recovery, bounded attempts, credentials, cleanup, output isolation, and permanent failures."
