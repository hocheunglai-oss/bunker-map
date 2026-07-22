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

foreach ($email in @(
  "abc.@example.com",
  "a..b@example.com",
  "a@-example.com",
  "a@example-.com",
  "a@example_foo.com",
  "IONIAN OIL"
)) {
  Assert-True (-not (Test-ValidEmail $email)) "Invalid email '$email' must be rejected"
}
Assert-True (Test-ValidEmail "valid.name+tag@example-domain.com") "A normal external email must be accepted"

$directWebhookPayload = Get-WebhookPayload '{"syncMode":"full","requestedBy":"SC"}'
Assert-Equal "full" $directWebhookPayload.syncMode "A JSON string from the Azure Test pane must preserve syncMode"
$wrappedWebhookPayload = Get-WebhookPayload '{"RequestBody":"{\"syncMode\":\"full\",\"requestedBy\":\"SC\"}"}'
Assert-Equal "full" $wrappedWebhookPayload.syncMode "A serialized Azure webhook wrapper must preserve syncMode"
$nativeWebhookPayload = Get-WebhookPayload ([pscustomobject]@{ RequestBody = '{"syncMode":"incremental"}' })
Assert-Equal "incremental" $nativeWebhookPayload.syncMode "A native Azure webhook object must remain supported"

$fallbackRequestedAt = "2026-07-22T08:00:00.0000000Z"
$explicitRequestedAt = "2026-07-22T07:59:00.0000000Z"
$explicitInitializedPayload = Initialize-WebhookPayload `
  ('{"syncMode":"full","requestedAt":"' + $explicitRequestedAt + '"}') `
  $fallbackRequestedAt
Assert-Equal $explicitRequestedAt $explicitInitializedPayload.requestedAt "An explicit request timestamp must be preserved"
$scheduledInitializedPayload = Initialize-WebhookPayload `
  '{"RequestBody":"{\"syncMode\":\"full\",\"requestedBy\":\"Azure Automation daily full schedule\"}"}' `
  $fallbackRequestedAt
Assert-Equal "full" $scheduledInitializedPayload.syncMode "A wrapped scheduled payload must preserve full mode"
Assert-Equal $fallbackRequestedAt $scheduledInitializedPayload.requestedAt "A scheduled payload must receive its job-start timestamp exactly once"
$nullInitializedPayload = Initialize-WebhookPayload $null $fallbackRequestedAt
Assert-Equal $fallbackRequestedAt $nullInitializedPayload.requestedAt "A null payload must receive a job-start timestamp"
Assert-True (-not (Has-MapKey $nullInitializedPayload "syncMode")) "A null payload must continue to default to incremental mode at the entry point"

$originalInvokeSupabaseRestForStatus = (Get-Item Function:Invoke-SupabaseRest).ScriptBlock
$script:capturedStatusBodies = [System.Collections.ArrayList]::new()
Set-Item Function:Invoke-SupabaseRest -Value {
  param($Method, $Path, $Body = $null)
  [void]$script:capturedStatusBodies.Add($Body)
  return @()
}
try {
  $script:CurrentSyncRequestedAt = $fallbackRequestedAt
  Save-SyncStatus "running" "First status write."
  Save-SyncStatus "completed" "Second status write."
  Assert-Equal 2 $script:capturedStatusBodies.Count "Both status writes must be captured"
  Assert-Equal $fallbackRequestedAt $script:capturedStatusBodies[0].payload.requestedAt "The first status write must retain the job-start timestamp"
  Assert-Equal $fallbackRequestedAt $script:capturedStatusBodies[1].payload.requestedAt "Later status writes must retain the same job-start timestamp"
  Assert-True ([bool](Clean-Text $script:capturedStatusBodies[0].updated_at)) "The first status write must still record its own update timestamp"
  Assert-True ([bool](Clean-Text $script:capturedStatusBodies[1].updated_at)) "The second status write must still record its own update timestamp"
} finally {
  Set-Item Function:Invoke-SupabaseRest -Value $originalInvokeSupabaseRestForStatus
  $script:CurrentSyncRequestedAt = $null
}

$originalCulture = [Globalization.CultureInfo]::CurrentCulture
try {
  [Globalization.CultureInfo]::CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo("tr-TR")
  Assert-Equal "info@example.com" (Normalize-Email "INFO@EXAMPLE.COM") "Email normalization must be culture invariant"
  Assert-Equal "imc-shipping" (Get-ExchangeAlias "IMC SHIPPING" "fallback") "Alias normalization must be culture invariant"
} finally {
  [Globalization.CultureInfo]::CurrentCulture = $originalCulture
}

$contacts = @(
  [pscustomobject]@{ id = "c-new"; source_book = "A"; display_name = "Newest"; primary_email = "dup@example.com"; nickname = "DUP"; first_name = "New"; last_name = "Owner"; updated_at = "2026-07-22T02:00:00Z" },
  [pscustomobject]@{ id = "c-old"; source_book = "A"; display_name = "Older"; primary_email = "dup@example.com"; nickname = "DUP"; first_name = "Old"; last_name = "Owner"; updated_at = "2026-07-21T02:00:00Z" },
  [pscustomobject]@{ id = "c-other"; source_book = "A"; display_name = "Other"; primary_email = "other@example.com"; nickname = "OTHER"; first_name = ""; last_name = ""; updated_at = "2026-07-20T02:00:00Z" }
)
$groups = @(
  [pscustomobject]@{ id = "g-1"; source_book = "A"; name = "Group One"; nickname = "GROUP ONE"; source_uid = "g1"; description = "" },
  [pscustomobject]@{ id = "g-2"; source_book = "A"; name = "Group Two"; nickname = "GROUP TWO"; source_uid = "g2"; description = "" }
)
$members = @(
  [pscustomobject]@{ group_id = "g-1"; contact_id = "c-new"; source_book = "A" },
  [pscustomobject]@{ group_id = "g-2"; contact_id = "c-old"; source_book = "A" }
)
$built = Build-ExchangeRows $contacts $groups $members
Assert-Equal 2 @($built.Contacts).Count "Duplicate emails must produce one external recipient per unique email"
Assert-Equal 2 @($built.Members).Count "Memberships from every duplicate source ID must be preserved"
Assert-Equal "c-new" $built.ContactByEmail["dup@example.com"].SourceContactId "Newest source row must be the canonical duplicate owner"
Assert-True ($built.ContactByEmail["dup@example.com"].AllowedOwnerSourceKeys -contains "FCUNO_CONTACT:c-old") "A canonical duplicate must record its previous eligible source owner"
Assert-True ($built.ContactByEmail["dup@example.com"].AllowedOwnerSourceKeys -contains "FCUNO_CONTACT:c-new") "A canonical duplicate must record its current eligible source owner"

$shuffled = Build-ExchangeRows @($contacts[2], $contacts[1], $contacts[0]) @($groups[1], $groups[0]) @($members[1], $members[0])
$firstProjection = $built | ConvertTo-Json -Depth 10 -Compress
$secondProjection = $shuffled | ConvertTo-Json -Depth 10 -Compress
Assert-Equal $firstProjection $secondProjection "Canonical projection must be independent of input order"

$falseRow = [pscustomobject]@{ payload = [pscustomobject]@{ allowUntaggedExactDelete = "false" } }
$trueRow = [pscustomobject]@{ payload = [pscustomobject]@{ allowUntaggedExactDelete = $true } }
Assert-True (-not (Get-QueueBoolean $falseRow "allowUntaggedExactDelete")) "String false must not authorize legacy deletion"
Assert-True (Get-QueueBoolean $trueRow "allowUntaggedExactDelete") "Native true must authorize an explicitly guarded legacy deletion"

$fieldRow = [pscustomobject]@{
  entity_type = "contact"
  payload = [pscustomobject]@{
    beforeContact = [pscustomobject]@{ display_name = "Example"; primary_email = "old@example.com"; nickname = "example"; first_name = "Old"; last_name = "Name"; source_book = "A" }
    afterContact = [pscustomobject]@{ display_name = "Example"; primary_email = "new@example.com"; nickname = "example"; first_name = "New"; last_name = "Name"; source_book = "A" }
  }
}
$fieldChanges = @(Get-QueueFieldChanges $fieldRow)
Assert-True ($fieldChanges -contains "Email: old@example.com -> new@example.com") "Notice must show the exact old and new email"
Assert-True ($fieldChanges -contains "First name: Old -> New") "Notice must show each changed Exchange profile field"
$capitalizationRow = [pscustomobject]@{
  entity_type = "contact"
  payload = [pscustomobject]@{
    beforeContact = [pscustomobject]@{ display_name = "Acme shipping" }
    afterContact = [pscustomobject]@{ display_name = "ACME SHIPPING" }
  }
}
Assert-True (@(Get-QueueFieldChanges $capitalizationRow) -contains "Display name: Acme shipping -> ACME SHIPPING") "Capitalization-only FCUNO edits must appear in the exact change notice"
$auditScopedFieldRow = [pscustomobject]@{
  action = "update_contact"
  entity_type = "contact"
  changed_fields = @("primary_email")
  payload = [pscustomobject]@{
    beforeContact = [pscustomobject]@{ display_name = "Stale vCard name"; primary_email = "old@example.com" }
    afterContact = [pscustomobject]@{ display_name = "Current FCUNO name"; primary_email = "new@example.com" }
  }
}
$auditScopedChanges = @(Get-QueueFieldChanges $auditScopedFieldRow)
Assert-Equal 1 $auditScopedChanges.Count "An update notice must attribute only fields explicitly present in audit changed_fields"
Assert-Equal "Email: old@example.com -> new@example.com" $auditScopedChanges[0] "A stale before snapshot must not invent an unaudited display-name change"
$groupIdentityFieldRow = [pscustomobject]@{
  action = "update_group"
  entity_type = "group"
  changed_fields = @("id", "source_uid")
  payload = [pscustomobject]@{
    beforeGroup = [pscustomobject]@{ id = "group-old-id"; source_uid = "source-old" }
    afterGroup = [pscustomobject]@{ id = "group-current-id"; source_uid = "source-current" }
  }
}
$groupIdentityFieldChanges = @(Get-QueueFieldChanges $groupIdentityFieldRow)
Assert-True ($groupIdentityFieldChanges -contains "FCUNO group ID: group-old-id -> group-current-id") "A queued group primary-key change must show its exact old and new FCUNO IDs"
Assert-True ($groupIdentityFieldChanges -contains "Source UID: source-old -> source-current") "A queued group source_uid change must show its exact old and new values"

$contactMetadataFieldRow = [pscustomobject]@{
  action = "update_contact"
  entity_type = "contact"
  changed_fields = @("id", "source_card", "vcard", "properties")
  payload = [pscustomobject]@{
    beforeContact = [pscustomobject]@{ id = "contact-old-id"; source_card = "card-old"; vcard = "BEGIN:VCARD SECRET-OLD"; properties = '{"private":"old"}' }
    afterContact = [pscustomobject]@{ id = "contact-current-id"; source_card = "card-current"; vcard = "BEGIN:VCARD SECRET-CURRENT"; properties = '{"private":"current"}' }
  }
}
$contactMetadataFieldChanges = @(Get-QueueFieldChanges $contactMetadataFieldRow)
Assert-True ($contactMetadataFieldChanges -contains "FCUNO contact ID: contact-old-id -> contact-current-id") "An all-contact UPDATE trigger row must show an exact contact ID change"
Assert-True ($contactMetadataFieldChanges -contains "Source card: card-old -> card-current") "An all-contact UPDATE trigger row must show an exact source-card change"
Assert-True ($contactMetadataFieldChanges -contains "vCard metadata: changed (FCUNO metadata / verification-only; raw value omitted)") "A vCard-only queue row must name the exact metadata field without embedding the raw card"
Assert-True ($contactMetadataFieldChanges -contains "Contact properties metadata: changed (FCUNO metadata / verification-only; raw value omitted)") "A properties-only queue row must name the exact metadata field without embedding raw JSON"
Assert-True (($contactMetadataFieldChanges -join " ") -notmatch "SECRET-|private") "Large or sensitive FCUNO metadata values must be omitted from the email while their field names remain visible"

$singleSaveRow = [pscustomobject]@{ payload = [pscustomobject]@{ operationHistory = @("UPDATE") } }
$mergedSaveRow = [pscustomobject]@{ payload = [pscustomobject]@{ operationHistory = @("UPDATE", "UPDATE", "UPDATE") } }
Assert-Equal 0 (Get-QueueSupersededSaveCount $singleSaveRow) "One queued save must not be counted as superseded"
Assert-Equal 2 (Get-QueueSupersededSaveCount $mergedSaveRow) "Only earlier saves merged into the final queue value must be counted as superseded"
$skipAccounting = @{ skippedQueueRows = 0; supersededQueueRows = 0 }
$supersededSaveCount = Get-QueueSupersededSaveCount $mergedSaveRow
Increment-Stat $skipAccounting "supersededQueueRows" $supersededSaveCount
Increment-Stat $skipAccounting "skippedQueueRows" $supersededSaveCount
Assert-Equal 0 ([Math]::Max(0, [int]$skipAccounting.skippedQueueRows - [int]$skipAccounting.supersededQueueRows)) "Superseded saves must not be reported as actionable skipped changes"
Increment-Stat $skipAccounting "skippedQueueRows"
Assert-Equal 1 ([Math]::Max(0, [int]$skipAccounting.skippedQueueRows - [int]$skipAccounting.supersededQueueRows)) "One real skipped row must remain one actionable skipped change"

$firstFingerprint = Get-CanonicalExchangeProjectionFingerprint $built
$secondFingerprint = Get-CanonicalExchangeProjectionFingerprint $shuffled
Assert-Equal $firstFingerprint $secondFingerprint "Source certification fingerprint must remain deterministic for the same canonical projection"
$sourceBookOnlyContacts = @($contacts | ForEach-Object {
  [pscustomobject]@{
    id = $_.id
    source_book = "NON-EXCHANGE-CONTACT-BOOK"
    display_name = $_.display_name
    primary_email = $_.primary_email
    nickname = $_.nickname
    first_name = $_.first_name
    last_name = $_.last_name
    updated_at = $_.updated_at
  }
})
$sourceBookOnlyGroups = @($groups | ForEach-Object {
  [pscustomobject]@{
    id = $_.id
    source_book = "NON-EXCHANGE-GROUP-BOOK"
    name = $_.name
    nickname = $_.nickname
    source_uid = $_.source_uid
    description = $_.description
  }
})
$sourceBookOnlyFingerprint = Get-CanonicalExchangeProjectionFingerprint (Build-ExchangeRows $sourceBookOnlyContacts $sourceBookOnlyGroups $members)
Assert-Equal $firstFingerprint $sourceBookOnlyFingerprint "Non-Exchange source_book changes must not alter the durable Exchange certification fingerprint"
$changedFingerprintRows = Build-ExchangeRows @(
  [pscustomobject]@{ id = "c-new"; source_book = "A"; display_name = "Newest Changed"; primary_email = "dup@example.com"; nickname = "DUP"; first_name = "New"; last_name = "Owner"; updated_at = "2026-07-22T02:00:00Z" },
  $contacts[1],
  $contacts[2]
) $groups $members
$changedFingerprint = Get-CanonicalExchangeProjectionFingerprint $changedFingerprintRows
Assert-True ($firstFingerprint -cne $changedFingerprint) "An Exchange-relevant FCUNO change must alter the source certification fingerprint"
$duplicateWinnerChangedRows = Build-ExchangeRows @(
  [pscustomobject]@{ id = "c-new"; source_book = "A"; display_name = "Newest"; primary_email = "dup@example.com"; nickname = "DUP"; first_name = "New"; last_name = "Owner"; updated_at = "2026-07-20T02:00:00Z" },
  [pscustomobject]@{ id = "c-old"; source_book = "A"; display_name = "Older"; primary_email = "dup@example.com"; nickname = "DUP"; first_name = "Old"; last_name = "Owner"; updated_at = "2026-07-23T02:00:00Z" },
  $contacts[2]
) $groups $members
Assert-Equal "c-old" $duplicateWinnerChangedRows.ContactByEmail["dup@example.com"].SourceContactId "The newest duplicate source row must still determine the canonical Exchange owner"
Assert-True ($firstFingerprint -cne (Get-CanonicalExchangeProjectionFingerprint $duplicateWinnerChangedRows)) "A duplicate-winner change that alters Exchange-visible contact fields must alter the certification fingerprint"
Assert-Equal 0 @(Get-ExchangeSourceCertificationDrift $firstFingerprint "10@2026-07-22T00:00:00Z" $secondFingerprint "10@2026-07-22T00:00:00Z").Count "An unchanged projection and queue high-water must pass the source fence"
$projectionDrift = @(Get-ExchangeSourceCertificationDrift $firstFingerprint "10@2026-07-22T00:00:00Z" "different-fingerprint" "10@2026-07-22T00:00:00Z")
Assert-True (($projectionDrift -join " ") -match "canonical Exchange projection changed") "A changed canonical projection must invalidate full certification"
$queueDrift = @(Get-ExchangeSourceCertificationDrift $firstFingerprint "10@2026-07-22T00:00:00Z" $firstFingerprint "11@2026-07-22T00:01:00Z")
Assert-True (($queueDrift -join " ") -match "queue high-water changed") "A changed durable queue high-water must invalidate full certification"
$parsedQueueFence = ConvertFrom-ExchangeQueueHighWater "42@2026-07-22T07:15:00Z"
Assert-Equal 42 $parsedQueueFence.Sequence "The full-certification RPC fence must preserve the exact queue sequence"
Assert-Equal "2026-07-22T07:15:00Z" $parsedQueueFence.UpdatedAt "The full-certification RPC fence must preserve the exact queue timestamp"

$atomicOriginalInvokeSupabaseRest = (Get-Item Function:Invoke-SupabaseRest).ScriptBlock
$atomicOriginalGetOptionalAutomationSetting = (Get-Item Function:Get-OptionalAutomationSetting).ScriptBlock
$atomicOriginalSendExchangeSmtpMail = (Get-Item Function:Send-ExchangeSmtpMail).ScriptBlock
$script:CurrentQueueRunId = "12121212-1212-4212-8212-121212121212"
$atomicQueueRowId = "34343434-3434-4434-8434-343434343434"
$supersededQueueRowId = "56565656-5656-4656-8656-565656565656"
$script:completionRpcCalls = 0
$script:completionRpcBodies = @()
$script:certificationRpcCalls = 0
$script:certificationRpcBodies = @()
$script:capturedResolvedSubject = ""
$script:capturedResolvedHtml = ""
Set-Item Function:Start-Sleep -Value { param($Seconds) }
Set-Item Function:Invoke-SupabaseRest -Value {
  param($Method, $Path, $Body = $null)
  if ($Path -eq "rpc/complete_verified_outlook_exchange_sync_queue_row") {
    $script:completionRpcCalls += 1
    $script:completionRpcBodies += [pscustomobject]@{ row = $Body.p_queue_row_id; run = $Body.p_run_id }
    if ($script:completionRpcCalls -eq 1) { throw "The HTTP response was lost after the atomic completion committed." }
    return [pscustomobject]@{
      completed = $true
      idempotent = $true
      reason = "Queue row was already completed and Exchange-verified by this run."
      completedRow = [pscustomobject]@{
        id = $atomicQueueRowId
        eventId = "23232323-2323-4232-8232-232323232323"
        entityType = "contact"
        entityId = "contact-atomic"
        entityKey = "atomic@example.com"
        entityEmail = "atomic@example.com"
        entityAlias = "atomic-contact"
        action = "update_contact"
        displayName = "Atomic Contact"
        payload = [pscustomobject]@{}
        changeSetId = "change-set-current"
        changeSetIds = @("change-set-current")
        auditLogId = "audit-current"
        auditLogIds = @("audit-current")
        actorId = "SC"
        requestedBy = "SC Display"
        changedFields = @("display_name")
        sourceVersion = 8
        status = "completed"
        attempts = 1
        errorHistory = @()
        runId = $script:CurrentQueueRunId
        exchangeVerifiedAt = "2026-07-22T07:20:00Z"
        completedAt = "2026-07-22T07:20:00Z"
      }
      supersededCount = 1
      supersededRows = @([pscustomobject]@{
        id = $supersededQueueRowId
        eventId = "78787878-7878-4787-8787-787878787878"
        entityType = "contact"
        entityId = "contact-atomic"
        entityKey = "atomic@example.com"
        entityEmail = "atomic@example.com"
        entityAlias = "atomic-contact"
        action = "update_contact"
        displayName = "Atomic Contact"
        payload = [pscustomobject]@{
          beforeContact = [pscustomobject]@{ display_name = "Atomic old"; primary_email = "atomic@example.com" }
          afterContact = [pscustomobject]@{ display_name = "Atomic current"; primary_email = "atomic@example.com" }
        }
        changeSetId = "change-set-atomic"
        changeSetIds = @("change-set-atomic")
        auditLogId = "audit-atomic"
        auditLogIds = @("audit-atomic")
        actorId = "SC"
        requestedBy = "SC Display"
        changedFields = @("display_name")
        sourceVersion = 7
        status = "skipped"
        attempts = 3
        previousErrorMessage = "Old terminal Exchange error"
        errorMessage = "Old terminal Exchange error`nSuperseded by verified current state."
        errorHistory = @(
          [pscustomobject]@{ type = "processing_failed"; message = "Old terminal Exchange error"; attempt = 3; terminal = $true },
          [pscustomobject]@{ type = "terminal_failure_superseded"; superseding_queue_row_id = $atomicQueueRowId; superseding_run_id = $script:CurrentQueueRunId }
        )
        previousRunId = "90909090-9090-4090-8090-909090909090"
        supersededByQueueRowId = $atomicQueueRowId
        supersededByRunId = $script:CurrentQueueRunId
        completedAt = "2026-07-22T07:20:00Z"
      })
    }
  }
  if ($Path -eq "rpc/certify_full_outlook_exchange_sync_queue") {
    $script:certificationRpcCalls += 1
    $script:certificationRpcBodies += [pscustomobject]@{
      run = $Body.p_run_id
      sequence = $Body.p_queue_high_water_sequence
      updatedAt = $Body.p_queue_high_water_updated_at
      fingerprint = $Body.p_source_fingerprint
    }
    if ($script:certificationRpcCalls -eq 1) { throw "The HTTP response was lost after full certification committed." }
    return [pscustomobject]@{
      certified = $true
      idempotent = $true
      reason = "This full certification run was already committed; returning its durable result."
      certifiedAt = "2026-07-22T07:21:00Z"
      sourceFingerprint = "atomic-fingerprint"
      queueFence = [pscustomobject]@{ expectedSequence = 42; expectedUpdatedAt = "2026-07-22T07:15:00Z"; currentSequence = 42; currentUpdatedAt = "2026-07-22T07:15:00Z" }
      supersededCount = 1
      supersededRows = @([pscustomobject]@{
        id = "67676767-6767-4676-8676-676767676767"
        eventId = "89898989-8989-4898-8989-898989898989"
        entityType = "group"
        entityId = "group-full-certification"
        entityKey = "full-certification-group"
        entityEmail = ""
        entityAlias = "full-certification-group"
        action = "update_group"
        displayName = "Full Certification Group"
        payload = [pscustomobject]@{
          beforeGroup = [pscustomobject]@{ name = "Old full group"; description = "Old notes" }
          afterGroup = [pscustomobject]@{ name = "Full Certification Group"; description = "Current notes" }
        }
        changeSetId = "change-set-full"
        changeSetIds = @("change-set-full")
        auditLogId = "audit-full"
        auditLogIds = @("audit-full")
        actorId = "SC"
        requestedBy = "SC Display"
        changedFields = @("name", "description")
        sourceVersion = 4
        status = "skipped"
        attempts = 3
        previousErrorMessage = "Old terminal full-sync error"
        errorMessage = "Old terminal full-sync error`nSuperseded by full certification."
        errorHistory = @([pscustomobject]@{ type = "terminal_failure_superseded_by_full_certification"; superseding_full_run_id = $script:CurrentQueueRunId })
        previousRunId = "91919191-9191-4191-8191-919191919191"
        supersededByFullRunId = $script:CurrentQueueRunId
        completedAt = "2026-07-22T07:21:00Z"
      })
    }
  }
  throw "Unexpected REST path $Path"
}
Set-Item Function:Get-OptionalAutomationSetting -Value { param($Name) return $null }
Set-Item Function:Send-ExchangeSmtpMail -Value {
  param($From, $To, $Subject, $Html)
  $script:capturedResolvedSubject = $Subject
  $script:capturedResolvedHtml = $Html
}
try {
  $completionResult = Complete-VerifiedExchangeQueueRow $atomicQueueRowId
  Assert-Equal 2 $script:completionRpcCalls "An ambiguous atomic completion response must retry with the idempotent row/run contract"
  Assert-True ([bool]$completionResult.completed -and [bool]$completionResult.idempotent) "A confirmed idempotent completion replay must count as success"
  Assert-Equal $script:completionRpcBodies[0].row $script:completionRpcBodies[1].row "Atomic completion retry must reuse the exact same queue row UUID"
  Assert-Equal $script:completionRpcBodies[0].run $script:completionRpcBodies[1].run "Atomic completion retry must reuse the exact same run UUID"

  $resolvedStats = @{
    syncMode = "incremental"
    queuedRows = 1
    processedQueueRows = 1
    completedQueueRows = 1
    failedQueueRows = 0
    backlogRows = 0
    retryableBacklogRows = 0
    terminalBacklogRows = 0
    activeBacklogRows = 0
    skippedQueueRows = 0
    supersededQueueRows = 0
    resolvedTerminalQueueRows = 0
    changeDetails = @()
  }
  Add-ExchangeResolvedTerminalQueueDetails $resolvedStats $completionResult "incremental"
  Assert-Equal 1 $resolvedStats.resolvedTerminalQueueRows "Atomic completion must count every terminal queue row it durably superseded"
  Assert-Equal 1 $resolvedStats.skippedQueueRows "A durably superseded terminal row must be included in non-actionable skipped accounting"
  $resolvedDetail = @($resolvedStats.changeDetails)[0]
  Assert-Equal "superseded" $resolvedDetail.status "A superseded terminal queue row must render as resolved, not failed or green-completed"
  Assert-True ($resolvedDetail.result -match "Old terminal Exchange error") "A resolved terminal detail must preserve its exact previous error"
  Assert-True ($resolvedDetail.result -match "later Exchange-verified processing of the current FCUNO state") "Resolved wording must describe later verified processing, not assume the superseding row has a higher queue sequence"
  Assert-True ($resolvedDetail.result -notmatch "newer Exchange-verified") "Resolved wording must not make an invalid queue-sequence ordering claim"
  Assert-Equal 2 @($resolvedDetail.errorHistory).Count "A resolved terminal detail must preserve the full durable error history returned by the RPC"
  Assert-Equal "SC Display" $resolvedDetail.requestedBy "A resolved terminal audit row must preserve the requesting user's display name from the atomic RPC"
  Assert-True (@($resolvedDetail.fieldChanges) -contains "Display name: Atomic old -> Atomic current") "A resolved terminal detail must preserve exact audited before/after fields"
  Assert-Equal $atomicQueueRowId $resolvedDetail.supersededByQueueRowId "A resolved terminal detail must identify the queue row whose later processing verified the current FCUNO state"

  $resolvedOutcome = Get-IncrementalSyncOutcome $resolvedStats
  Assert-Equal "completed" $resolvedOutcome.Status "Safely resolved terminal rows must not be reported as actionable skips or failures"
  Send-ExchangeSyncNotification "completed" $resolvedOutcome.Message $resolvedStats ([pscustomobject]@{
    requestedBy = "SC"
    requestedByEmail = "sc@example.com"
    requestedAt = "2026-07-22T07:22:00Z"
  })
  Assert-True ($script:capturedResolvedSubject -match "1 terminal resolved") "The notice subject must state how many terminal failures were resolved"
  Assert-True ($script:capturedResolvedHtml -match "Resolved") "The notice must visibly label a superseded terminal row as resolved"
  Assert-True ($script:capturedResolvedHtml -match "Old terminal Exchange error") "The notice must show the exact prior terminal error"
  Assert-True ($script:capturedResolvedHtml -match "processing_failed") "The notice must show the durable queue error history"
  Assert-True ($script:capturedResolvedHtml -match $atomicQueueRowId) "The notice must show the superseding verified queue row ID"

  $certificationResult = Commit-FullExchangeQueueCertification "42@2026-07-22T07:15:00Z" "atomic-fingerprint"
  Assert-Equal 2 $script:certificationRpcCalls "An ambiguous full-certification response must retry against its durable certification receipt"
  Assert-True ([bool]$certificationResult.certified -and [bool]$certificationResult.idempotent) "A confirmed idempotent full-certification replay must count as success"
  Assert-Equal $script:certificationRpcBodies[0].run $script:certificationRpcBodies[1].run "Full-certification retry must reuse the exact same run UUID"
  Assert-Equal $script:certificationRpcBodies[0].sequence $script:certificationRpcBodies[1].sequence "Full-certification retry must reuse the exact same queue fence sequence"
  Assert-Equal $script:certificationRpcBodies[0].updatedAt $script:certificationRpcBodies[1].updatedAt "Full-certification retry must reuse the exact same queue fence timestamp"
  Assert-Equal $script:certificationRpcBodies[0].fingerprint $script:certificationRpcBodies[1].fingerprint "Full-certification retry must reuse the exact same source fingerprint"
  $fullResolvedStats = @{
    failedQueueRows = 0
    skippedQueueRows = 0
    resolvedTerminalQueueRows = 0
    fullCertificationCommitted = $false
    fullCertificationIdempotent = $false
    changeDetails = @()
  }
  $certificationCallsBeforeEligibleFinalize = $script:certificationRpcCalls
  Complete-FullExchangeQueueCertificationIfEligible $fullResolvedStats "42@2026-07-22T07:15:00Z" "atomic-fingerprint" @() | Out-Null
  Assert-Equal ($certificationCallsBeforeEligibleFinalize + 1) $script:certificationRpcCalls "A zero-failure, zero-drift final projection must invoke durable full certification"
  Assert-True ([bool]$fullResolvedStats.fullCertificationCommitted) "A confirmed full-certification replay must be recorded as durably committed"
  Assert-True ([bool]$fullResolvedStats.fullCertificationIdempotent) "A confirmed certification receipt replay must retain its idempotent status"
  Assert-Equal 1 $fullResolvedStats.resolvedTerminalQueueRows "A successful full certification must count every terminal queue row it superseded"
  Assert-Equal $script:CurrentQueueRunId @($fullResolvedStats.changeDetails)[0].supersededByFullRunId "A full-certification resolution detail must show the certifying run ID"
  Assert-True (@($fullResolvedStats.changeDetails)[0].result -match "Old terminal full-sync error") "A full-certification resolution detail must retain the exact previous terminal error"

  $certificationCallsBeforeIneligibleFinalize = $script:certificationRpcCalls
  Complete-FullExchangeQueueCertificationIfEligible @{ failedQueueRows = 1 } "42@2026-07-22T07:15:00Z" "atomic-fingerprint" @() | Out-Null
  Assert-Equal $certificationCallsBeforeIneligibleFinalize $script:certificationRpcCalls "Any local full-sync failure must prevent the terminal supersession sweep"
  Complete-FullExchangeQueueCertificationIfEligible @{ failedQueueRows = 0 } "42@2026-07-22T07:15:00Z" "atomic-fingerprint" @("queue high-water changed") | Out-Null
  Assert-Equal $certificationCallsBeforeIneligibleFinalize $script:certificationRpcCalls "Any source/high-water drift must prevent the terminal supersession sweep"
} finally {
  Set-Item Function:Invoke-SupabaseRest -Value $atomicOriginalInvokeSupabaseRest
  Set-Item Function:Get-OptionalAutomationSetting -Value $atomicOriginalGetOptionalAutomationSetting
  Set-Item Function:Send-ExchangeSmtpMail -Value $atomicOriginalSendExchangeSmtpMail
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
}

$originalRenewExchangeSyncLock = (Get-Item Function:Renew-ExchangeSyncLock).ScriptBlock
$script:testLeaseRenewals = 0
Set-Item Function:Renew-ExchangeSyncLock -Value {
  $script:testLeaseRenewals += 1
}
try {
  $script:SyncLockAcquired = $true
  $script:SyncLockLastRenewedAt = [DateTimeOffset]::UtcNow
  Renew-ExchangeSyncLockIfDue
  Assert-Equal 0 $script:testLeaseRenewals "A fresh mutation lease must not be renewed on every operation"
  $script:SyncLockLastRenewedAt = [DateTimeOffset]::UtcNow.Subtract([TimeSpan]::FromMinutes(6))
  Renew-ExchangeSyncLockIfDue
  Assert-Equal 1 $script:testLeaseRenewals "An elapsed mutation lease must renew before more Exchange work"
  Renew-ExchangeSyncLockIfDue
  Assert-Equal 1 $script:testLeaseRenewals "A successful elapsed-time renewal must reset the heartbeat interval"
} finally {
  Set-Item Function:Renew-ExchangeSyncLock -Value $originalRenewExchangeSyncLock
  $script:SyncLockAcquired = $false
  $script:SyncLockLastRenewedAt = [DateTimeOffset]::MinValue
}

$originalInvokeSupabaseRest = (Get-Item Function:Invoke-SupabaseRest).ScriptBlock
$script:testBacklogPage = 0
Set-Item Function:Invoke-SupabaseRest -Value {
  param($Method, $Path, $Body = $null)
  $script:testBacklogPage += 1
  if ($script:testBacklogPage -eq 1) {
    return @(1..1000 | ForEach-Object { [pscustomobject]@{ id = "row-$_" } })
  }
  return @([pscustomobject]@{ id = "row-1001" }, [pscustomobject]@{ id = "row-1002" })
}
try {
  Assert-Equal 1002 (Get-ExchangeQueueBacklogCount) "Queue backlog visibility must paginate beyond the first 1,000 unresolved rows"
Assert-Equal 2 $script:testBacklogPage "Queue backlog visibility must stop after the final partial page"
} finally {
  Set-Item Function:Invoke-SupabaseRest -Value $originalInvokeSupabaseRest
}

$script:CurrentQueueRunId = "99999999-9999-4999-8999-999999999999"
$fixedFailureTime = [DateTimeOffset]::Parse("2026-07-22T07:00:00Z")
$attemptTwoRow = [pscustomobject]@{
  attempts = 2
  error_history = @([pscustomobject]@{ type = "previous"; message = "Earlier error" })
}
$attemptTwoTransition = Get-ExchangeQueueFailureTransition $attemptTwoRow "Temporary Exchange error" $fixedFailureTime
Assert-True (-not [bool]$attemptTwoTransition.Terminal) "Attempt two must remain retryable"
Assert-Equal "2026-07-22T07:15:00.0000000+00:00" $attemptTwoTransition.NextAttemptAt "Attempt two must retry after exactly 15 minutes"
Assert-True ($null -eq $attemptTwoTransition.Fields.completed_at) "A retryable failure must not be marked terminally completed"
Assert-Equal 2 @($attemptTwoTransition.Fields.error_history).Count "A processing failure must append to prior error history"
Assert-Equal "processing_failed" @($attemptTwoTransition.Fields.error_history)[1].type "The appended history event must identify an ordinary processing failure"
Assert-Equal "99999999-9999-4999-8999-999999999999" @($attemptTwoTransition.Fields.error_history)[1].run_id "The failure event must retain the run ID"

$attemptThreeRow = [pscustomobject]@{ attempts = 3; error_history = @() }
$attemptThreeTransition = Get-ExchangeQueueFailureTransition $attemptThreeRow "Final Exchange error" $fixedFailureTime
Assert-True ([bool]$attemptThreeTransition.Terminal) "Attempt three must become terminal"
Assert-True ($null -eq $attemptThreeTransition.NextAttemptAt) "A terminal third failure must not fabricate another retry"
Assert-Equal "2026-07-22T07:00:00.0000000+00:00" $attemptThreeTransition.Fields.completed_at "A terminal third failure must record completion time"
Assert-True ($attemptThreeTransition.RetryState -match "retry limit exhausted") "Terminal failure wording must state that the retry limit was exhausted"
Assert-True ([bool]@($attemptThreeTransition.Fields.error_history)[0].terminal) "The third processing-failure history event must be terminal"

$processingBacklogId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
$terminalBacklogId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3"
$pendingBacklogId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc0"
$backlogStats = @{
  changeDetails = @([pscustomobject]@{
    queueRowId = $processingBacklogId
    status = "failed"
    result = "Error: PATCH failed. Retry scheduled for a time that was never persisted."
  })
}
$processingBacklogRow = [pscustomobject]@{
  id = $processingBacklogId
  status = "processing"
  attempts = 2
  run_id = "22222222-2222-4222-8222-222222222222"
  claimed_at = "2026-07-22T06:58:00Z"
  action = "update_contact"
  entity_type = "contact"
  entity_id = "processing-contact"
  entity_email = "processing@example.com"
  display_name = "Authoritative processing owner"
  created_at = "2026-07-22T06:00:00Z"
}
$terminalBacklogRow = [pscustomobject]@{
  id = $terminalBacklogId
  status = "failed"
  attempts = 3
  next_attempt_at = $null
  run_id = "33333333-3333-4333-8333-333333333333"
  error_message = "Processing lease expired; retry limit exhausted and terminally failed."
  action = "update_group"
  entity_type = "group"
  entity_id = "terminal-group"
  entity_alias = "terminal-group"
  display_name = "Terminal stale group"
  created_at = "2026-07-22T05:00:00Z"
}
$pendingBacklogRow = [pscustomobject]@{
  id = $pendingBacklogId
  status = "pending"
  attempts = 0
  next_attempt_at = $null
  action = "create_contact"
  entity_type = "contact"
  entity_id = "pending-contact"
  entity_email = "pending@example.com"
  display_name = "Pending contact"
  created_at = "2026-07-22T06:30:00Z"
}
Add-ExchangeQueueBacklogDetails $backlogStats @($processingBacklogRow, $terminalBacklogRow, $pendingBacklogRow)
Assert-Equal 3 @($backlogStats.changeDetails).Count "Backlog detail collection must deduplicate by queue row ID"
$authoritativeProcessingDetail = @($backlogStats.changeDetails | Where-Object { $_.queueRowId -eq $processingBacklogId })[0]
Assert-Equal "processing" $authoritativeProcessingDetail.status "An authoritative processing backlog row must override an unpersisted failed assumption"
Assert-Equal "22222222-2222-4222-8222-222222222222" $authoritativeProcessingDetail.runId "Backlog detail must show the authoritative processing owner"
Assert-True ($authoritativeProcessingDetail.result -notmatch "Retry state: Retry scheduled") "A failed PATCH must never claim that a retry was persisted"
$terminalBacklogDetail = @($backlogStats.changeDetails | Where-Object { $_.queueRowId -eq $terminalBacklogId })[0]
Assert-True ([bool]$terminalBacklogDetail.terminal) "A third-attempt stale row must render as terminal"
Assert-True ($terminalBacklogDetail.retryState -match "retry limit exhausted") "A terminal backlog detail must explain exhausted retries"
Assert-Equal "" $terminalBacklogDetail.nextRetryAt "A terminal backlog row must not fabricate a next retry time"
$pendingBacklogDetail = @($backlogStats.changeDetails | Where-Object { $_.queueRowId -eq $pendingBacklogId })[0]
Assert-Equal 0 $pendingBacklogDetail.attempt "A pending backlog row must preserve its exact zero-attempt count"
Assert-Equal "" $pendingBacklogDetail.nextRetryAt "A pending backlog row must not fabricate a next retry time"
Assert-Equal 1 $backlogStats.retryableBacklogRows "One pending row must be classified as retryable"
Assert-Equal 1 $backlogStats.terminalBacklogRows "One exhausted row must be classified as terminal"
Assert-Equal 1 $backlogStats.activeBacklogRows "One processing row must be classified as active"

$originalGetOptionalAutomationSetting = (Get-Item Function:Get-OptionalAutomationSetting).ScriptBlock
$originalSendExchangeSmtpMail = (Get-Item Function:Send-ExchangeSmtpMail).ScriptBlock
$script:capturedBacklogSubject = ""
$script:capturedBacklogHtml = ""
Set-Item Function:Get-OptionalAutomationSetting -Value { param($Name) return $null }
Set-Item Function:Send-ExchangeSmtpMail -Value {
  param($From, $To, $Subject, $Html)
  $script:capturedBacklogSubject = $Subject
  $script:capturedBacklogHtml = $Html
}
try {
  $emailBacklogDetails = @{
    syncMode = "incremental"
    queuedRows = 0
    processedQueueRows = 0
    completedQueueRows = 0
    failedQueueRows = 0
    backlogRows = 2
    retryableBacklogRows = 1
    terminalBacklogRows = 1
    activeBacklogRows = 0
    skippedQueueRows = 0
    supersededQueueRows = 0
    changeDetails = @($terminalBacklogDetail, $pendingBacklogDetail)
  }
  Send-ExchangeSyncNotification "failed" "Two unresolved rows remain." $emailBacklogDetails ([pscustomobject]@{
    requestedBy = "SC"
    requestedByEmail = "sc@example.com"
    requestedAt = "2026-07-22T07:00:00Z"
  })
  Assert-True ($script:capturedBacklogHtml -match "Queue change and backlog results") "A backlog notice must use a backlog-specific result title"
  Assert-True ($script:capturedBacklogHtml -match "Terminal stale group") "A backlog notice must name the terminal item"
  Assert-True ($script:capturedBacklogHtml -match $terminalBacklogId) "A backlog notice must show the exact queue row ID"
  Assert-True ($script:capturedBacklogHtml -match "retry limit exhausted") "A backlog notice must explain terminal retry exhaustion"
  Assert-True ($script:capturedBacklogHtml -match "Not attempted") "A pending zero-attempt row must be labelled as not attempted"
  Assert-True ($script:capturedBacklogHtml -notmatch "No pending changes") "A backlog notice must never claim there are no pending changes"
  Assert-True ($script:capturedBacklogHtml -notmatch "Next retry") "Terminal and pending rows without next_attempt_at must not fabricate next-retry metadata"

  $fullNoticeStats = @{
    syncMode = "full"
    contacts = 1
    groups = 0
    groupMembers = 0
    failedQueueRows = 0
    changeDetails = @()
    createdContacts = 1
    updatedContacts = 0
    removedContacts = 0
    createdGroups = 0
    updatedGroups = 0
    removedGroups = 0
    addedMembers = 0
    removedMembers = 0
  }
  Add-FullSyncMutationDetail `
    $fullNoticeStats `
    "Create contact" `
    "Contact" `
    "Full Notice Contact" `
    "full-notice@example.com" `
    "FCUNO_CONTACT:c-full-notice" `
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd" `
    "Create contact completed and the final Exchange contact/profile was verified." `
    @("Email: (missing) -> full-notice@example.com", "First name: (missing) -> Full")
  Send-ExchangeSyncNotification "completed" "Full Exchange reconciliation completed." $fullNoticeStats ([pscustomobject]@{
    requestedBy = "SC"
    requestedByEmail = "sc@example.com"
    requestedAt = "2026-07-22T07:10:00Z"
  })
  Assert-True ($script:capturedBacklogHtml -match "Full reconciliation results") "A full-run notice must use a full-reconciliation result title"
  Assert-True ($script:capturedBacklogHtml -match "Create contact") "A full-run notice must show each mutation action"
  Assert-True ($script:capturedBacklogHtml -match "Email: \(missing\) -&gt; full-notice@example.com") "A full-run notice must show exact before/after fields"
  Assert-True ($script:capturedBacklogHtml -match "FCUNO_CONTACT:c-full-notice") "A full-run notice must show the stable FCUNO identity"
  Assert-True ($script:capturedBacklogHtml -match "dddddddd-dddd-4ddd-8ddd-dddddddddddd") "A full-run notice must show the verified Exchange identity"
  Assert-True ($script:capturedBacklogHtml -notmatch "No Exchange mutations required") "A mutated full run must never use the zero-mutation fallback"
} finally {
  Set-Item Function:Get-OptionalAutomationSetting -Value $originalGetOptionalAutomationSetting
  Set-Item Function:Send-ExchangeSmtpMail -Value $originalSendExchangeSmtpMail
}

$backlogOutcome = Get-IncrementalSyncOutcome @{
  queuedRows = 0
  completedQueueRows = 0
  failedQueueRows = 0
  backlogRows = 3
  skippedQueueRows = 0
  supersededQueueRows = 0
}
Assert-Equal "failed" $backlogOutcome.Status "An unresolved unclaimable backlog must fail an incremental run"
Assert-True ([bool]$backlogOutcome.AlwaysNotify) "An unresolved backlog must notify even for a scheduled incremental run"
Assert-True ($backlogOutcome.Message -match "3 unresolved queue change") "The backlog failure must state the exact unresolved count"
$emptyOutcome = Get-IncrementalSyncOutcome @{
  queuedRows = 0
  completedQueueRows = 0
  failedQueueRows = 0
  backlogRows = 0
  skippedQueueRows = 0
  supersededQueueRows = 0
}
Assert-Equal "completed" $emptyOutcome.Status "A true zero-backlog incremental no-op must remain successful"
Assert-True (-not [bool]$emptyOutcome.AlwaysNotify) "A scheduled zero-backlog no-op must remain silent"

$fullLockMessage = "Full reconciliation was blocked by an active mutation lease."
$fullLockDetails = New-FullSyncLockFailureDetails $fullLockMessage
Assert-Equal 1 $fullLockDetails.failedQueueRows "A lock-denied full run must record one explicit certification failure"
Assert-True ((@($fullLockDetails.changeDetails | ForEach-Object { $_.result }) -join " ") -match "active mutation lease") "A lock-denied full run must preserve an informative failure detail for status and email"
$fullLockDenial = Get-ExchangeSyncLockDenial "full"
Assert-True ([bool]$fullLockDenial.Fatal) "A lock-denied full run must fail instead of appearing successfully skipped"
Assert-True ($fullLockDenial.Message -match "certification was not performed") "A lock-denied full run must explain that no certification occurred"
$incrementalLockDenial = Get-ExchangeSyncLockDenial "incremental"
Assert-True (-not [bool]$incrementalLockDenial.Fatal) "A lock-denied incremental run must preserve its non-destructive no-op behavior"
Assert-True ($incrementalLockDenial.Message -match "rows remain pending") "A lock-denied incremental run must explain that durable work remains queued"

$script:removeCalled = $false
$script:aliasLookupCalled = $false
function Get-MailContact {
  [CmdletBinding()]
  param($Filter, $ResultSize, $Identity)
  if ($Identity -eq "stale-alias") {
    $script:aliasLookupCalled = $true
    return [pscustomobject]@{
      Identity = "new-owner"
      DisplayName = "New Owner"
      ExternalEmailAddress = "new.owner@example.com"
      CustomAttribute1 = $ManagedMarker
      CustomAttribute2 = "FCUNO_CONTACT:c-new-owner"
    }
  }
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_CONTACT:c-old'") { return @() }
  if ($Filter -like "ExternalEmailAddress -eq 'dup@example.com'") {
    return [pscustomobject]@{
      Identity = "canonical"
      DisplayName = "Newest"
      ExternalEmailAddress = "dup@example.com"
      CustomAttribute1 = $ManagedMarker
      CustomAttribute2 = "FCUNO_CONTACT:c-new"
    }
  }
  if ($Filter -like "ExternalEmailAddress -eq 'wrongname@example.com'") {
    return [pscustomobject]@{
      Identity = "wrong-name"
      DisplayName = "Different Contact"
      ExternalEmailAddress = "wrongname@example.com"
      CustomAttribute1 = $ManagedMarker
      CustomAttribute2 = "FCUNO_CONTACT:different-owner"
    }
  }
  if ($Filter -like "ExternalEmailAddress -eq 'drifted-owner@example.com'") {
    return [pscustomobject]@{
      Identity = "drifted-owner"
      DisplayName = "Expected Drifted Contact"
      ExternalEmailAddress = "drifted-owner@example.com"
      CustomAttribute1 = ""
      CustomAttribute2 = "FCUNO_CONTACT:different-owner"
    }
  }
  return $null
}
function Remove-MailContact {
  [CmdletBinding(SupportsShouldProcess)]
  param($Identity)
  $script:removeCalled = $true
}
$guardStats = @{}
$guardFailedClosed = $false
try {
  Remove-ManagedExchangeMailContact "dup@example.com" "dup" $guardStats "c-old" "Older" $false
} catch {
  $guardFailedClosed = $_.Exception.Message -match "owned by source key"
}
Assert-True $guardFailedClosed "A duplicate delete must refuse an Exchange object owned by a different source ID"
Assert-True (-not $script:removeCalled) "Ownership mismatch must not call Remove-MailContact"

$script:removeCalled = $false
Remove-ManagedExchangeMailContact "stale@example.com" "stale-alias" $guardStats "" "Stale Contact" $true
Assert-True (-not $script:aliasLookupCalled) "An email cleanup must never fall back to an alias owned by another contact"
Assert-True (-not $script:removeCalled) "An absent stale email must be treated as already reconciled"

$script:removeCalled = $false
$wrongNameFailedClosed = $false
try {
  Remove-ManagedExchangeMailContact "wrongname@example.com" "" $guardStats "" "Expected Contact" $true
} catch {
  $wrongNameFailedClosed = $_.Exception.Message -match "exact email and display name"
}
Assert-True $wrongNameFailedClosed "An audit cleanup without a source key must match both email and display name"
Assert-True (-not $script:removeCalled) "An exact-identity mismatch must not call Remove-MailContact"

$script:removeCalled = $false
$driftedOwnerFailedClosed = $false
try {
  Remove-ManagedExchangeMailContact "drifted-owner@example.com" "" $guardStats "c-expected" "Expected Drifted Contact" $true
} catch {
  $driftedOwnerFailedClosed = $_.Exception.Message -match "owned by source key"
}
Assert-True $driftedOwnerFailedClosed "A contact source-key mismatch must fail closed even when its managed marker drifted"
Assert-True (-not $script:removeCalled) "A drifted-marker ownership mismatch must not call Remove-MailContact"

$script:CanonicalExchangeRows = @{
  Groups = @([pscustomobject]@{
    SourceGroupId = "g-new"
    Alias = "reused-group"
    GroupName = "Reused Group"
    SourceKey = "FCUNO_GROUP:g-new"
  })
}
$script:syncedGroupIds = @()
$script:recreatedGroupRemoved = $false
$script:aliasAlreadyCurrent = $false
$script:legacyMarkerWrongName = $false
function Load-SingleRow {
  param($Table, $Column, $Value)
  return $null
}
function Get-GroupExchangeRowsFromSource {
  param($GroupId)
  return $null
}
function Get-DistributionGroup {
  [CmdletBinding()]
  param($Filter, $ResultSize, $Identity)
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_GROUP:g-old'") {
    if ($script:recreatedGroupRemoved) { return $null }
    return [pscustomobject]@{
      Identity = "old-group"
      Guid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
      DistinguishedName = "CN=Old Reused Group,OU=Groups,DC=example,DC=com"
      DisplayName = "Reused Group"
      Alias = $(if ($script:aliasAlreadyCurrent) { "old-detached-alias" } else { "reused-group" })
      CustomAttribute1 = $ManagedMarker
      CustomAttribute2 = "FCUNO_GROUP:g-old"
    }
  }
  if ($Identity -eq "reused-group") {
    if ($script:aliasAlreadyCurrent) {
      return [pscustomobject]@{
        Identity = "new-group"
        Guid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"
        DistinguishedName = "CN=New Reused Group,OU=Groups,DC=example,DC=com"
        DisplayName = "Reused Group"
        Alias = "reused-group"
        CustomAttribute1 = $ManagedMarker
        CustomAttribute2 = "FCUNO_GROUP:g-new"
      }
    }
    if (-not $script:recreatedGroupRemoved) {
      return [pscustomobject]@{
        Identity = "old-group"
        DisplayName = "Reused Group"
        Alias = "reused-group"
        CustomAttribute1 = $ManagedMarker
        CustomAttribute2 = "FCUNO_GROUP:g-old"
      }
    }
  }
  if ($Identity -eq "legacy-alias" -and $script:legacyMarkerWrongName) {
    return [pscustomobject]@{
      Identity = "wrong-legacy-group"
      DisplayName = "Different Legacy Group"
      Alias = "legacy-alias"
      CustomAttribute1 = $ManagedMarker
      CustomAttribute2 = ""
    }
  }
  if ($Identity -eq "drifted-owner-alias") {
    return [pscustomobject]@{
      Identity = "drifted-owner-group"
      DisplayName = "Expected Drifted Group"
      Alias = "drifted-owner-alias"
      CustomAttribute1 = ""
      CustomAttribute2 = "FCUNO_GROUP:different-owner"
    }
  }
  return $null
}
function Remove-DistributionGroup {
  [CmdletBinding(SupportsShouldProcess)]
  param($Identity)
  $script:recreatedGroupRemoved = $true
}
function Sync-ExchangeGroupState {
  param($GroupId, $FallbackAlias, [hashtable]$Stats, $FallbackDisplayName = "", [bool]$AllowUntaggedExactDelete = $false)
  $script:syncedGroupIds += (Clean-Text $GroupId)
}
$recreatedGroupRow = [pscustomobject]@{
  entity_id = "g-old"
  entity_alias = "reused-group"
  audit_log_id = "62f00b1f-66ea-4495-ae13-61d5e65f214e"
  payload = [pscustomobject]@{
    beforeGroup = [pscustomobject]@{ name = "Reused Group"; nickname = "Reused Group" }
    userAuthorized = $true
  }
}
Sync-ExchangeGroupQueueState $recreatedGroupRow @{}
Assert-True $script:recreatedGroupRemoved "A tagged obsolete group owner must be removed before transferring its reused alias"
Assert-Equal "g-new" $script:syncedGroupIds[0] "A recreated current group must be upserted instead of deleting its reused alias"

$script:recreatedGroupRemoved = $false
$script:aliasAlreadyCurrent = $true
$script:syncedGroupIds = @()
Sync-ExchangeGroupQueueState $recreatedGroupRow @{}
Assert-True $script:recreatedGroupRemoved "A detached obsolete source-key group must be removed even when the shared alias already belongs to the current group"
Assert-Equal "g-new" $script:syncedGroupIds[0] "The current alias owner must remain synchronized after detached stale-owner cleanup"

$script:legacyMarkerWrongName = $true
$legacyMarkerFailedClosed = $false
try {
  Remove-ManagedExchangeDistributionGroup "legacy-alias" @{} "g-expected" "Expected Legacy Group" $true
} catch {
  $legacyMarkerFailedClosed = $_.Exception.Message -match "exact legacy alias and display name"
}
Assert-True $legacyMarkerFailedClosed "A marker-only legacy group must still match the exact audited alias and display name"

$script:recreatedGroupRemoved = $false
$driftedGroupOwnerFailedClosed = $false
try {
  Remove-ManagedExchangeDistributionGroup "drifted-owner-alias" @{} "g-expected" "Expected Drifted Group" $true
} catch {
  $driftedGroupOwnerFailedClosed = $_.Exception.Message -match "owned by source key"
}
Assert-True $driftedGroupOwnerFailedClosed "A group source-key mismatch must fail closed even when its managed marker drifted"
Assert-True (-not $script:recreatedGroupRemoved) "A drifted-marker ownership mismatch must not call Remove-DistributionGroup"

$desiredNoOpContact = [pscustomobject]@{
  DisplayName = "Unchanged Contact"
  ExternalEmailAddress = "unchanged@example.com"
  Alias = "unchanged-contact"
  FirstName = "Unchanged"
  LastName = "Contact"
  SourceKey = "FCUNO_CONTACT:c-unchanged"
  AllowedOwnerSourceKeys = @("FCUNO_CONTACT:c-unchanged")
}
$script:noOpMailContact = [pscustomobject]@{
  Identity = "unchanged-contact"
  Guid = "11111111-1111-1111-1111-111111111111"
  ExternalDirectoryObjectId = "external-unchanged-contact"
  DistinguishedName = "CN=Unchanged Contact,OU=Contacts,DC=example,DC=com"
  Name = "Unchanged Contact"
  DisplayName = "Unchanged Contact"
  ExternalEmailAddress = "SMTP:unchanged@example.com"
  Alias = "unchanged-contact"
  FirstName = "Untrusted"
  LastName = "MailContactFields"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_CONTACT:c-unchanged"
  HiddenFromAddressListsEnabled = $false
}
$script:noOpContactProfile = [pscustomobject]@{
  Identity = "CN=Unchanged Contact,OU=Contacts,DC=example,DC=com"
  Guid = "22222222-2222-2222-2222-222222222222"
  ExternalDirectoryObjectId = "profile-external-unchanged"
  DistinguishedName = "CN=Profile Unchanged Contact,OU=Contacts,DC=example,DC=com"
  FirstName = "Unchanged"
  LastName = "Contact"
}
$script:getMailContactCalls = 0
$script:setMailContactCalls = 0
$script:setContactCalls = 0
$script:setContactError = ""
$script:setContactFailed = $false
$script:rereadReplacementContact = $null
function Get-MailContact {
  [CmdletBinding()]
  param($Filter, $ResultSize, $Identity)
  $script:getMailContactCalls += 1
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_CONTACT:c-unchanged'") {
    if ($script:setContactFailed -and $script:rereadReplacementContact) { return $script:rereadReplacementContact }
    return $script:noOpMailContact
  }
  if ($Filter -like "ExternalEmailAddress -eq 'unchanged@example.com'") {
    return $script:noOpMailContact
  }
  return $null
}
function Get-Contact {
  [CmdletBinding()]
  param($Identity)
  if ($Identity -in @("unchanged-contact", "11111111-1111-1111-1111-111111111111", "CN=Unchanged Contact,OU=Contacts,DC=example,DC=com")) { return $script:noOpContactProfile }
  return $null
}
function Set-MailContact {
  [CmdletBinding()]
  param($Identity, $ExternalEmailAddress, $Alias, $CustomAttribute1, $CustomAttribute2, $HiddenFromAddressListsEnabled)
  $script:setMailContactCalls += 1
}
function Set-Contact {
  [CmdletBinding()]
  param($Identity, $Name, $DisplayName, $FirstName, $LastName)
  $script:setContactCalls += 1
  if ($script:setContactError) {
    $script:setContactFailed = $true
    throw $script:setContactError
  }
}
function New-MailContact {
  [CmdletBinding()]
  param($Name, $DisplayName, $ExternalEmailAddress, $Alias)
  throw "New-MailContact must not be called for an existing no-op contact."
}

$fullNoOpContactStats = @{}
$profileLookup = New-ExchangeContactProfileLookup @($script:noOpContactProfile)
$resolvedNoOpProfile = Resolve-ExchangeContactProfileHint $script:noOpMailContact $profileLookup
Assert-True ($null -ne $resolvedNoOpProfile) "A bulk profile must join across mail-contact DistinguishedName and profile Identity"
Upsert-ExchangeMailContact $desiredNoOpContact $fullNoOpContactStats $true $script:noOpMailContact $true $resolvedNoOpProfile
Assert-Equal 0 $script:getMailContactCalls "Full reconciliation must use its collision-checked contact hint without a per-contact read"
Assert-Equal 0 $script:setMailContactCalls "Full reconciliation must not rewrite an unchanged mail contact"
Assert-Equal 0 $script:setContactCalls "Full reconciliation must not rewrite an unchanged contact profile"
Assert-Equal 1 $fullNoOpContactStats.verifiedQueueRows "A skipped no-op contact must still complete exact verification"

$script:noOpContactProfile.FirstName = "Drifted"
Assert-True (-not (Test-ExchangeMailContactMatches $script:noOpMailContact $desiredNoOpContact $script:noOpContactProfile)) "A changed authoritative contact profile must not be treated as a no-op"
$script:noOpContactProfile.FirstName = "Unchanged"
Assert-True (Test-ExchangeMailContactMatches $script:noOpMailContact $desiredNoOpContact $script:noOpContactProfile) "Untrusted FirstName and LastName fields on Get-MailContact must not override the authoritative Get-Contact profile"
Assert-True (-not (Test-ExchangeMailContactMatches $script:noOpMailContact $desiredNoOpContact $null)) "An unresolved authoritative contact profile must not be treated as a no-op"
$markerOnlyDriftContact = [pscustomobject]@{}
foreach ($property in $script:noOpMailContact.PSObject.Properties) {
  $markerOnlyDriftContact | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
}
$markerOnlyDriftContact.CustomAttribute1 = ""
$markerOnlyChanges = @(Get-FullContactMutationFieldChanges $markerOnlyDriftContact $script:noOpContactProfile $desiredNoOpContact $false)
Assert-Equal 1 $markerOnlyChanges.Count "A marker-only full repair must report its exact Exchange correction"
Assert-Equal "Management marker: (blank) -> $ManagedMarker" $markerOnlyChanges[0] "A marker-only repair notice must identify the management marker before and after"

$ambiguousProfileLookup = New-ExchangeContactProfileLookup @(
  [pscustomobject]@{ Identity = "unchanged-contact"; FirstName = "Unchanged"; LastName = "Contact" },
  [pscustomobject]@{ Identity = "11111111-1111-1111-1111-111111111111"; FirstName = "Unchanged"; LastName = "Contact" }
)
$ambiguousProfileFailedClosed = $false
try {
  Resolve-ExchangeContactProfileHint $script:noOpMailContact $ambiguousProfileLookup | Out-Null
} catch {
  $ambiguousProfileFailedClosed = $_.Exception.Message -match "More than one Exchange contact profile"
}
Assert-True $ambiguousProfileFailedClosed "An ambiguous bulk contact-profile join must fail closed"

$duplicateMailContact = [pscustomobject]@{
  Identity = "duplicate-contact"
  Name = "Duplicate Contact"
  DisplayName = "Duplicate Contact"
  ExternalEmailAddress = "duplicate@example.com"
  Alias = "duplicate-contact"
  FirstName = "Duplicate"
  LastName = "Contact"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_CONTACT:c-unchanged"
  HiddenFromAddressListsEnabled = $false
}
$duplicateContactLookup = New-ExchangeMailContactLookup @($script:noOpMailContact, $duplicateMailContact)
$duplicateContactFailedClosed = $false
try {
  Resolve-ExchangeMailContactHint $desiredNoOpContact $duplicateContactLookup | Out-Null
} catch {
  $duplicateContactFailedClosed = $_.Exception.Message -match "More than one Exchange contact is tagged"
}
Assert-True $duplicateContactFailedClosed "A bulk contact snapshot must fail closed when an immutable source key is duplicated"

$foreignEmailOwner = [pscustomobject]@{
  Identity = "foreign-owner"
  ExternalEmailAddress = "unchanged@example.com"
  CustomAttribute2 = "FCUNO_CONTACT:c-foreign"
}
$foreignOwnerLookup = New-ExchangeMailContactLookup @($foreignEmailOwner)
$foreignOwnerFailedClosed = $false
try {
  Resolve-ExchangeMailContactHint $desiredNoOpContact $foreignOwnerLookup | Out-Null
} catch {
  $foreignOwnerFailedClosed = $_.Exception.Message -match "ownership was not transferred"
}
Assert-True $foreignOwnerFailedClosed "A bulk email fallback must not transfer an unrelated immutable source owner"

$legitimateDuplicateContact = [pscustomobject]@{
  DisplayName = "Newest"
  ExternalEmailAddress = "dup@example.com"
  Alias = "dup"
  FirstName = "New"
  LastName = "Owner"
  SourceKey = "FCUNO_CONTACT:c-new"
  AllowedOwnerSourceKeys = @("FCUNO_CONTACT:c-new", "FCUNO_CONTACT:c-old")
}
$oldDuplicateOwner = [pscustomobject]@{
  Identity = "old-duplicate-owner"
  ExternalEmailAddress = "dup@example.com"
  CustomAttribute2 = "FCUNO_CONTACT:c-old"
}
$resolvedDuplicateOwner = Resolve-ExchangeMailContactHint $legitimateDuplicateContact (New-ExchangeMailContactLookup @($oldDuplicateOwner))
Assert-Equal "old-duplicate-owner" $resolvedDuplicateOwner.Identity "A canonical duplicate may adopt the prior owner recorded for the same FCUNO email"

$desiredSourceObject = [pscustomobject]@{
  Identity = "source-object"
  ExternalEmailAddress = "old-address@example.com"
  CustomAttribute2 = "FCUNO_CONTACT:c-unchanged"
}
$desiredEmailObject = [pscustomobject]@{
  Identity = "email-object"
  ExternalEmailAddress = "unchanged@example.com"
  CustomAttribute2 = ""
}
$splitCandidateFailedClosed = $false
try {
  Resolve-ExchangeMailContactHint $desiredNoOpContact (New-ExchangeMailContactLookup @($desiredSourceObject, $desiredEmailObject)) | Out-Null
} catch {
  $splitCandidateFailedClosed = $_.Exception.Message -match "resolve to different contact objects"
}
Assert-True $splitCandidateFailedClosed "A bulk source-key/email split must fail closed without mutating either contact"

$script:getMailContactCalls = 0
$script:setMailContactCalls = 0
$script:setContactCalls = 0
$collisionPeerContactStats = @{}
Upsert-ExchangeMailContact $desiredNoOpContact $collisionPeerContactStats $true
Assert-Equal 2 $script:getMailContactCalls "An unchanged alias-collision contact peer may use live ownership reads"
Assert-Equal 0 $script:setMailContactCalls "An unchanged alias-collision contact peer must not rewrite mail-contact metadata"
Assert-Equal 0 $script:setContactCalls "An unchanged alias-collision contact peer must not rewrite its authoritative profile"
Assert-Equal 0 ([int]$collisionPeerContactStats.updatedContacts) "An unchanged alias-collision contact peer must not increment updates"

$script:getMailContactCalls = 0
$script:setMailContactCalls = 0
$script:setContactCalls = 0
$incrementalContactStats = @{}
Upsert-ExchangeMailContact $desiredNoOpContact $incrementalContactStats
Assert-Equal 3 $script:getMailContactCalls "Incremental contact processing must check both immutable ownership candidates and verify the result"
Assert-Equal 1 $script:setMailContactCalls "Incremental contact processing must retain its existing upsert behavior"
Assert-Equal 1 $script:setContactCalls "Incremental contact processing must retain its existing profile update behavior"
Assert-Equal 1 $incrementalContactStats.updatedContacts "Incremental contact processing must still report its update"

$script:setContactError = "The server is busy and the request was throttled."
$script:removeCalled = $false
$transientProfileFailed = $false
try {
  Upsert-ExchangeMailContact $desiredNoOpContact @{}
} catch {
  $transientProfileFailed = $_.Exception.Message -match "throttled"
}
Assert-True $transientProfileFailed "A transient Set-Contact failure must propagate for durable retry"
Assert-True (-not $script:removeCalled) "A transient Set-Contact failure must never delete a valid managed contact"
$script:setContactError = ""

$replacementAfterUpdateError = [pscustomobject]@{
  Identity = "unchanged-contact"
  Guid = "99999999-9999-4999-8999-999999999999"
  ExternalDirectoryObjectId = "replacement-external-contact"
  DistinguishedName = "CN=Replacement Contact,OU=Contacts,DC=example,DC=com"
  Name = "Unchanged Contact"
  DisplayName = "Unchanged Contact"
  ExternalEmailAddress = "SMTP:unchanged@example.com"
  Alias = "unchanged-contact"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_CONTACT:c-unchanged"
  HiddenFromAddressListsEnabled = $false
}
$script:setContactFailed = $false
$script:rereadReplacementContact = $replacementAfterUpdateError
$script:setContactError = "Invalid recipient object"
$script:removeCalled = $false
$replacementRaceFailedClosed = $false
try {
  Upsert-ExchangeMailContact $desiredNoOpContact @{}
} catch {
  $replacementRaceFailedClosed = $_.Exception.Message -match "source-key ownership changed"
}
Assert-True $replacementRaceFailedClosed "An update/recreate race must fail closed when the same mutable alias/source key now resolves to a different immutable contact"
Assert-True (-not $script:removeCalled) "A replacement contact must never be deleted after an update/recreate race"
$script:setContactError = ""
$script:setContactFailed = $false
$script:rereadReplacementContact = $null

$identitylessContact = [pscustomobject]@{
  Identity = "unchanged-contact"
  Name = "Unchanged Contact"
  DisplayName = "Unchanged Contact"
  ExternalEmailAddress = "SMTP:unchanged@example.com"
  Alias = "unchanged-contact"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_CONTACT:c-unchanged"
  HiddenFromAddressListsEnabled = $false
}
$contactSetBaseline = $script:setMailContactCalls
$identitylessContactFailedClosed = $false
try {
  Upsert-ExchangeMailContact $desiredNoOpContact @{} $false $identitylessContact $true
} catch {
  $identitylessContactFailedClosed = $_.Exception.Message -match "no immutable identity"
}
Assert-True $identitylessContactFailedClosed "An existing contact without a strong Exchange identity must fail before profile or marker mutation"
Assert-Equal $contactSetBaseline $script:setMailContactCalls "An identityless existing contact must not be retagged through its mutable alias"

$desiredNoOpGroup = [pscustomobject]@{
  SourceGroupId = "g-unchanged"
  GroupName = "Unchanged Group"
  Alias = "unchanged-group"
  Description = "Current description"
  SourceKey = "FCUNO_GROUP:g-unchanged"
}
$script:noOpDistributionGroup = [pscustomobject]@{
  Identity = "unchanged-group"
  Guid = "33333333-3333-4333-8333-333333333333"
  ExternalDirectoryObjectId = "external-unchanged-group"
  DistinguishedName = "CN=Unchanged Group,OU=Groups,DC=example,DC=com"
  Name = "Unchanged Group"
  DisplayName = "Unchanged Group"
  Alias = "unchanged-group"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_GROUP:g-unchanged"
  HiddenFromAddressListsEnabled = $false
}
$script:noOpGroupProfile = [pscustomobject]@{
  Identity = "CN=Unchanged Group,OU=Groups,DC=example,DC=com"
  Guid = "33333333-3333-4333-8333-333333333333"
  ExternalDirectoryObjectId = "external-unchanged-group"
  DistinguishedName = "CN=Unchanged Group,OU=Groups,DC=example,DC=com"
  Notes = "Current description"
}
$script:getDistributionGroupCalls = 0
$script:getGroupCalls = 0
$script:staleGroupProfileReads = 0
$script:setDistributionGroupCalls = 0
$script:setGroupCalls = 0
$script:newDistributionGroupCalls = 0
$script:newDistributionGroup = $null
$script:newGroupProfile = $null
$script:membershipResolvedGroup = $null
function Get-DistributionGroup {
  [CmdletBinding()]
  param($Filter, $ResultSize, $Identity)
  $script:getDistributionGroupCalls += 1
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_GROUP:g-unchanged'" -and $script:membershipResolvedGroup) {
    return $script:membershipResolvedGroup
  }
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_GROUP:g-unchanged'" -or $Identity -eq "unchanged-group") {
    return $script:noOpDistributionGroup
  }
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_GROUP:g-new'" -and $script:newDistributionGroup) {
    return $script:newDistributionGroup
  }
  return $null
}
function Get-Group {
  [CmdletBinding()]
  param($ResultSize, $Identity)
  $script:getGroupCalls += 1
  if (-not $Identity) {
    return @($script:noOpGroupProfile, $script:newGroupProfile | Where-Object { $null -ne $_ })
  }
  if ($Identity -in @("unchanged-group", "33333333-3333-4333-8333-333333333333", "CN=Unchanged Group,OU=Groups,DC=example,DC=com")) {
    if ($script:staleGroupProfileReads -gt 0) {
      $script:staleGroupProfileReads -= 1
      return [pscustomobject]@{
        Identity = $script:noOpGroupProfile.Identity
        Guid = $script:noOpGroupProfile.Guid
        ExternalDirectoryObjectId = $script:noOpGroupProfile.ExternalDirectoryObjectId
        DistinguishedName = $script:noOpGroupProfile.DistinguishedName
        Notes = "Eventually consistent old description"
      }
    }
    return $script:noOpGroupProfile
  }
  if ($script:newGroupProfile -and $Identity -in @("new-group", "44444444-4444-4444-8444-444444444444")) {
    return $script:newGroupProfile
  }
  return $null
}
function Set-DistributionGroup {
  [CmdletBinding()]
  param($Identity, $Alias, $Name, $DisplayName, $Notes, $CustomAttribute1, $CustomAttribute2, $HiddenFromAddressListsEnabled)
  $script:setDistributionGroupCalls += 1
  if ($Identity -in @("new-group", "44444444-4444-4444-8444-444444444444")) {
    $script:newDistributionGroup.CustomAttribute1 = $CustomAttribute1
    $script:newDistributionGroup.CustomAttribute2 = $CustomAttribute2
    $script:newDistributionGroup.HiddenFromAddressListsEnabled = [bool]$HiddenFromAddressListsEnabled
  }
}
function Set-Group {
  [CmdletBinding()]
  param($Identity, $Notes)
  $script:setGroupCalls += 1
  if ($Identity -in @("new-group", "44444444-4444-4444-8444-444444444444")) { $script:newGroupProfile.Notes = $Notes }
  if ($Identity -in @("unchanged-group", "33333333-3333-4333-8333-333333333333")) { $script:noOpGroupProfile.Notes = $Notes }
}
function New-DistributionGroup {
  [CmdletBinding()]
  param($Name, $Alias)
  if ($Alias -eq "new-group") {
    $script:newDistributionGroupCalls += 1
    $script:newDistributionGroup = [pscustomobject]@{
      Identity = "new-group"
      Guid = "44444444-4444-4444-8444-444444444444"
      ExternalDirectoryObjectId = "external-new-group"
      DistinguishedName = "CN=New Group,OU=Groups,DC=example,DC=com"
      Name = $Name
      DisplayName = $Name
      Alias = $Alias
      CustomAttribute1 = ""
      CustomAttribute2 = ""
      HiddenFromAddressListsEnabled = $false
    }
    $script:newGroupProfile = [pscustomobject]@{
      Identity = "CN=New Group,OU=Groups,DC=example,DC=com"
      Guid = "44444444-4444-4444-8444-444444444444"
      ExternalDirectoryObjectId = "external-new-group"
      DistinguishedName = "CN=New Group,OU=Groups,DC=example,DC=com"
      Notes = ""
    }
    return $script:newDistributionGroup
  }
  throw "New-DistributionGroup must not be called for an existing no-op group."
}

$fullNoOpGroupStats = @{}
$groupProfileLookup = New-ExchangeGroupProfileLookup @($script:noOpGroupProfile)
$resolvedNoOpGroupProfile = Resolve-ExchangeGroupProfileHint $script:noOpDistributionGroup $groupProfileLookup
Assert-True ($null -ne $resolvedNoOpGroupProfile) "A bulk group profile must join through immutable Exchange identity"
$mutableOnlyGroupProfile = [pscustomobject]@{ Identity = "unchanged-group"; Notes = "Current description" }
Assert-True ($null -eq (Resolve-ExchangeGroupProfileHint $script:noOpDistributionGroup (New-ExchangeGroupProfileLookup @($mutableOnlyGroupProfile)))) "A mutable group Identity value alone must never authorize a Notes-profile join"
$ambiguousGroupProfileLookup = New-ExchangeGroupProfileLookup @(
  [pscustomobject]@{ Guid = "33333333-3333-4333-8333-333333333333"; Notes = "Current description" },
  [pscustomobject]@{ ExternalDirectoryObjectId = "external-unchanged-group"; Notes = "Current description" }
)
$ambiguousGroupProfileFailedClosed = $false
try {
  Resolve-ExchangeGroupProfileHint $script:noOpDistributionGroup $ambiguousGroupProfileLookup | Out-Null
} catch {
  $ambiguousGroupProfileFailedClosed = $_.Exception.Message -match "More than one authoritative Exchange group profile"
}
Assert-True $ambiguousGroupProfileFailedClosed "Two distinct strong group-profile matches must fail closed"
Upsert-ExchangeDistributionGroup $desiredNoOpGroup $fullNoOpGroupStats $true $script:noOpDistributionGroup $true $resolvedNoOpGroupProfile
Assert-Equal 0 $script:getDistributionGroupCalls "Full reconciliation must use its collision-checked group hint without a per-group read"
Assert-Equal 0 $script:getGroupCalls "Full reconciliation must use its bulk authoritative group profile without a per-group read"
Assert-Equal 0 $script:setDistributionGroupCalls "Full reconciliation must not rewrite an unchanged distribution group"
Assert-Equal 0 $script:setGroupCalls "Full reconciliation must not rewrite unchanged group notes"
Assert-Equal 1 $fullNoOpGroupStats.verifiedQueueRows "A skipped no-op group must still complete exact verification"

$changedDescriptionGroup = [pscustomobject]@{
  GroupName = "Unchanged Group"
  Alias = "unchanged-group"
  Description = "Changed description"
  SourceKey = "FCUNO_GROUP:g-unchanged"
}
Assert-True (-not (Test-ExchangeDistributionGroupMatches $script:noOpDistributionGroup $changedDescriptionGroup $script:noOpGroupProfile)) "A changed authoritative group description must not be treated as a no-op"
Assert-True (-not (Test-ExchangeDistributionGroupMatches $script:noOpDistributionGroup $desiredNoOpGroup $null)) "An unresolved authoritative group profile must fail closed"

$duplicateAliasGroup = [pscustomobject]@{
  Identity = "duplicate-alias-group"
  Name = "Unchanged Group"
  DisplayName = "Unchanged Group"
  Alias = "unchanged-group"
  Notes = "Current description"
  CustomAttribute1 = ""
  CustomAttribute2 = ""
  HiddenFromAddressListsEnabled = $false
}
$legacyAliasGroup = [pscustomobject]@{
  Identity = "legacy-alias-group"
  Name = "Unchanged Group"
  DisplayName = "Unchanged Group"
  Alias = "unchanged-group"
  Notes = "Current description"
  CustomAttribute1 = ""
  CustomAttribute2 = ""
  HiddenFromAddressListsEnabled = $false
}
$duplicateAliasLookup = New-ExchangeDistributionGroupLookup @($duplicateAliasGroup, $legacyAliasGroup)
$duplicateAliasFailedClosed = $false
try {
  Resolve-ExchangeDistributionGroupHint $desiredNoOpGroup $duplicateAliasLookup | Out-Null
} catch {
  $duplicateAliasFailedClosed = $_.Exception.Message -match "More than one Exchange group uses alias"
}
Assert-True $duplicateAliasFailedClosed "A bulk group snapshot must fail closed when an alias resolves to multiple groups"

$foreignSameNameGroup = [pscustomobject]@{
  Identity = "user-managed-same-name"
  Guid = "55555555-5555-4555-8555-555555555555"
  Name = "Unchanged Group"
  DisplayName = "Unchanged Group"
  Alias = "different-user-alias"
  CustomAttribute1 = ""
  CustomAttribute2 = ""
}
$sameNameResolution = Resolve-ExchangeDistributionGroupHint $desiredNoOpGroup (New-ExchangeDistributionGroupLookup @($foreignSameNameGroup))
Assert-True ($null -eq $sameNameResolution) "An untagged group with the same display name but a different alias must never be adopted or retagged"

$script:getDistributionGroupCalls = 0
$script:getGroupCalls = 0
$script:setDistributionGroupCalls = 0
$script:setGroupCalls = 0
$collisionPeerGroupStats = @{}
Upsert-ExchangeDistributionGroup $desiredNoOpGroup $collisionPeerGroupStats $true
Assert-Equal 1 $script:getDistributionGroupCalls "An unchanged alias-collision group peer may use one live source-owner read"
Assert-Equal 1 $script:getGroupCalls "An unchanged alias-collision group peer must read authoritative Notes through Get-Group"
Assert-Equal 0 $script:setDistributionGroupCalls "An unchanged alias-collision group peer must not rewrite distribution metadata"
Assert-Equal 0 $script:setGroupCalls "An unchanged alias-collision group peer must not rewrite Notes"
Assert-Equal 0 ([int]$collisionPeerGroupStats.updatedGroups) "An unchanged alias-collision group peer must not increment updates"

$script:getDistributionGroupCalls = 0
$script:getGroupCalls = 0
$script:setDistributionGroupCalls = 0
$script:setGroupCalls = 0
$incrementalGroupStats = @{}
Upsert-ExchangeDistributionGroup $desiredNoOpGroup $incrementalGroupStats
Assert-Equal 2 $script:getDistributionGroupCalls "Incremental group processing must retain its live lookup and verification reads"
Assert-Equal 1 $script:getGroupCalls "Incremental group verification must read Notes from Get-Group"
Assert-Equal 1 $script:setDistributionGroupCalls "Incremental group processing must retain its existing upsert behavior"
Assert-Equal 1 $script:setGroupCalls "Incremental group processing must update Notes through Set-Group"
Assert-Equal 1 $incrementalGroupStats.updatedGroups "Incremental group processing must still report its update"

$script:getDistributionGroupCalls = 0
$script:getGroupCalls = 0
$script:staleGroupProfileReads = 2
Set-Item Function:Start-Sleep -Value { param($Seconds) }
try {
  $eventualGroupStats = @{}
  Upsert-ExchangeDistributionGroup $desiredNoOpGroup $eventualGroupStats
  Assert-Equal 4 $script:getDistributionGroupCalls "Group verification must retry fresh distribution metadata until eventual consistency settles"
  Assert-Equal 3 $script:getGroupCalls "Group verification must retry authoritative Get-Group Notes until they settle"
  Assert-Equal 1 $eventualGroupStats.verifiedQueueRows "Eventually consistent group Notes must be accepted only after an exact fresh verification"
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
  $script:staleGroupProfileReads = 0
}

$newDesiredGroup = [pscustomobject]@{
  SourceGroupId = "g-new"
  GroupName = "New Group"
  Alias = "new-group"
  Description = "New group notes"
  SourceKey = "FCUNO_GROUP:g-new"
}
$newGroupStats = @{}
Upsert-ExchangeDistributionGroup $newDesiredGroup $newGroupStats
Assert-Equal 1 $script:newDistributionGroupCalls "A missing distribution group must still be created"
Assert-Equal "New group notes" $script:newGroupProfile.Notes "A new distribution group must receive authoritative Notes through Set-Group"
Assert-Equal 1 $newGroupStats.createdGroups "A new distribution group must be reported as created"

$identitylessGroup = [pscustomobject]@{
  Identity = "unchanged-group"
  Name = "Unchanged Group"
  DisplayName = "Unchanged Group"
  Alias = "unchanged-group"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_GROUP:g-unchanged"
  HiddenFromAddressListsEnabled = $false
}
$groupSetBaseline = $script:setDistributionGroupCalls
$identitylessGroupFailedClosed = $false
try {
  Upsert-ExchangeDistributionGroup $desiredNoOpGroup @{} $false $identitylessGroup $true
} catch {
  $identitylessGroupFailedClosed = $_.Exception.Message -match "no immutable identity"
}
Assert-True $identitylessGroupFailedClosed "An existing group without a strong Exchange identity must fail before metadata or Notes mutation"
Assert-Equal $groupSetBaseline $script:setDistributionGroupCalls "An identityless existing group must not be retagged through its mutable alias"

$finalProjectionRows = @{
  Contacts = @($desiredNoOpContact)
  Groups = @($desiredNoOpGroup)
  Members = @()
}
$exactFinalStats = @{ failedQueueRows = 0; changeDetails = @() }
Confirm-FinalExchangeProjection $finalProjectionRows @($script:noOpMailContact) @($script:noOpContactProfile) @($script:noOpDistributionGroup) @($script:noOpGroupProfile) $exactFinalStats
Assert-Equal 0 $exactFinalStats.failedQueueRows "Fresh final certification must accept exact contact, profile, and group metadata"

$script:noOpContactProfile.FirstName = "Stale First Name"
$driftedFinalStats = @{ failedQueueRows = 0; changeDetails = @() }
Confirm-FinalExchangeProjection $finalProjectionRows @($script:noOpMailContact) @($script:noOpContactProfile) @($script:noOpDistributionGroup) @($script:noOpGroupProfile) $driftedFinalStats
Assert-True ([int]$driftedFinalStats.failedQueueRows -gt 0) "Fresh final certification must reject a drifted authoritative contact profile"
Assert-True ((@($driftedFinalStats.changeDetails | ForEach-Object { $_.result }) -join " ") -match "first name") "Fresh final certification must identify the drifted profile field"
$script:noOpContactProfile.FirstName = "Unchanged"

$script:noOpGroupProfile.Notes = "Stale description"
$driftedGroupFinalStats = @{ failedQueueRows = 0; changeDetails = @() }
Confirm-FinalExchangeProjection $finalProjectionRows @($script:noOpMailContact) @($script:noOpContactProfile) @($script:noOpDistributionGroup) @($script:noOpGroupProfile) $driftedGroupFinalStats
Assert-True ([int]$driftedGroupFinalStats.failedQueueRows -gt 0) "Fresh final certification must reject drifted authoritative group Notes"
Assert-True ((@($driftedGroupFinalStats.changeDetails | ForEach-Object { $_.result }) -join " ") -match "description") "Fresh final certification must identify drifted group description"
$script:noOpGroupProfile.Notes = "Current description"

$script:removeCalled = $false
$invalidManagedContact = [pscustomobject]@{
  Identity = "managed-now-invalid"
  DisplayName = "Managed now invalid"
  ExternalEmailAddress = "formerly-valid@example.com"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_CONTACT:c-now-invalid"
}
$invalidProtectionRows = @{
  Contacts = @()
  InvalidContacts = @([pscustomobject]@{
    SourceContactId = "c-now-invalid"
    DisplayName = "Managed now invalid"
    Email = "NOT AN EMAIL"
    Reason = "Invalid external email address"
  })
}
$invalidProtectionStats = @{ removedContacts = 0; preservedInvalidContacts = 0; failedQueueRows = 0; changeDetails = @() }
Remove-StaleManagedExchangeContacts @($invalidManagedContact) $invalidProtectionRows $invalidProtectionStats
Assert-True (-not $script:removeCalled) "A managed Exchange contact whose FCUNO source became invalid must be preserved, never stale-deleted"
Assert-Equal 1 $invalidProtectionStats.preservedInvalidContacts "A preserved invalid-source contact must be counted for the notice"
Assert-Equal 0 $invalidProtectionStats.removedContacts "Invalid-source preservation must report zero removals"

$desiredNoOpGroupMembers = @(
  [pscustomobject]@{ MemberEmail = "existing@example.com" },
  [pscustomobject]@{ MemberEmail = "missing@example.com" }
)
$script:memberState = @{
  "existing@example.com" = $true
  "unexpected@example.com" = $true
}
$script:attemptedMemberAdds = @()
$script:removedMemberEmails = @()
$script:memberReadGroupIdentities = @()
$script:memberMutationGroupIdentities = @()
$script:getDistributionGroupMemberCalls = 0
$script:forceMembershipVerificationFailure = $false
$script:duplicateUnexpectedMemberSnapshot = $false
function Get-DistributionGroupMember {
  [CmdletBinding()]
  param($Identity, $ResultSize)
  $script:getDistributionGroupMemberCalls += 1
  $script:memberReadGroupIdentities += (Clean-Text $Identity)
  if ($script:duplicateUnexpectedMemberSnapshot) {
    return @(
      [pscustomobject]@{ Identity = "Display Member One"; ExternalEmailAddress = "unexpected@example.com" },
      [pscustomobject]@{ Identity = "Display Member Two"; ExternalEmailAddress = "unexpected@example.com" }
    )
  }
  $emails = @($script:memberState.Keys | Sort-Object)
  if ($script:forceMembershipVerificationFailure -and $script:getDistributionGroupMemberCalls -gt 1) {
    $emails = @($emails | Where-Object { $_ -ne "missing@example.com" })
  }
  return @($emails | ForEach-Object {
    [pscustomobject]@{ Identity = $_; ExternalEmailAddress = $_ }
  })
}
function Add-DistributionGroupMember {
  [CmdletBinding()]
  param($Identity, $Member)
  $script:memberMutationGroupIdentities += (Clean-Text $Identity)
  $email = Normalize-Email $Member
  $script:attemptedMemberAdds += $email
  if (Has-MapKey $script:memberState $email) { throw "$email is already a member" }
  $script:memberState[$email] = $true
}
function Remove-DistributionGroupMember {
  [CmdletBinding(SupportsShouldProcess)]
  param($Identity, $Member)
  $script:memberMutationGroupIdentities += (Clean-Text $Identity)
  $email = Normalize-Email $Member
  $script:removedMemberEmails += $email
  $script:memberState.Remove($email)
}

$script:memberState = @{
  "existing@example.com" = $true
  "missing@example.com" = $true
}
$script:memberReadGroupIdentities = @()
$script:memberMutationGroupIdentities = @()
$fullExactMemberStats = @{}
Sync-ExchangeGroupMembers $desiredNoOpGroup $desiredNoOpGroupMembers $fullExactMemberStats $true $script:noOpDistributionGroup $true
Assert-Equal 1 $script:getDistributionGroupMemberCalls "An exact full-sync membership snapshot must be accepted without a second read"
Assert-Equal 0 @($script:attemptedMemberAdds).Count "An exact full-sync membership snapshot must not attempt any member add"
Assert-Equal 0 @($script:removedMemberEmails).Count "An exact full-sync membership snapshot must not attempt any member removal"
Assert-Equal $script:noOpDistributionGroup.Guid $script:memberReadGroupIdentities[0] "Membership reads must use the freshly resolved immutable group identity, never the mutable alias"

$script:memberState = @{
  "existing@example.com" = $true
  "unexpected@example.com" = $true
}
$script:attemptedMemberAdds = @()
$script:removedMemberEmails = @()
$script:getDistributionGroupMemberCalls = 0
$script:memberReadGroupIdentities = @()
$script:memberMutationGroupIdentities = @()
$fullMemberStats = @{}
Sync-ExchangeGroupMembers $desiredNoOpGroup $desiredNoOpGroupMembers $fullMemberStats $true $script:noOpDistributionGroup $true
Assert-Equal 2 $script:getDistributionGroupMemberCalls "A changed full-sync membership must be read initially and verified after mutation"
Assert-Equal 1 @($script:attemptedMemberAdds).Count "Full reconciliation must add only missing group members"
Assert-Equal "missing@example.com" $script:attemptedMemberAdds[0] "Full reconciliation must not re-add an existing member"
Assert-Equal 1 $fullMemberStats.addedMembers "Only the missing member must be counted as added"
Assert-Equal "unexpected@example.com" $script:removedMemberEmails[0] "Unexpected members must still be removed"
Assert-True (@($script:memberMutationGroupIdentities | Where-Object { $_ -ne $script:noOpDistributionGroup.Guid }).Count -eq 0) "Every membership add/remove must target the immutable group identity"

$raceResolvedGroup = [pscustomobject]@{
  Identity = "mutable-alias-now-points-elsewhere"
  Guid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  DistinguishedName = "CN=Source-Key Resolved Group,OU=Groups,DC=example,DC=com"
  Name = "Unchanged Group"
  DisplayName = "Unchanged Group"
  Alias = "source-key-resolved-group"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_GROUP:g-unchanged"
  HiddenFromAddressListsEnabled = $false
}
$script:membershipResolvedGroup = $raceResolvedGroup
$script:memberState = @{
  "existing@example.com" = $true
  "missing@example.com" = $true
}
$script:getDistributionGroupMemberCalls = 0
$script:memberReadGroupIdentities = @()
Sync-ExchangeGroupMembers $desiredNoOpGroup $desiredNoOpGroupMembers @{} $true $script:noOpDistributionGroup $true $script:noOpGroupProfile
Assert-Equal $raceResolvedGroup.Guid $script:memberReadGroupIdentities[0] "An alias/source-key race must bind membership reads to the one freshly source-key-resolved immutable group"
$script:membershipResolvedGroup = $null

$script:duplicateUnexpectedMemberSnapshot = $true
$script:removedMemberEmails = @()
$unprovableMemberRemovalFailedClosed = $false
try {
  Sync-ExchangeGroupMembers $desiredNoOpGroup @() @{} $true $script:noOpDistributionGroup $true $script:noOpGroupProfile
} catch {
  $unprovableMemberRemovalFailedClosed = $_.Exception.Message -match "immutable or unique SMTP identity could not be proven"
}
Assert-True $unprovableMemberRemovalFailedClosed "A duplicate unexpected member without a strong identity must fail closed before removal"
Assert-Equal 0 @($script:removedMemberEmails).Count "An unprovable member identity must never be removed through mutable display Identity"
$script:duplicateUnexpectedMemberSnapshot = $false

$script:memberState = @{ "existing@example.com" = $true }
$script:attemptedMemberAdds = @()
$script:removedMemberEmails = @()
$script:getDistributionGroupMemberCalls = 0
$script:forceMembershipVerificationFailure = $true
Set-Item Function:Start-Sleep -Value { param($Seconds) }
try {
  $failedFullMemberStats = @{ changeDetails = @() }
  $failedMembershipVerification = $false
  try {
    Sync-ExchangeGroupMembers $desiredNoOpGroup $desiredNoOpGroupMembers $failedFullMemberStats $true $script:noOpDistributionGroup $true $script:noOpGroupProfile
  } catch {
    $failedMembershipVerification = $_.Exception.Message -match "membership verification failed"
  }
  Assert-True $failedMembershipVerification "A full membership mutation must fail when bounded final verification never confirms it"
  $failedMutationRows = @($failedFullMemberStats.changeDetails | Where-Object { $_.actionLabel -eq "Add group member" })
  Assert-Equal 1 $failedMutationRows.Count "A successful member cmdlet with failed final verification must retain one partial mutation detail"
  Assert-Equal "failed" $failedMutationRows[0].status "An unverified membership mutation must never be rendered green/completed"
  Assert-True (@($failedMutationRows[0].fieldChanges) -contains "Member: (absent) -> missing@example.com") "A failed partial membership detail must preserve the exact member before/after"
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
  $script:forceMembershipVerificationFailure = $false
}

$script:memberState = @{
  "existing@example.com" = $true
  "unexpected@example.com" = $true
}
$script:attemptedMemberAdds = @()
$script:removedMemberEmails = @()
$script:getDistributionGroupMemberCalls = 0
$incrementalMemberStats = @{}
Sync-ExchangeGroupMembers $desiredNoOpGroup $desiredNoOpGroupMembers $incrementalMemberStats
Assert-Equal 2 $script:getDistributionGroupMemberCalls "Incremental membership processing must retain its live cleanup and verification reads"
Assert-Equal 2 @($script:attemptedMemberAdds).Count "Incremental membership processing must retain its current add-attempt behavior"
Assert-True ($script:attemptedMemberAdds -contains "existing@example.com") "Incremental membership processing must still tolerate an already-present member"
Assert-Equal 1 $incrementalMemberStats.addedMembers "Incremental membership processing must still count only a newly added member"

$auditCanonicalContact = [pscustomobject]@{
  SourceContactId = "c-current-owner"
  DisplayName = "Current Duplicate Owner"
  ExternalEmailAddress = "historical-duplicate@example.com"
  Alias = "current-duplicate-owner"
  FirstName = "Current"
  LastName = "Owner"
  SourceKey = "FCUNO_CONTACT:c-current-owner"
  AllowedOwnerSourceKeys = @("FCUNO_CONTACT:c-current-owner")
}
$script:auditReconciliationRows = @{
  ContactByEmail = @{ "historical-duplicate@example.com" = $auditCanonicalContact }
}
$script:capturedAuditContact = $null
function Get-CanonicalExchangeRows {
  return $script:auditReconciliationRows
}
function Upsert-ExchangeMailContact {
  param($Contact, [hashtable]$Stats, [bool]$SkipNoOpWrites = $false, $ExistingHint = $null, [bool]$UseExistingHint = $false, $ExistingProfileHint = $null)
  $script:capturedAuditContact = $Contact
}

$auditUpdateRow = [pscustomobject]@{
  entity_id = "c-former-update-owner"
  audit_log_id = "11111111-2222-3333-4444-555555555555"
  payload = [pscustomobject]@{ userAuthorized = $true }
}
Reconcile-ExchangeContactEmail "historical-duplicate@example.com" $auditUpdateRow @{} $false $true
Assert-True ($script:capturedAuditContact.AllowedOwnerSourceKeys -contains "FCUNO_CONTACT:c-former-update-owner") "An audit-authorized before-email update must allow the queued historical duplicate owner"
Assert-True ($script:capturedAuditContact.AllowedOwnerSourceKeys -contains "FCUNO_CONTACT:c-current-owner") "An audit-authorized before-email update must preserve the canonical current owner"
Assert-True ($auditCanonicalContact.AllowedOwnerSourceKeys -notcontains "FCUNO_CONTACT:c-former-update-owner") "The historical audit exception must not mutate or broaden the canonical contact"

$historicalUpdateOwner = [pscustomobject]@{
  Identity = "historical-update-owner"
  ExternalEmailAddress = "historical-duplicate@example.com"
  CustomAttribute2 = "FCUNO_CONTACT:c-former-update-owner"
}
$resolvedAuditUpdateOwner = Resolve-ExchangeMailContactHint $script:capturedAuditContact (New-ExchangeMailContactLookup @($historicalUpdateOwner))
Assert-Equal "historical-update-owner" $resolvedAuditUpdateOwner.Identity "The scoped audit update exception must authorize only its queued historical owner"

$script:capturedAuditContact = $null
Reconcile-ExchangeContactEmail "historical-duplicate@example.com" $auditUpdateRow @{} $false $false
Assert-True ($script:capturedAuditContact.AllowedOwnerSourceKeys -notcontains "FCUNO_CONTACT:c-former-update-owner") "The current-email leg must not inherit the historical audit owner exception"

$auditDeleteRow = [pscustomobject]@{
  entity_id = "c-former-delete-owner"
  audit_log_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  payload = [pscustomobject]@{ userAuthorized = $true }
}
$script:capturedAuditContact = $null
Reconcile-ExchangeContactEmail "historical-duplicate@example.com" $auditDeleteRow @{} $true $true
Assert-True ($script:capturedAuditContact.AllowedOwnerSourceKeys -contains "FCUNO_CONTACT:c-former-delete-owner") "An audit-authorized before-email delete must allow the queued deleted duplicate owner"
Assert-True ($auditCanonicalContact.AllowedOwnerSourceKeys -notcontains "FCUNO_CONTACT:c-former-delete-owner") "The delete exception must remain scoped to its cloned before-email reconciliation"

Set-Item Function:Start-Sleep -Value { param($Seconds) }
try {
  $script:deleteContactMode = "noop"
  $script:deleteContactRemoved = $false
  $script:deleteContactRemoveCalls = 0
  $legacyDeleteContact = [pscustomobject]@{
    Identity = "legacy-delete-contact"
    Guid = "66666666-6666-4666-8666-666666666666"
    DistinguishedName = "CN=Legacy Delete Contact,OU=Contacts,DC=example,DC=com"
    DisplayName = "Legacy Delete Contact"
    ExternalEmailAddress = "legacy-delete@example.com"
    Alias = "legacy-delete-contact"
    CustomAttribute1 = ""
    CustomAttribute2 = ""
  }
  $replacementDeleteContact = [pscustomobject]@{
    Identity = "replacement-delete-contact"
    Guid = "77777777-7777-4777-8777-777777777777"
    DistinguishedName = "CN=Replacement Delete Contact,OU=Contacts,DC=example,DC=com"
    DisplayName = "Replacement Delete Contact"
    ExternalEmailAddress = "legacy-delete@example.com"
    Alias = "replacement-delete-contact"
    CustomAttribute1 = $ManagedMarker
    CustomAttribute2 = "FCUNO_CONTACT:c-replacement"
  }
  function Get-MailContact {
    [CmdletBinding()]
    param($Filter, $ResultSize, $Identity)
    if ($script:deleteContactMode -eq "source_lookup_error" -and $Filter -like "CustomAttribute2 -eq '*'") {
      throw "Exchange contact source lookup was throttled."
    }
    if ($script:deleteContactMode -eq "verification_error" -and $script:deleteContactRemoved -and $Identity -in @($legacyDeleteContact.Guid, $legacyDeleteContact.DistinguishedName)) {
      throw "Exchange contact deletion verification connection was interrupted."
    }
    if ($Identity -in @($legacyDeleteContact.Identity, $legacyDeleteContact.Guid, $legacyDeleteContact.DistinguishedName)) {
      if (-not $script:deleteContactRemoved) { return $legacyDeleteContact }
      return $null
    }
    if ($Filter -like "ExternalEmailAddress -eq 'legacy-delete@example.com'") {
      if (-not $script:deleteContactRemoved) { return $legacyDeleteContact }
      if ($script:deleteContactMode -eq "replacement") { return $replacementDeleteContact }
    }
    return $null
  }
  function Remove-MailContact {
    [CmdletBinding(SupportsShouldProcess)]
    param($Identity)
    $script:deleteContactRemoveCalls += 1
    if ($script:deleteContactMode -in @("replacement", "verification_error")) { $script:deleteContactRemoved = $true }
  }

  $script:deleteContactMode = "source_lookup_error"
  $script:deleteContactRemoved = $false
  $script:deleteContactRemoveCalls = 0
  $contactLookupStats = @{}
  $contactLookupFailedClosed = $false
  try {
    Remove-ManagedExchangeMailContact "legacy-delete@example.com" "legacy-delete-contact" $contactLookupStats "lookup-error" "Legacy Delete Contact" $true
  } catch {
    $contactLookupFailedClosed = $_.Exception.Message -match "throttled"
  }
  Assert-True $contactLookupFailedClosed "A throttled contact source lookup must fail instead of concluding that the contact is absent"
  Assert-Equal 0 $script:deleteContactRemoveCalls "A failed contact source lookup must never call Remove-MailContact"
  Assert-Equal 0 ([int]$contactLookupStats.verifiedQueueRows) "A failed contact source lookup must never count verified completion"

  $script:deleteContactMode = "noop"
  $contactNoOpFailed = $false
  try {
    Remove-ManagedExchangeMailContact "legacy-delete@example.com" "legacy-delete-contact" @{} "" "Legacy Delete Contact" $true
  } catch {
    $contactNoOpFailed = $_.Exception.Message -match "exact immutable Exchange contact still exists"
  }
  Assert-True $contactNoOpFailed "A Remove-MailContact no-op must fail exact immutable deletion verification"
  Assert-Equal 1 $script:deleteContactRemoveCalls "The contact deletion guard must still attempt the authorized exact removal once"

  $script:deleteContactMode = "replacement"
  $script:deleteContactRemoved = $false
  $replacementDeleteStats = @{}
  Remove-ManagedExchangeMailContact "legacy-delete@example.com" "legacy-delete-contact" $replacementDeleteStats "" "Legacy Delete Contact" $true
  Assert-Equal 1 $replacementDeleteStats.removedContacts "A demonstrably different same-email contact with a non-empty owner may survive exact legacy deletion"

  $script:deleteContactMode = "verification_error"
  $script:deleteContactRemoved = $false
  $script:deleteContactRemoveCalls = 0
  $contactVerificationStats = @{}
  $contactVerificationReadFailedClosed = $false
  try {
    Remove-ManagedExchangeMailContact "legacy-delete@example.com" "legacy-delete-contact" $contactVerificationStats "" "Legacy Delete Contact" $true
  } catch {
    $contactVerificationReadFailedClosed = $_.Exception.Message -match "connection was interrupted"
  }
  Assert-True $contactVerificationReadFailedClosed "A transient Get-MailContact failure after Remove-MailContact must fail deletion verification"
  Assert-Equal 1 $script:deleteContactRemoveCalls "The verification-read regression must exercise a successful Remove-MailContact cmdlet first"
  Assert-Equal 0 ([int]$contactVerificationStats.removedContacts) "A contact deletion with an unreadable final state must not count as removed"
  Assert-Equal 0 ([int]$contactVerificationStats.verifiedQueueRows) "A contact deletion with an unreadable final state must not count as verified/completed"

  $script:deleteGroupRemoved = $false
  $script:deleteGroupRemoveCalls = 0
  $script:deleteGroupMode = "noop"
  $legacyDeleteGroup = [pscustomobject]@{
    Identity = "legacy-delete-group"
    Guid = "88888888-8888-4888-8888-888888888888"
    DistinguishedName = "CN=Legacy Delete Group,OU=Groups,DC=example,DC=com"
    DisplayName = "Legacy Delete Group"
    Alias = "legacy-delete-group"
    CustomAttribute1 = ""
    CustomAttribute2 = ""
  }
  function Get-DistributionGroup {
    [CmdletBinding()]
    param($Filter, $ResultSize, $Identity)
    if ($script:deleteGroupMode -eq "alias_lookup_error" -and -not $script:deleteGroupRemoved -and $Identity -eq $legacyDeleteGroup.Alias) {
      throw "Exchange group alias lookup connection was interrupted."
    }
    if ($script:deleteGroupMode -eq "verification_error" -and $script:deleteGroupRemoved -and $Identity -in @($legacyDeleteGroup.Guid, $legacyDeleteGroup.DistinguishedName)) {
      throw "Exchange group deletion verification was throttled."
    }
    if ($Identity -in @($legacyDeleteGroup.Identity, $legacyDeleteGroup.Guid, $legacyDeleteGroup.DistinguishedName, $legacyDeleteGroup.Alias)) {
      if (-not $script:deleteGroupRemoved) { return $legacyDeleteGroup }
    }
    return $null
  }
  function Remove-DistributionGroup {
    [CmdletBinding(SupportsShouldProcess)]
    param($Identity)
    $script:deleteGroupRemoveCalls += 1
    if ($script:deleteGroupMode -eq "verification_error") { $script:deleteGroupRemoved = $true }
  }

  $script:deleteGroupMode = "alias_lookup_error"
  $script:deleteGroupRemoveCalls = 0
  $groupLookupStats = @{}
  $groupLookupFailedClosed = $false
  try {
    Remove-ManagedExchangeDistributionGroup "legacy-delete-group" $groupLookupStats "" "Legacy Delete Group" $true
  } catch {
    $groupLookupFailedClosed = $_.Exception.Message -match "connection was interrupted"
  }
  Assert-True $groupLookupFailedClosed "A failed group alias lookup must fail instead of concluding that the group is absent"
  Assert-Equal 0 $script:deleteGroupRemoveCalls "A failed group alias lookup must never call Remove-DistributionGroup"
  Assert-Equal 0 ([int]$groupLookupStats.verifiedQueueRows) "A failed group alias lookup must never count verified completion"

  $script:deleteGroupMode = "noop"
  $groupNoOpFailed = $false
  try {
    Remove-ManagedExchangeDistributionGroup "legacy-delete-group" @{} "" "Legacy Delete Group" $true
  } catch {
    $groupNoOpFailed = $_.Exception.Message -match "exact immutable Exchange group still exists"
  }
  Assert-True $groupNoOpFailed "A Remove-DistributionGroup no-op must fail exact immutable deletion verification"
  Assert-Equal 1 $script:deleteGroupRemoveCalls "The group deletion guard must still attempt the authorized exact removal once"

  $script:deleteGroupMode = "verification_error"
  $script:deleteGroupRemoved = $false
  $script:deleteGroupRemoveCalls = 0
  $groupVerificationStats = @{}
  $groupVerificationReadFailedClosed = $false
  try {
    Remove-ManagedExchangeDistributionGroup "legacy-delete-group" $groupVerificationStats "" "Legacy Delete Group" $true
  } catch {
    $groupVerificationReadFailedClosed = $_.Exception.Message -match "throttled"
  }
  Assert-True $groupVerificationReadFailedClosed "A transient Get-DistributionGroup failure after Remove-DistributionGroup must fail deletion verification"
  Assert-Equal 1 $script:deleteGroupRemoveCalls "The group verification-read regression must exercise a successful Remove-DistributionGroup cmdlet first"
  Assert-Equal 0 ([int]$groupVerificationStats.removedGroups) "A group deletion with an unreadable final state must not count as removed"
  Assert-Equal 0 ([int]$groupVerificationStats.verifiedQueueRows) "A group deletion with an unreadable final state must not count as verified/completed"
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
}

Write-Output "Exchange address book runbook tests passed."
