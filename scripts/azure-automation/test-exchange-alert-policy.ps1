param()

$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Utility -NoClobber -ErrorAction Stop
. (Join-Path $PSScriptRoot "sync-fcuno-outlook-addressbook.ps1") -LibraryOnly

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "FAILED: $Message" }
}
function Assert-Equal($Expected, $Actual, [string]$Message) {
  if ([string]$Expected -cne [string]$Actual) {
    throw "FAILED: $Message. Expected '$Expected'; got '$Actual'."
  }
}

# All external boundaries are mocked. These tests cannot contact Exchange,
# send email, or change a database.
function Invoke-RestMethod { throw "TEST GUARD: unexpected network request" }
function Invoke-WebRequest { throw "TEST GUARD: unexpected network request" }
function Get-AutomationVariable {
  [CmdletBinding()]
  param([string]$Name)
  if ($Name -eq "EXCHANGE_SYNC_NOTIFY_EMAILS") { return "team@example.com" }
  return $null
}
function Start-Sleep { param([int]$Seconds) [void]$script:Sleeps.Add($Seconds) }

function Reset-TestPolicy {
  $script:ExchangeNotificationRunReceipts = @{}
  $script:CurrentQueueRunId = [guid]::NewGuid().ToString()
  $script:CurrentSyncMode = "incremental"
  $script:ObserveMode = "quiet"
  $script:CompleteMode = "success"
  $script:ThrowSmtp = $false
  $script:RpcCalls = New-Object System.Collections.ArrayList
  $script:SentMail = New-Object System.Collections.ArrayList
  $script:Sleeps = New-Object System.Collections.ArrayList
  $script:ClaimId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  $script:DeliveredIncidentKeys = @{}
  $script:ClaimedIncidentKeys = @()
}
function Send-ExchangeSmtpMail($From, $To, $Subject, $Html) {
  [void]$script:SentMail.Add([pscustomobject]@{ From = $From; To = @($To); Subject = $Subject; Html = $Html })
  if ($script:ThrowSmtp) { throw "Mock SMTP delivery failed." }
  return $true
}
function Invoke-SupabaseRest($Method, $Path, $Body) {
  [void]$script:RpcCalls.Add([pscustomobject]@{ Method = $Method; Path = $Path; Body = $Body })
  Assert-Equal "POST" $Method "Policy must use only the two internal notification RPCs"
  if ($Path -eq "rpc/observe_outlook_exchange_alert") {
    if (@($Body.p_incidents).Count -gt 1000) { throw "TEST GUARD: history payload exceeds the RPC incident limit" }
    switch ($script:ObserveMode) {
      "throw" { throw "Mock history unavailable." }
      "null" { return $null }
      "not_boolean" { return @{ shouldNotify = "false" } }
      "bad_claim" { return @{ shouldNotify = $true; claimId = "not-a-guid"; incidentKeys = @($Body.p_incidents | ForEach-Object { $_.key }) } }
      "unknown_key" { return @{ shouldNotify = $true; claimId = $script:ClaimId; incidentKeys = @("f" * 64) } }
      "empty_keys" { return @{ shouldNotify = $true; claimId = $script:ClaimId; incidentKeys = @() } }
      "duplicate_keys" { return @{ shouldNotify = $true; claimId = $script:ClaimId; incidentKeys = @($Body.p_incidents[0].key, $Body.p_incidents[0].key) } }
      "history" {
        # Model only the delivery boundary here. Native SQL fixtures separately
        # prove leases/persistence/recovery; this verifies the real worker does
        # not invent a new key when an existing operation reaches outer catch.
        $keys = @($Body.p_incidents | Where-Object { -not $script:DeliveredIncidentKeys.ContainsKey($_.key) } | ForEach-Object { $_.key })
        $script:ClaimedIncidentKeys = $keys
        return @{ shouldNotify = $keys.Count -gt 0; claimId = $(if ($keys.Count) { $script:ClaimId } else { $null }); incidentKeys = $keys; reason = $(if ($keys.Count) { "notification_claimed" } else { "already_notified" }) }
      }
      "eligible" {
        return @{
          shouldNotify = $true
          claimId = $script:ClaimId
          incidentKeys = @($Body.p_incidents | ForEach-Object { $_.key })
          reason = "notification_claimed"
        }
      }
      default {
        return @{
          shouldNotify = $false
          claimId = $null
          incidentKeys = @()
          reason = $(if ($Body.p_recovery_proven) { "recovered" } else { "waiting_for_persistence" })
        }
      }
    }
  }
  if ($Path -eq "rpc/complete_outlook_exchange_alert") {
    if ($script:CompleteMode -eq "throw") { throw "Mock completion unavailable." }
    if ($script:CompleteMode -eq "reject") { return @{ accepted = $false; delivered = $Body.p_delivered } }
    if ($script:CompleteMode -eq "accepted_string") { return @{ accepted = "true"; delivered = $Body.p_delivered } }
    if ($script:CompleteMode -eq "delivered_string") { return @{ accepted = $true; delivered = "true" } }
    if ($script:CompleteMode -eq "delivery_mismatch") { return @{ accepted = $true; delivered = (-not $Body.p_delivered) } }
    if ($script:ObserveMode -eq "history" -and $Body.p_delivered) {
      foreach ($key in $script:ClaimedIncidentKeys) { $script:DeliveredIncidentKeys[$key] = $true }
    }
    return @{ accepted = $true; delivered = [bool]$Body.p_delivered }
  }
  throw "TEST GUARD: unexpected database operation $Path"
}
function Get-Calls([string]$Kind) {
  return @($script:RpcCalls | Where-Object { $_.Path -eq "rpc/$Kind" })
}
function New-PolicyDetails([string]$Scope = "incremental") {
  return @{
    syncMode = $Scope
    failedQueueRows = 0
    backlogRows = 0
    terminalBacklogRows = 0
    changeDetails = @()
  }
}
function New-ContactFailure([string]$Name, [string]$QueueId, [bool]$Terminal = $false) {
  return @{
    status = "failed"
    queueStatus = "failed"
    entityType = "contact"
    displayName = $Name
    queueRowId = $QueueId
    terminal = $Terminal
    retryable = -not $Terminal
    attempt = 1
    result = "PRIVATE_TECHNICAL_DETAIL"
  }
}
$webhook = @{ requestedBy = "PRIVATE_REQUESTOR"; requestedByEmail = "requester@example.com"; requestedAt = "2026-10-07T03:31:00Z" }
$temporaryMessage = "Module could not be correctly formed. Please run Connect-ExchangeOnline again."
$queueId = "11111111-1111-4111-8111-111111111111"

Reset-TestPolicy
$tempDetails = New-PolicyDetails
$tempDetails.failureStage = "connection"
$incidents = @(Get-ExchangeAlertIncidents "failed" $temporaryMessage $tempDetails "incremental")
Assert-Equal 1 $incidents.Count "Temporary connection failure must create one stable service incident"
Assert-Equal "sync_delayed" $incidents[0].kind "Temporary connection failure must be classified as a delay"
Assert-True (-not $incidents[0].immediate) "A first temporary hourly failure must wait for persistence"
$receipt = Invoke-ExchangeSyncNotificationPolicy "failed" $temporaryMessage $tempDetails $webhook
Assert-Equal "not_required" $receipt.Status "An observation waiting for persistence must remain silent"
Assert-Equal 0 $script:SentMail.Count "The first temporary observation must not email the team"
Assert-Equal 1 @(Get-Calls "observe_outlook_exchange_alert").Count "Even a silent temporary failure must be durably observed"
Assert-Equal 0 @(Get-Calls "complete_outlook_exchange_alert").Count "No delivery claim must be acknowledged when none was given"
$observed = @(Get-Calls "observe_outlook_exchange_alert")[0].Body
Assert-True (-not $observed.p_recovery_proven) "A failed connection must not clear previous incidents"
Assert-True ($observed.p_observation_complete -is [bool] -and -not $observed.p_observation_complete) "A partial connection failure must not resolve unseen older incidents"
Assert-True (-not $observed.p_incidents[0].immediate) "The persistence decision must be supplied to the history RPC"
Assert-Equal "immediate,key,kind" (($observed.p_incidents[0].Keys | Sort-Object) -join ",") "Only kind, key and urgency may go to the history store"

# Once the persisted policy declares an incident eligible, exactly one email and
# one acknowledgement are produced; a second same-run call returns the receipt.
Reset-TestPolicy
$script:ObserveMode = "eligible"
$delayedDetails = New-PolicyDetails
$delayedDetails.failureStage = "connection"
$delivered = Invoke-ExchangeSyncNotificationPolicy "failed" $temporaryMessage $delayedDetails $webhook
Assert-Equal "delivered" $delivered.Status "An eligible persistent incident must reach the SMTP boundary"
Assert-Equal 1 $script:SentMail.Count "One claimed incident batch must send one email"
Assert-True ($script:SentMail[0].Subject -match "updates delayed") "A persistent connection delay must have a calm subject"
Assert-True ($script:SentMail[0].Html -match "updates are taking longer") "A persistent delay must use simple language"
Assert-True ($script:SentMail[0].Html -notmatch "Connect-ExchangeOnline|PRIVATE_REQUESTOR|checkpoint|<table") "Technical plumbing must not leak into policy-generated content"
Assert-Equal 1 @(Get-Calls "complete_outlook_exchange_alert").Count "Successful delivery must be acknowledged exactly once"
Assert-True (@(Get-Calls "complete_outlook_exchange_alert")[0].Body.p_delivered -eq $true) "The acknowledgement must truthfully record delivery"
Assert-True $delayedDetails.notificationHistorySaved "Accepted delivery acknowledgement must be recorded"
$again = Invoke-ExchangeSyncNotificationPolicy "failed" "Another technical rendering of the same outcome" $delayedDetails $webhook
Assert-True ([object]::ReferenceEquals($delivered, $again)) "Duplicate same-run calls must return the original receipt"
Assert-Equal 1 $script:SentMail.Count "Duplicate same-run calls must never resend"
Assert-Equal 2 $script:RpcCalls.Count "Duplicate same-run calls must never reacquire a claim"

# Healthy observations rearm the durable incident history but never generate
# routine successful-change or recovery emails.
foreach ($scope in @("incremental", "full")) {
  foreach ($mutated in @($false, $true)) {
    Reset-TestPolicy
    $healthy = New-PolicyDetails $scope
    $healthy.truthLedgerCheckpointVerified = $true
    $healthy.fullCertificationCommitted = $true
    $healthy.templateRecipientTruthReconciled = $true
    if ($mutated) {
      $healthy.completedQueueRows = 2
      $healthy.createdContacts = 1
      $healthy.updatedGroups = 1
      $healthy.changeDetails = @(
        @{ status = "completed"; entityType = "contact"; displayName = "Updated contact"; queueRowId = $queueId }
        @{ status = "superseded"; queueStatus = "skipped"; entityType = "group"; displayName = "Resolved group"; supersededByQueueRowId = $queueId }
      )
    }
    $healthyReceipt = Invoke-ExchangeSyncNotificationPolicy "completed" "Internal success details" $healthy $webhook
    Assert-Equal "not_required" $healthyReceipt.Status "Healthy $scope runs must remain silent, including mutations=$mutated"
    Assert-Equal 0 $script:SentMail.Count "Successful $scope runs must not create team emails"
    $healthyObservation = @(Get-Calls "observe_outlook_exchange_alert")[0].Body
    Assert-Equal $scope $healthyObservation.p_scope "Recovery history must remain scoped to its sync type"
    Assert-True $healthyObservation.p_recovery_proven "Verified $scope completion must rearm incident history"
    Assert-True ($healthyObservation.p_observation_complete -is [bool] -and $healthyObservation.p_observation_complete) "A verified finalized $scope run must be a complete incident observation"
    Assert-Equal 0 @($healthyObservation.p_incidents).Count "Completed and resolved changes must not become incidents"
  }
}
Reset-TestPolicy
$unverified = New-PolicyDetails "full"
$unverified.truthLedgerCheckpointVerified = $true
$unverified.fullCertificationCommitted = $true
$unverified.templateRecipientTruthReconciled = $false
Invoke-ExchangeSyncNotificationPolicy "completed" "" $unverified $webhook | Out-Null
Assert-True (-not @(Get-Calls "observe_outlook_exchange_alert")[0].Body.p_recovery_proven) "Incomplete full certification must never rearm prior incident history"
Assert-True (-not @(Get-Calls "observe_outlook_exchange_alert")[0].Body.p_observation_complete) "A completed full run without final certification must not resolve older unseen incidents"

# A successful full pass may retain skipped group-shadow placeholders and
# earlier failures for audit. Neither should become a fresh team alert.
Reset-TestPolicy
$placeholderDetails = New-PolicyDetails "full"
$placeholderDetails.truthLedgerCheckpointVerified = $true
$placeholderDetails.fullCertificationCommitted = $true
$placeholderDetails.templateRecipientTruthReconciled = $true
$placeholderDetails.skippedInvalidContacts = 20
$placeholderDetails.changeDetails = @(
  @{ status = "skipped"; queueStatus = "skipped"; entityType = "contact"; displayName = "Group shadow placeholder" }
  (New-ContactFailure "Repaired earlier in the same job" $queueId $true)
)
Assert-Equal 0 @(Get-ExchangeAlertIncidents "completed" "Verified final result" $placeholderDetails "full").Count "Verified final zero-backlog results must supersede historical failure details"
$placeholderReceipt = Invoke-ExchangeSyncNotificationPolicy "completed" "Verified final result" $placeholderDetails $webhook
Assert-Equal "not_required" $placeholderReceipt.Status "Resolved history and expected placeholders must stay silent"
Assert-Equal 0 $script:SentMail.Count "Expected full-sync placeholders must not generate false alarms"
$skippedOnly = New-PolicyDetails "full"
$skippedOnly.changeDetails = @(@{ status = "skipped"; queueStatus = "skipped"; entityType = "contact"; displayName = "Expected placeholder" })
Assert-Equal 0 @(Get-ExchangeAlertIncidents "completed" "" $skippedOnly "full").Count "A skipped detail is not a failure unless its actual queue status remains unresolved"

Reset-TestPolicy
$script:ObserveMode = "eligible"
$terminalDetails = New-PolicyDetails
$terminalDetails.failedQueueRows = 1
$terminalDetails.backlogRows = 1
$terminalDetails.terminalBacklogRows = 1
$terminalDetails.truthLedgerHeadHash = "a" * 64
$terminalDetails.truthLedgerCheckpointVerified = $true
$terminalDetails.changeDetails = @(
  (New-ContactFailure 'Needs <correction> & review' $queueId $true)
  @{ status = "completed"; queueStatus = "completed"; entityType = "contact"; displayName = "Do not show successful contact"; queueRowId = "22222222-2222-4222-8222-222222222222" }
)
$terminal = @(Get-ExchangeAlertIncidents "failed" "PRIVATE_TECHNICAL_DETAIL" $terminalDetails "incremental")
Assert-Equal 1 $terminal.Count "Only the actual unresolved contact must be an incident"
Assert-Equal "sync_issue" $terminal[0].kind "Retry exhaustion alone must not accuse the contact details of being incorrect"
Assert-True $terminal[0].immediate "A terminal contact error must not be delayed as a transient issue"
$terminalReceipt = Invoke-ExchangeSyncNotificationPolicy "failed" "PRIVATE_TECHNICAL_DETAIL" $terminalDetails $webhook
Assert-Equal "delivered" $terminalReceipt.Status "An eligible terminal contact issue must be sent"
Assert-True ($script:SentMail[0].Html -match "Needs &lt;correction&gt; &amp; review") "Only actual affected names should be escaped into the email"
Assert-True ($script:SentMail[0].Html -notmatch "Do not show successful|PRIVATE_TECHNICAL_DETAIL|11111111|aaaaaaaaaaaaaaaa") "Email content must exclude successful entries, raw errors, identifiers and hashes"
Assert-True ($script:SentMail[0].Html -match "Please ask your FC Uno administrator to check the sync") "A terminal email must give a neutral next step without assuming contact data is wrong"
Assert-Equal 1 $terminalDetails.failedQueueRows "Notification handling must not relabel failed queue rows as successful"
Assert-Equal "PRIVATE_TECHNICAL_DETAIL" $terminalDetails.changeDetails[0].result "Internal technical diagnostics must remain intact"
Assert-True (@(Get-Calls "observe_outlook_exchange_alert")[0].Body.p_incidents[0].immediate) "Terminal urgency must reach the history policy"
Assert-True (@(Get-Calls "observe_outlook_exchange_alert")[0].Body.p_observation_complete) "A normally finalized failed terminal-contact run must allow partial recovery of absent incidents"

Reset-TestPolicy
$outerCatchDetails = New-PolicyDetails
$outerCatchDetails.truthLedgerCheckpointVerified = $true
$outerCatchDetails.failureStage = "synchronization"
$outerCatchDetails.failedQueueRows = 1
$outerCatchDetails.changeDetails = @((New-ContactFailure "Partially processed" $queueId $true))
Invoke-ExchangeSyncNotificationPolicy "failed" "Outer catch after partial processing." $outerCatchDetails $webhook | Out-Null
Assert-True (-not @(Get-Calls "observe_outlook_exchange_alert")[0].Body.p_observation_complete) "An outer catch must not resolve unseen incidents even when a checkpoint was recorded"

# When several kinds are claimed together, none of their affected names may
# disappear merely because another kind has higher priority in the summary.
Reset-TestPolicy
$script:ObserveMode = "eligible"
$mixedDetails = New-PolicyDetails
$mixedDetails.failedQueueRows = 2
$mixedDetails.backlogRows = 2
$mixedDetails.failureStage = "connection"
$mixedDetails.changeDetails = @(
  (New-ContactFailure "Terminal contact" $queueId $true)
  (New-ContactFailure "Delayed contact" "22222222-2222-4222-8222-222222222222")
)
$mixedReceipt = Invoke-ExchangeSyncNotificationPolicy "failed" "Access denied." $mixedDetails $webhook
Assert-Equal "delivered" $mixedReceipt.Status "A claimed mixed incident must deliver one compact summary"
Assert-Equal "sync_issue" $mixedDetails.notificationIssueKind "Mixed kinds must use a neutral overall summary"
Assert-True ($script:SentMail[0].Html -match "Terminal contact" -and $script:SentMail[0].Html -match "Delayed contact") "All kinds' actual affected names must be eligible for the compact list"
Assert-Equal 3 @(@(Get-Calls "observe_outlook_exchange_alert")[0].Body.p_incidents).Count "The mixed observation must retain separate access, terminal and delayed incidents"
Assert-Equal 1 $script:SentMail.Count "A mixed incident must not generate one email per category"

# A changing failure string, timestamp, attempt or display name must not create
# a fresh incident for the same queue record; an actual escalation must.
$stableDetails = New-PolicyDetails
$stableDetails.failedQueueRows = 1
$stableDetails.changeDetails = @((New-ContactFailure "Original name" $queueId))
$firstIncident = @(Get-ExchangeAlertIncidents "failed" "temporary error one" $stableDetails "incremental")[0]
$stableDetails.changeDetails[0].attempt = 2
$stableDetails.changeDetails[0].result = "a different raw error"
$stableDetails.changeDetails[0].displayName = "Renamed contact"
$stableDetails.changeDetails[0].runId = [guid]::NewGuid().ToString()
$stableDetails.changeDetails[0].nextRetryAt = "2026-10-08T03:00:00Z"
$stableDetails.failedQueueRows = 99
$secondIncident = @(Get-ExchangeAlertIncidents "failed" "temporary error two" $stableDetails "incremental")[0]
Assert-Equal $firstIncident.key $secondIncident.key "Incident keys must remain stable across changing diagnostics and counters"
$stableDetails.changeDetails[0].terminal = $true
$stableDetails.changeDetails[0].retryable = $false
$escalated = @(Get-ExchangeAlertIncidents "failed" "retry limit exhausted" $stableDetails "incremental")[0]
Assert-True ($escalated.key -ne $secondIncident.key) "Escalation to a terminal issue must be a separately eligible incident"
Assert-True $escalated.immediate "Terminal escalation must require prompt attention"

$fullOperation = New-PolicyDetails "full"
$fullOperation.failedQueueRows = 1
$fullOperation.changeDetails = @(@{
  status = "failed"
  entityType = "addressbook"
  displayName = "Final address book verification"
  identifier = "queue:10"
  result = "First run verification diagnostics"
})
$fullKey10 = @(Get-ExchangeAlertIncidents "failed" "First run" $fullOperation "full")[0].key
$fullOperation.changeDetails[0].identifier = "queue:11"
$fullOperation.changeDetails[0].result = "Second run with a different queue position"
$fullKey11 = @(Get-ExchangeAlertIncidents "failed" "Second run" $fullOperation "full")[0].key
Assert-Equal $fullKey10 $fullKey11 "A full address-book operation must not become a new alert just because its queue position advances"

# A widespread outage is summarized into a stable service incident before it
# reaches the RPC limit, rather than preventing notification altogether.
Reset-TestPolicy
$script:ObserveMode = "eligible"
$largeDetails = New-PolicyDetails
$largeDetails.failedQueueRows = 1001
$largeDetails.backlogRows = 1001
$largeDetails.changeDetails = @(1..1001 | ForEach-Object { New-ContactFailure "Large entry $_" "large-entry-$_" })
$largeIncidents = @(Get-ExchangeAlertIncidents "failed" "Large batch delayed" $largeDetails "incremental")
Assert-Equal 1 $largeIncidents.Count "More than 1000 incidents must be coalesced before the RPC boundary"
Assert-Equal "sync_delayed" $largeIncidents[0].kind "A large retryable batch must retain delayed classification"
Assert-True (-not $largeIncidents[0].immediate) "A large retryable batch must not bypass the persistence window"
Assert-Equal "" $largeIncidents[0].name "A large coalesced incident must not retain unnecessary personal names"
$largeReceipt = Invoke-ExchangeSyncNotificationPolicy "failed" "Large batch delayed" $largeDetails $webhook
Assert-Equal "delivered" $largeReceipt.Status "An eligible large outage must not disappear into a policy-size failure"
Assert-Equal 1 @(@(Get-Calls "observe_outlook_exchange_alert")[0].Body.p_incidents).Count "Only the coalesced service incident may reach the history RPC"
Assert-Equal 1 $script:SentMail.Count "A large outage must still send only one compact email"
Assert-True ($script:SentMail[0].Html.Length -lt 2000 -and $script:SentMail[0].Html -notmatch "Large entry") "Large outages must not produce long name lists"
$largeDetails.changeDetails[0].terminal = $true
$largeDetails.changeDetails[0].retryable = $false
$largeEscalated = @(Get-ExchangeAlertIncidents "failed" "Large batch has a terminal issue" $largeDetails "incremental")
Assert-Equal 1 $largeEscalated.Count "A mixed widespread outage must also remain within the RPC limit"
Assert-True $largeEscalated[0].immediate "A coalesced terminal issue must retain prompt eligibility"
Assert-True ($largeIncidents[0].key -ne $largeEscalated[0].key) "Large-batch escalation must be separately eligible"

Reset-TestPolicy
$script:ObserveMode = "eligible"
$script:ThrowSmtp = $true
$smtpDetails = New-PolicyDetails
$smtpDetails.failureStage = "connection"
$smtpFailure = Invoke-ExchangeSyncNotificationPolicy "failed" $temporaryMessage $smtpDetails $webhook 3> $null
Assert-Equal "failed" $smtpFailure.Status "SMTP failure must remain a delivery failure"
Assert-True ($smtpFailure.Attempted -and -not $smtpFailure.Delivered) "An SMTP failure must not be acknowledged as delivered"
Assert-Equal 1 @(Get-Calls "complete_outlook_exchange_alert").Count "Failed SMTP must release its history claim"
Assert-True (@(Get-Calls "complete_outlook_exchange_alert")[0].Body.p_delivered -eq $false) "History completion must receive delivered=false after SMTP failure"
Assert-True $smtpDetails.notificationHistorySaved "A released SMTP failure claim must still be recorded"
Invoke-ExchangeSyncNotificationPolicy "failed" $temporaryMessage $smtpDetails $webhook 3> $null | Out-Null
Assert-Equal 1 $script:SentMail.Count "SMTP failure must not cause a second same-run send"

foreach ($mode in @("throw", "null", "not_boolean", "bad_claim", "unknown_key", "empty_keys", "duplicate_keys")) {
  Reset-TestPolicy
  $script:ObserveMode = $mode
  $malformedDetails = New-PolicyDetails
  $malformedDetails.failedQueueRows = 1
  $malformedDetails.changeDetails = @((New-ContactFailure "Still pending" $queueId $true))
  $realMessage = "Real sync failure remains recorded."
  $failedClosed = Invoke-ExchangeSyncNotificationPolicy "failed" $realMessage $malformedDetails $webhook 3> $null
  Assert-Equal "failed" $failedClosed.Status "Unavailable or malformed history must produce a preparation failure receipt: $mode"
  Assert-True (-not $failedClosed.Attempted -and -not $failedClosed.Delivered) "History errors must fail closed before SMTP: $mode"
  Assert-Equal 0 $script:SentMail.Count "Malformed history must never trigger an uncontrolled email: $mode"
  Assert-Equal 0 @(Get-Calls "complete_outlook_exchange_alert").Count "Unknown history claims must not be acknowledged: $mode"
  Assert-Equal 1 $malformedDetails.failedQueueRows "History errors must not overwrite the actual sync status: $mode"
  Assert-Equal "Real sync failure remains recorded." $realMessage "Policy must not alter the actual failure message: $mode"
  Assert-Equal "policy_unavailable" $malformedDetails.notificationDecisionReason "Policy failures must remain observable internally: $mode"
}

foreach ($mode in @("throw", "reject", "accepted_string", "delivered_string", "delivery_mismatch")) {
  Reset-TestPolicy
  $script:ObserveMode = "eligible"
  $script:CompleteMode = $mode
  $completionDetails = New-PolicyDetails
  $completionDetails.failureStage = "connection"
  $completionFailure = Invoke-ExchangeSyncNotificationPolicy "failed" $temporaryMessage $completionDetails $webhook 3> $null
  Assert-Equal "delivered" $completionFailure.Status "History completion problems must never erase an actual delivered receipt"
  Assert-True $completionFailure.Delivered "Actual email delivery must remain truthful even if acknowledgement fails"
  Assert-Equal 1 $script:SentMail.Count "Acknowledgement retries must not resend the email"
  Assert-Equal 3 @(Get-Calls "complete_outlook_exchange_alert").Count "Acknowledgement retries must be bounded to three attempts"
  Assert-Equal "1,2" ($script:Sleeps -join ",") "Acknowledgement retry waits must be bounded"
  Assert-True (-not $completionDetails.notificationHistorySaved) "Acknowledgement failure must be recorded for diagnosis"
  foreach ($call in @(Get-Calls "complete_outlook_exchange_alert")) {
    Assert-Equal $script:ClaimId $call.Body.p_claim_id "All acknowledgement retries must retain the original claim"
    Assert-True $call.Body.p_delivered "All acknowledgement retries must retain the real delivered result"
  }
  Invoke-ExchangeSyncNotificationPolicy "failed" $temporaryMessage $completionDetails $webhook 3> $null | Out-Null
  Assert-Equal 1 $script:SentMail.Count "Repeated same-run calls after acknowledgement failure must not resend"
  Assert-Equal 4 $script:RpcCalls.Count "Repeated same-run calls after acknowledgement failure must not replay history"
}

$fullTemp = New-PolicyDetails "full"
$fullTemp.failureStage = "connection"
$fullIncidents = @(Get-ExchangeAlertIncidents "failed" $temporaryMessage $fullTemp "full")
Assert-Equal "sync_delayed" $fullIncidents[0].kind "Temporary daily failures should still be described as delays"
Assert-True $fullIncidents[0].immediate "A failed daily verification cannot wait until the following day to become eligible"
$access = @(Get-ExchangeAlertIncidents "failed" "Access denied." @{ failureStage = "connection" } "incremental")
Assert-Equal "service_access" $access[0].kind "An access failure must not be hidden as a transient delay"
Assert-True $access[0].immediate "Access/configuration failures need immediate eligibility"

# Preserve typed full-certification failures. A generic HTTP500 may contain a
# real SQL proof error, so the typed SQL identity must outrank transport status.
function New-AlertHttpError([int]$Status, [string]$SqlCode = "") {
  $response = [System.Net.Http.HttpResponseMessage]::new([Enum]::ToObject([System.Net.HttpStatusCode], $Status))
  $exception = [Microsoft.PowerShell.Commands.HttpResponseException]::new("Response status code does not indicate success: $Status ().", $response)
  $record = [System.Management.Automation.ErrorRecord]::new($exception, "SyntheticHttpFailure", [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
  if ($SqlCode) { $record.ErrorDetails = [System.Management.Automation.ErrorDetails]::new((@{ code = $SqlCode; message = "Synthetic SQL result" } | ConvertTo-Json -Compress)) }
  return $record
}
function Commit-FullExchangeQueueCertification { throw $script:CertificationError }
function New-DurableCertificationFailure($ErrorRecord) {
  $script:CertificationError = $ErrorRecord
  $stats = New-PolicyDetails "full"
  $stats.fullCertificationCommitted = $false
  $stats.templateRecipientTruthReconciled = $false
  Complete-FullExchangeQueueCertificationIfEligible $stats "10" ("a" * 64) "{}" @{ contacts = 1 } @() | Out-Null
  Assert-Equal 1 $stats.failedQueueRows "An unconfirmed durable certificate must remain failed"
  Assert-True (-not $stats.fullCertificationCommitted -and -not $stats.templateRecipientTruthReconciled) "Notification classification must not invent a certificate or activation"
  return $stats
}
$legacyCertificationKey = Get-Sha256Hex "full|verification|Durable full certification"
foreach ($statusCode in @(408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524)) {
  $temporaryDetails = New-DurableCertificationFailure (New-AlertHttpError $statusCode)
  $temporaryIncidents = @(Get-ExchangeAlertIncidents "failed" "Exchange full reconciliation failed with 1 validation or verification error(s)." $temporaryDetails "full")
  Assert-Equal 1 $temporaryIncidents.Count "Temporary HTTP$statusCode certification must remain one operation"
  Assert-Equal $legacyCertificationKey $temporaryIncidents[0].key "Temporary classification must retain the delivered legacy operation hash"
  Assert-Equal "verification" $temporaryIncidents[0].kind "Keeping the legacy history kind prevents re-alerting during upgrade"
  Assert-True (-not $temporaryIncidents[0].immediate) "A new temporary certification HTTP$statusCode issue must wait for persistence"
}
foreach ($failure in @(
  [System.Management.Automation.ErrorRecord]::new([TimeoutException]::new("Synthetic request exceeded 60 seconds"), "SyntheticTimeout", [System.Management.Automation.ErrorCategory]::OperationTimeout, $null),
  (New-AlertHttpError 500 "57014"),
  (New-AlertHttpError 500 "55P03")
)) {
  $temporaryDetails = New-DurableCertificationFailure $failure
  Assert-True (-not @(Get-ExchangeAlertIncidents "failed" "Final certification pending" $temporaryDetails "full")[0].immediate) "Typed timeout/cancellation must retain the persistence window"
}
$proofFailure = New-DurableCertificationFailure (New-AlertHttpError 500 "P0001")
Assert-True @(Get-ExchangeAlertIncidents "failed" "A proof mismatch must not be downgraded" $proofFailure "full")[0].immediate "SQL proof/validation failure must not become temporary merely because HTTP status is500"
$proofFailure.failureStage = "verification"
$proofFailure.failureRetryable = $true
Assert-Equal 2 @(Get-ExchangeAlertIncidents "failed" "Response status code does not indicate success: 521 ()." $proofFailure "full").Count "An outer transport problem must remain independent of a permanent durable proof failure"
Assert-True (-not (Test-ExchangeAlertTemporaryFailure $null "Immutable projection mismatch in field timeout503")) "Arbitrary mismatch text must not become a transport identity"

foreach ($missingProof in @("truthLedgerCheckpointVerified", "fullCertificationCommitted", "templateRecipientTruthReconciled")) {
  foreach ($missing in @($true, $false)) {
    Reset-TestPolicy
    $noRecovery = New-PolicyDetails "full"
    $noRecovery.truthLedgerCheckpointVerified = $true
    $noRecovery.fullCertificationCommitted = $true
    $noRecovery.templateRecipientTruthReconciled = $true
    if ($missing) { $noRecovery.Remove($missingProof) } else { $noRecovery[$missingProof] = $false }
    Invoke-ExchangeSyncNotificationPolicy "completed" "No trusted proof for recovery" $noRecovery $webhook | Out-Null
    $noRecoveryObservation = @(Get-Calls "observe_outlook_exchange_alert")[0].Body
    Assert-True (-not $noRecoveryObservation.p_recovery_proven -and -not $noRecoveryObservation.p_observation_complete) "Missing or false $missingProof must not rearm an existing full incident"
  }
}

# Exact reported sequence: the existing Durable full certification incident
# was delivered on23October. Later full runs have the same unresolved operation;
# on27October a HTTP521 while saving/checkpointing adds failureStage=verification.
# It must not create verification|service (or a newly re-keyed delayed incident).
Reset-TestPolicy
$script:ObserveMode = "history"
$script:DeliveredIncidentKeys[$legacyCertificationKey] = $true
foreach ($day in 24..27) {
  $script:CurrentQueueRunId = [guid]::NewGuid().ToString()
  $repeat = New-DurableCertificationFailure (New-AlertHttpError $(if ($day -eq 27) { 521 } else { 500 }))
  if ($day -eq 27) { $repeat.failureStage = "verification"; $repeat.failureRetryable = $true }
  $outerMessage = if ($day -eq 27) { "Response status code does not indicate success: 521 ()." } else { "Exchange full reconciliation failed with 1 validation or verification error(s)." }
  $repeatReceipt = Invoke-ExchangeSyncNotificationPolicy "failed" $outerMessage $repeat @{ requestedAt = "2026-10-${day}T22:24:00Z" }
  Assert-Equal "not_required" $repeatReceipt.Status "An unchanged delivered operation must stay silent on day$day"
  Assert-Equal "already_notified" $repeat.notificationDecisionReason "The same operation must use existing delivery history on day$day"
  $observation = @(Get-Calls "observe_outlook_exchange_alert")[-1].Body
  Assert-Equal 1 @($observation.p_incidents).Count "The outer catch must not invent a second incident on day$day"
  Assert-Equal $legacyCertificationKey $observation.p_incidents[0].key "The operation hash must remain stable across dates and failure locations"
  Assert-True (-not $observation.p_recovery_proven) "An incomplete full proof must never rearm delivery history"
}
Assert-Equal 0 $script:SentMail.Count "Repeated unresolved daily checks must not send a new email"

foreach ($accessStatus in @(401, 403)) {
  Reset-TestPolicy
  $script:ObserveMode = "history"
  $script:DeliveredIncidentKeys[$legacyCertificationKey] = $true
  $typedAccess = New-DurableCertificationFailure (New-AlertHttpError $accessStatus)
  $accessIncidents = @(Get-ExchangeAlertIncidents "failed" "Generic full failure summary" $typedAccess "full")
  Assert-Equal "service_access" $accessIncidents[0].kind "A typed HTTP$accessStatus inside durable certification is a genuine access escalation"
  Assert-True $accessIncidents[0].immediate "A typed access escalation must not wait for persistence"
  Assert-True ($accessIncidents[0].key -ne $legacyCertificationKey) "A new access escalation must not reuse the delivered verification key"
  Assert-Equal "delivered" (Invoke-ExchangeSyncNotificationPolicy "failed" "Generic full failure summary" $typedAccess $webhook).Status "New typed HTTP$accessStatus must alert even if the older operation was delivered"
  $script:CurrentQueueRunId = [guid]::NewGuid().ToString()
  Assert-Equal "not_required" (Invoke-ExchangeSyncNotificationPolicy "failed" "Generic full failure summary" $typedAccess $webhook).Status "An unchanged access escalation must alert only once"
  Assert-True $script:DeliveredIncidentKeys[$legacyCertificationKey] "Escalation must preserve the old delivered operation history"
  Assert-Equal 1 $script:SentMail.Count "The same typed access problem must not repeat an email"

  # The reported extra verification|service email is also already delivered.
  # A later typed access denial in the outer catch must still be a NEW access
  # incident, not silently reuse that old generic verification service key.
  Reset-TestPolicy
  $script:ObserveMode = "history"
  $script:DeliveredIncidentKeys[$legacyCertificationKey] = $true
  $script:DeliveredIncidentKeys[(Get-Sha256Hex "full|verification|service")] = $true
  $outerAccessError = New-AlertHttpError $accessStatus
  $outerAccess = New-DurableCertificationFailure (New-AlertHttpError 521)
  $outerAccess.failureStage = "verification"
  $outerAccess.failureServiceAccess = Test-ExchangeAlertServiceAccessFailure $outerAccessError
  $outerAccess.failureRetryable = Test-ExchangeAlertTemporaryFailure $outerAccessError
  Assert-Equal "delivered" (Invoke-ExchangeSyncNotificationPolicy "failed" $outerAccessError.Exception.Message $outerAccess $webhook).Status "A typed outer HTTP$accessStatus must not be hidden by an older generic verification service email"
  Assert-Equal "service_access" $outerAccess.notificationIssueKind "The typed outer denial must retain its access category"
  $script:CurrentQueueRunId = [guid]::NewGuid().ToString()
  Assert-Equal "not_required" (Invoke-ExchangeSyncNotificationPolicy "failed" $outerAccessError.Exception.Message $outerAccess $webhook).Status "An unchanged outer access denial must not notify twice"
  Assert-Equal 1 $script:SentMail.Count "The same outer access denial must send once"
}
Assert-True (-not (Test-ExchangeAlertTemporaryFailure (New-AlertHttpError 401 "57014"))) "A typed401 must outrank a contradictory temporary SQL body"
Reset-TestPolicy
$script:ObserveMode = "history"
$script:DeliveredIncidentKeys[$legacyCertificationKey] = $true

# An independent auth failure or newly affected contact still warrants its own
# incident, even while the known certification operation remains unresolved.
$newAccess = New-DurableCertificationFailure (New-AlertHttpError 521)
$newAccess.failureStage = "verification"
$newAccess.failureRetryable = $false
$script:CurrentQueueRunId = [guid]::NewGuid().ToString()
Assert-Equal "delivered" (Invoke-ExchangeSyncNotificationPolicy "failed" "Access denied during final check." $newAccess $webhook).Status "New access failures must not be hidden behind an older operation"
Assert-Equal "service_access" $newAccess.notificationIssueKind "Independent access trouble must retain its clear category"
$newContact = New-DurableCertificationFailure (New-AlertHttpError 521)
$newContact.changeDetails += New-ContactFailure "New terminal contact" "33333333-3333-4333-8333-333333333333" $true
$newContact.failedQueueRows = 2
$script:CurrentQueueRunId = [guid]::NewGuid().ToString()
Assert-Equal "delivered" (Invoke-ExchangeSyncNotificationPolicy "failed" "Final check has an independent contact failure" $newContact $webhook).Status "A new terminal contact must still notify"
Assert-True ($script:SentMail[-1].Html -match "New terminal contact") "The independent affected contact must remain visible"
$independentProof = New-DurableCertificationFailure (New-AlertHttpError 521)
$independentProof.failureStage = "verification"
$independentProof.failureRetryable = $false
$proofIncidents = @(Get-ExchangeAlertIncidents "failed" "Immutable truth-ledger proof does not match" $independentProof "full")
Assert-Equal 2 $proofIncidents.Count "A genuine independent proof failure must not be absorbed by the known durable-certification incident"
Assert-True ($proofIncidents.key -contains (Get-Sha256Hex "full|verification|service")) "Independent proof failures must retain their service incident"

Write-Output "Exchange alert policy tests passed."
