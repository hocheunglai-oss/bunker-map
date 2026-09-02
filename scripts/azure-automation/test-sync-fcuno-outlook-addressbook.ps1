param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "sync-fcuno-outlook-addressbook.ps1") -LibraryOnly
$script:ExchangeAddressBookDomain = Get-NormalizedExchangeAddressBookDomain "COSULICH1.ONMICROSOFT.COM"

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "FAILED: $Message" }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
  if ([string]$Expected -cne [string]$Actual) {
    throw "FAILED: $Message. Expected '$Expected'; got '$Actual'."
  }
}

$dependencyOrderedRows = Sort-ExchangeQueueRowsForDependencies @(
  [pscustomobject]@{ action = "update_group_members"; queue_sequence = 20; id = "group-members" },
  [pscustomobject]@{ action = "delete_contact"; queue_sequence = 10; id = "delete-contact" },
  [pscustomobject]@{ action = "update_contact"; queue_sequence = 30; id = "update-contact-later" },
  [pscustomobject]@{ action = "create_contact"; queue_sequence = 5; id = "create-contact" },
  [pscustomobject]@{ action = "update_group"; queue_sequence = 15; id = "update-group" },
  [pscustomobject]@{ action = "update_contact"; queue_sequence = 8; id = "update-contact-earlier" }
)
Assert-Equal `
  "create-contact,update-contact-earlier,update-contact-later,update-group,group-members,delete-contact" `
  (($dependencyOrderedRows | ForEach-Object { $_.id }) -join ",") `
  "Incremental batches must settle contact recipients before groups and defer contact deletion"

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
Assert-Equal "cosulich1.onmicrosoft.com" (Get-RequiredExchangeAddressBookDomain) "The required Exchange address-book domain must be canonical lower-case truth"
$invalidAddressBookDomainRejected = $false
try {
  Get-NormalizedExchangeAddressBookDomain "not a domain" | Out-Null
} catch {
  $invalidAddressBookDomainRejected = $_.Exception.Message -match "EXCHANGE_ADDRESSBOOK_DOMAIN"
}
Assert-True $invalidAddressBookDomainRejected "An invalid Exchange address-book domain must fail closed"
$wrongValidAddressBookDomainRejected = $false
try {
  Get-NormalizedExchangeAddressBookDomain "another-tenant.onmicrosoft.com" | Out-Null
} catch {
  $wrongValidAddressBookDomainRejected = $_.Exception.Message -match "cosulich1\.onmicrosoft\.com"
}
Assert-True $wrongValidAddressBookDomainRejected "A syntactically valid but non-canonical Exchange address-book domain must fail closed"
$liveTransportNotFoundError = $null
try {
  throw "||The operation couldn't be performed because object 'g-ocean-bba895' couldn't be found on 'TPXPR04A01DC002.APCPR04A001.prod.outlook.com'."
} catch {
  $liveTransportNotFoundError = $_
}
Assert-True (Test-ExchangeIdentityNotFoundError $liveTransportNotFoundError) "The exact live Exchange transport-prefixed object-not-found response must be classified as retryable"
$repeatedTransportNotFoundError = $null
try {
  throw "||||The operation couldn't be performed because object 'g-ocean-bba895' couldn't be found on 'TPXPR04A01DC002.APCPR04A001.prod.outlook.com'."
} catch {
  $repeatedTransportNotFoundError = $_
}
Assert-True (-not (Test-ExchangeIdentityNotFoundError $repeatedTransportNotFoundError)) "Only the exact observed leading Exchange transport separator pair may be normalized"
$embeddedTransportNotFoundError = $null
try {
  throw "Exchange request failed: ||The operation couldn't be performed because object 'g-ocean-bba895' couldn't be found on 'TPXPR04A01DC002.APCPR04A001.prod.outlook.com'."
} catch {
  $embeddedTransportNotFoundError = $_
}
Assert-True (-not (Test-ExchangeIdentityNotFoundError $embeddedTransportNotFoundError)) "An embedded Exchange transport separator must not turn an unrelated outer error into a retryable not-found response"
$temporaryExchangeMessage = "A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support."
$temporaryExchangeError = $null
try {
  throw $temporaryExchangeMessage
} catch {
  $temporaryExchangeError = $_
}
Assert-True (Test-ExchangeTemporaryServerError $temporaryExchangeError) "The exact Microsoft Exchange temporary server response must be retried inside the same run"
$wrappedTemporaryExchangeError = $null
try {
  throw "Exchange group membership verification failed (verification read failed: $temporaryExchangeMessage)."
} catch {
  $wrappedTemporaryExchangeError = $_
}
Assert-True (Test-ExchangeTemporaryServerError $wrappedTemporaryExchangeError) "A safely wrapped membership failure must retain the exact temporary Exchange classification"
$unrelatedExchangeError = $null
try {
  throw "Exchange group membership differs and requires correction in FCUNO."
} catch {
  $unrelatedExchangeError = $_
}
Assert-True (-not (Test-ExchangeTemporaryServerError $unrelatedExchangeError)) "A real validation mismatch must never be suppressed as temporary"
$script:temporaryRetryAttempts = 0
$temporaryRetryResult = ""
Set-Item Function:Start-Sleep -Value { param($Seconds) }
try {
  $temporaryRetryResult = Invoke-ExchangeOperationWithTemporaryRetry `
    "Temporary retry unit test" `
    {
      $script:temporaryRetryAttempts += 1
      if ($script:temporaryRetryAttempts -eq 1) { throw $temporaryExchangeMessage }
      return "recovered"
    } `
    3 `
    0
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
}
Assert-Equal 2 $script:temporaryRetryAttempts "A temporary Exchange error must retry once and stop after recovery"
Assert-Equal "recovered" $temporaryRetryResult "A recovered temporary Exchange operation must return its successful result"
$script:nonTemporaryRetryAttempts = 0
$nonTemporaryRetryFailedClosed = $false
try {
  Invoke-ExchangeOperationWithTemporaryRetry `
    "Non-temporary retry unit test" `
    {
      $script:nonTemporaryRetryAttempts += 1
      throw "Permanent validation failure."
    } `
    3 `
    0 | Out-Null
} catch {
  $nonTemporaryRetryFailedClosed = $_.Exception.Message -eq "Permanent validation failure."
}
Assert-True $nonTemporaryRetryFailedClosed "A non-temporary Exchange error must fail closed immediately"
Assert-Equal 1 $script:nonTemporaryRetryAttempts "A non-temporary Exchange error must not consume retry attempts"
Assert-Equal `
  "22222222-2222-4222-8222-222222222222" `
  (Get-ExchangeContactProfileCommandIdentity ([pscustomobject]@{ Guid = "22222222-2222-4222-8222-222222222222"; DistinguishedName = "CN=Profile,DC=example,DC=com"; ExternalEmailAddress = "valid@example.com" })) `
  "Contact profile commands must prefer the resolved profile GUID"
Assert-Equal `
  "CN=Profile,DC=example,DC=com" `
  (Get-ExchangeContactProfileCommandIdentity ([pscustomobject]@{ DistinguishedName = "CN=Profile,DC=example,DC=com"; ExternalEmailAddress = "valid@example.com" })) `
  "Contact profile commands may fall back only to the resolved profile distinguished name"
$unsafeProfileIdentityRejected = $false
try {
  Get-ExchangeContactProfileCommandIdentity ([pscustomobject]@{ Identity = "Shared Display Name"; ExternalEmailAddress = "valid@example.com" }) | Out-Null
} catch {
  $unsafeProfileIdentityRejected = $_.Exception.Message -match "no supported immutable GUID or distinguished-name identity"
}
Assert-True $unsafeProfileIdentityRejected "Contact profile commands must reject email and display-name identities"

$directWebhookPayload = Get-WebhookPayload '{"syncMode":"full","requestedBy":"SC"}'
Assert-Equal "full" $directWebhookPayload.syncMode "A JSON string from the Azure Test pane must preserve syncMode"
$wrappedWebhookPayload = Get-WebhookPayload '{"RequestBody":"{\"syncMode\":\"full\",\"requestedBy\":\"SC\"}"}'
Assert-Equal "full" $wrappedWebhookPayload.syncMode "A serialized Azure webhook wrapper must preserve syncMode"
$nativeWebhookPayload = Get-WebhookPayload ([pscustomobject]@{ RequestBody = '{"syncMode":"incremental"}' })
Assert-Equal "incremental" $nativeWebhookPayload.syncMode "A native Azure webhook object must remain supported"

$reservedRunId = "79e87ed2-4e95-4cc0-a0f0-87bf341020d3"
$reservedWebhookPayload = Get-WebhookPayload `
  ('{"syncMode":"incremental","reservationId":"' + $reservedRunId + '"}')
Assert-Equal $reservedRunId (Get-ExchangeQueueRunId $reservedWebhookPayload) "A FCUNO trigger reservation must become the Azure mutation lease identity"
$generatedRunId = Get-ExchangeQueueRunId ([pscustomobject]@{ reservationId = "not-a-guid" })
[Guid]$parsedGeneratedRunId = [Guid]::Empty
Assert-True ([Guid]::TryParse($generatedRunId, [ref]$parsedGeneratedRunId)) "An invalid or absent reservation must safely fall back to a new GUID"
Assert-True ($generatedRunId -cne $reservedRunId) "A fallback Azure run must not reuse an unrelated reservation identity"

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
Assert-Equal "group-one@cosulich1.onmicrosoft.com" $built.GroupById["g-1"].SmtpAddress "Every projected group must carry its exact normalized Exchange SMTP address"
Assert-True ((Get-CanonicalExchangeProjectionJson $built) -match '"smtpAddress":"group-one@cosulich1.onmicrosoft.com"') "The exact group SMTP address must be part of the canonical projection and fingerprint"
Assert-Equal "c-new" $built.ContactByEmail["dup@example.com"].SourceContactId "Newest source row must be the canonical duplicate owner"
Assert-True ($built.ContactByEmail["dup@example.com"].AllowedOwnerSourceKeys -contains "FCUNO_CONTACT:c-old") "A canonical duplicate must record its previous eligible source owner"
Assert-True ($built.ContactByEmail["dup@example.com"].AllowedOwnerSourceKeys -contains "FCUNO_CONTACT:c-new") "A canonical duplicate must record its current eligible source owner"
Assert-Equal "Group One" $built.GroupById["g-1"].DirectoryName "A non-colliding group must retain its exact FCUNO name as its Exchange directory name"

$singaporeExternalRows = Build-ExchangeRows @(
  [pscustomobject]@{ id = "fcbs-bunker"; source_book = "FC-GENERAL"; display_name = "FCBS"; primary_email = "bunker@cosulich.com.sg"; nickname = "FCBS"; first_name = ""; last_name = ""; updated_at = "2026-07-22T03:00:00Z" }
) @() @()
Assert-Equal 1 @($singaporeExternalRows.Contacts).Count "FC-GENERAL cosulich.com.sg recipients must project as managed mail contacts because that domain is external to this Exchange tenant"
Assert-Equal "fcbs-bunker" $singaporeExternalRows.Contacts[0].SourceContactId "The Singapore external recipient must retain its FCUNO source identity"
Assert-True (-not (Is-InternalContact $singaporeExternalRows.Contacts[0] "bunker@cosulich.com.sg")) "A cosulich.com.sg domain alone must never classify an FC-GENERAL recipient as internal"
Assert-True (Is-InternalEmail "internal@cosulich.com.hk") "The tenant's authoritative cosulich.com.hk domain must retain its legacy internal-domain safeguard"

$groupShadowPlaceholder = [pscustomobject]@{
  id = "shadow-placeholder"
  source_book = "FC-GENERAL"
  display_name = "SHADOW GROUP"
  primary_email = "shadow group"
  nickname = "SHADOW GROUP"
  first_name = ""
  last_name = ""
  updated_at = "2026-07-22T03:00:00Z"
  vcard = "BEGIN:VCARD`nFN:SHADOW GROUP`nEMAIL:shadow group`nEND:VCARD"
  properties = '{"email":"shadow group"}'
}
$groupShadowMember = [pscustomobject]@{
  id = "shadow-member"
  source_book = "FC-GENERAL"
  display_name = "SHADOW GROUP-1"
  primary_email = "shadow.member@example.com"
  nickname = "SHADOW GROUP-1"
  first_name = ""
  last_name = ""
  updated_at = "2026-07-22T03:00:00Z"
}
$groupShadowGroup = [pscustomobject]@{
  id = "shadow-group"
  source_book = "FC-GENERAL"
  name = "SHADOW GROUP"
  nickname = "SHADOW GROUP"
  source_uid = "shadow-group-uid"
  description = ""
}
$groupShadowMembership = [pscustomobject]@{ group_id = "shadow-group"; contact_id = "shadow-member"; source_book = "FC-GENERAL" }
$groupShadowRows = Build-ExchangeRows @($groupShadowPlaceholder, $groupShadowMember) @($groupShadowGroup) @($groupShadowMembership)
Assert-Equal 0 @($groupShadowRows.InvalidContacts).Count "An exact non-member invalid contact shadowing one populated same-book group must not remain a hard validation failure"
Assert-Equal 1 @($groupShadowRows.SkippedInvalidContacts).Count "An exact non-member invalid contact shadowing one populated same-book group must be classified separately"
Assert-Equal "shadow-placeholder" $groupShadowRows.SkippedInvalidContacts[0].SourceContactId "The skipped placeholder must retain its exact FCUNO contact source ID"
Assert-Equal "FCUNO_GROUP:shadow-group" $groupShadowRows.SkippedInvalidContacts[0].GroupSourceKey "The skipped placeholder must identify the exact certified group source key"
Assert-Equal 1 $groupShadowRows.SkippedInvalidContacts[0].ValidMemberCount "The skipped placeholder must record the populated group's valid projected member count"
Assert-True ($groupShadowRows.SkippedInvalidContacts[0].Reason -match "same-book group 'SHADOW GROUP'.*certified Exchange representation") "The skipped placeholder must explain the certified same-book group representation"

$groupShadowSkipStats = @{ failedQueueRows = 0; skippedQueueRows = 0; skippedInvalidContacts = 0; changeDetails = @() }
Add-FullSyncGroupShadowPlaceholderDetail $groupShadowSkipStats $groupShadowRows.SkippedInvalidContacts[0] $true
Assert-Equal 0 $groupShadowSkipStats.failedQueueRows "A certified group-shadow placeholder must not count as a full-sync failure"
Assert-Equal 1 $groupShadowSkipStats.skippedQueueRows "A certified group-shadow placeholder must count as an explicit skipped change"
Assert-Equal 1 $groupShadowSkipStats.skippedInvalidContacts "A certified group-shadow placeholder must have its own summary counter"
Assert-Equal "skipped" $groupShadowSkipStats.changeDetails[0].status "The placeholder notice row must carry skipped status"
Assert-Equal "" $groupShadowSkipStats.changeDetails[0].exchangeIdentity "An FCUNO group source key must never be presented as an immutable Exchange identity"
Assert-True (@($groupShadowSkipStats.changeDetails[0].fieldChanges) -contains "Invalid contact source ID: shadow-placeholder") "The placeholder notice must state the exact invalid contact source ID"
Assert-True ($groupShadowSkipStats.changeDetails[0].result -match "same-book group 'SHADOW GROUP'.*certified as its Exchange representation") "The placeholder notice must state why the group and members are the certified representation"

$groupShadowNoGroupRows = Build-ExchangeRows @($groupShadowPlaceholder) @() @()
Assert-Equal 1 @($groupShadowNoGroupRows.InvalidContacts).Count "An invalid contact without an exact same-book group must remain a hard failure"
Assert-Equal 0 @($groupShadowNoGroupRows.SkippedInvalidContacts).Count "An invalid contact without a group must never use the placeholder exception"

$groupShadowNameMismatch = [pscustomobject]@{
  id = "shadow-name-mismatch"
  source_book = "FC-GENERAL"
  display_name = "SHADOW GROUP"
  primary_email = "DIFFERENT INVALID VALUE"
  nickname = "SHADOW GROUP"
  first_name = ""
  last_name = ""
  updated_at = "2026-07-22T03:00:00Z"
  vcard = "BEGIN:VCARD`nFN:SHADOW GROUP`nEMAIL:DIFFERENT INVALID VALUE`nEND:VCARD"
  properties = '{"email":"DIFFERENT INVALID VALUE"}'
}
$groupShadowNameMismatchRows = Build-ExchangeRows @($groupShadowNameMismatch, $groupShadowMember) @($groupShadowGroup) @($groupShadowMembership)
Assert-Equal 1 @($groupShadowNameMismatchRows.InvalidContacts).Count "An invalid primary value that does not equal the display name must remain a hard failure"
Assert-Equal 0 @($groupShadowNameMismatchRows.SkippedInvalidContacts).Count "A primary/display-name mismatch must never use the placeholder exception"

$groupShadowEmptyGroupRows = Build-ExchangeRows @($groupShadowPlaceholder, $groupShadowMember) @($groupShadowGroup) @()
Assert-Equal 1 @($groupShadowEmptyGroupRows.InvalidContacts).Count "An invalid contact whose same-name group has no projected members must remain a hard failure"
Assert-Equal 0 @($groupShadowEmptyGroupRows.SkippedInvalidContacts).Count "An empty group must never certify a placeholder representation"

$groupShadowReferencedRows = Build-ExchangeRows `
  @($groupShadowPlaceholder, $groupShadowMember) `
  @($groupShadowGroup) `
  @(
    $groupShadowMembership,
    [pscustomobject]@{ group_id = "shadow-group"; contact_id = "shadow-placeholder"; source_book = "FC-GENERAL" }
  )
Assert-Equal 1 @($groupShadowReferencedRows.InvalidContacts).Count "An invalid contact referenced by any raw membership row must remain a hard failure"
Assert-Equal 0 @($groupShadowReferencedRows.SkippedInvalidContacts).Count "A referenced invalid contact must never use the placeholder exception"

$groupShadowAlternateVcard = [pscustomobject]@{
  id = "shadow-placeholder"
  source_book = "FC-GENERAL"
  display_name = "SHADOW GROUP"
  primary_email = "shadow group"
  nickname = "SHADOW GROUP"
  first_name = ""
  last_name = ""
  updated_at = "2026-07-22T03:00:00Z"
  vcard = "BEGIN:VCARD`nFN:SHADOW GROUP`nEMAIL:shadow group`nEMAIL:alternate.vcard@example.com`nEND:VCARD"
  properties = '{"email":"shadow group"}'
}
$groupShadowAlternateVcardRows = Build-ExchangeRows @($groupShadowAlternateVcard, $groupShadowMember) @($groupShadowGroup) @($groupShadowMembership)
Assert-Equal 1 @($groupShadowAlternateVcardRows.InvalidContacts).Count "A valid alternate email in vCard must keep the invalid primary row as a hard failure"
Assert-Equal 0 @($groupShadowAlternateVcardRows.SkippedInvalidContacts).Count "A vCard alternate email must block the placeholder exception"

$groupShadowAlternateProperties = [pscustomobject]@{
  id = "shadow-placeholder"
  source_book = "FC-GENERAL"
  display_name = "SHADOW GROUP"
  primary_email = "shadow group"
  nickname = "SHADOW GROUP"
  first_name = ""
  last_name = ""
  updated_at = "2026-07-22T03:00:00Z"
  vcard = "BEGIN:VCARD`nFN:SHADOW GROUP`nEMAIL:shadow group`nEND:VCARD"
  properties = [pscustomobject]@{ email = "alternate.properties@example.com" }
}
$groupShadowAlternatePropertiesRows = Build-ExchangeRows @($groupShadowAlternateProperties, $groupShadowMember) @($groupShadowGroup) @($groupShadowMembership)
Assert-Equal 1 @($groupShadowAlternatePropertiesRows.InvalidContacts).Count "A valid alternate email in contact properties must keep the invalid primary row as a hard failure"
Assert-Equal 0 @($groupShadowAlternatePropertiesRows.SkippedInvalidContacts).Count "A properties alternate email must block the placeholder exception"

$secondGroupShadowGroup = [pscustomobject]@{
  id = "shadow-group-duplicate"
  source_book = "FC-GENERAL"
  name = "SHADOW GROUP"
  nickname = "SHADOW GROUP"
  source_uid = "shadow-group-duplicate-uid"
  description = ""
}
$groupShadowPopulatedAndEmptyDuplicateRows = Build-ExchangeRows `
  @($groupShadowPlaceholder, $groupShadowMember) `
  @($groupShadowGroup, $secondGroupShadowGroup) `
  @($groupShadowMembership)
Assert-Equal 1 @($groupShadowPopulatedAndEmptyDuplicateRows.InvalidContacts).Count "One populated and one empty exact same-book group are still ambiguous and must keep the invalid contact as a hard failure"
Assert-Equal 0 @($groupShadowPopulatedAndEmptyDuplicateRows.SkippedInvalidContacts).Count "An empty duplicate group must block the placeholder exception even when the other exact group is populated"

$groupShadowAmbiguousRows = Build-ExchangeRows `
  @($groupShadowPlaceholder, $groupShadowMember) `
  @($groupShadowGroup, $secondGroupShadowGroup) `
  @(
    $groupShadowMembership,
    [pscustomobject]@{ group_id = "shadow-group-duplicate"; contact_id = "shadow-member"; source_book = "FC-GENERAL" }
  )
Assert-Equal 1 @($groupShadowAmbiguousRows.InvalidContacts).Count "Two populated exact same-book groups are ambiguous and must keep the invalid contact as a hard failure"
Assert-Equal 0 @($groupShadowAmbiguousRows.SkippedInvalidContacts).Count "An ambiguous duplicate group must never use the placeholder exception"
Assert-True `
  ((Get-CanonicalExchangeProjectionFingerprint $groupShadowRows) -cne (Get-CanonicalExchangeProjectionFingerprint $groupShadowAlternateVcardRows)) `
  "The canonical fingerprint must distinguish a skipped group-shadow placeholder from a hard invalid-contact failure"

$mixedInternalExternalContacts = @(
  [pscustomobject]@{ id = "managed-new"; source_book = "FCUNO"; display_name = "Managed Duplicate"; primary_email = "mixed-owner@lantana.hk"; nickname = "MANAGED DUPLICATE"; first_name = ""; last_name = ""; updated_at = "2026-07-22T03:00:00Z" },
  [pscustomobject]@{ id = "internal-old"; source_book = "FC-INTERNAL"; display_name = "Real Internal Mailbox"; primary_email = "mixed-owner@lantana.hk"; nickname = "REAL INTERNAL ALIAS"; first_name = ""; last_name = ""; updated_at = "2026-07-21T03:00:00Z" },
  [pscustomobject]@{ id = "external-alias-collision"; source_book = "FCUNO"; display_name = "External Alias Collision"; primary_email = "alias-collision@example.com"; nickname = "REAL INTERNAL ALIAS"; first_name = ""; last_name = ""; updated_at = "2026-07-22T03:00:00Z" }
)
$mixedInternalRows = Build-ExchangeRows $mixedInternalExternalContacts @() @()
$mixedInternalRowsReversed = Build-ExchangeRows @($mixedInternalExternalContacts[2], $mixedInternalExternalContacts[1], $mixedInternalExternalContacts[0]) @() @()
Assert-Equal 1 @($mixedInternalRows.Contacts).Count "Any FC-INTERNAL duplicate owner must suppress the shared email from managed mail contacts"
Assert-Equal "external-alias-collision" $mixedInternalRows.Contacts[0].SourceContactId "Only the unrelated external contact may remain managed"
Assert-Equal "managed-new" $mixedInternalRows.ContactByEmail["mixed-owner@lantana.hk"].SourceContactId "Newest-row canonical selection must remain deterministic without losing internal provenance"
Assert-True (Is-InternalContact $mixedInternalRows.ContactByEmail["mixed-owner@lantana.hk"] "mixed-owner@lantana.hk") "The canonical mixed-source email must aggregate FC-INTERNAL provenance"
Assert-True (Is-InternalContact $mixedInternalRows.ContactById["internal-old"] "mixed-owner@lantana.hk") "Every duplicate source ID must classify the shared email as internal"
Assert-True ($mixedInternalRows.ContactByEmail["mixed-owner@lantana.hk"].AllowedOwnerSourceKeys -contains "FCUNO_CONTACT:managed-new") "Mixed-source cleanup must authorize the current external duplicate owner"
Assert-True ($mixedInternalRows.ContactByEmail["mixed-owner@lantana.hk"].AllowedOwnerSourceKeys -contains "FCUNO_CONTACT:internal-old") "Mixed-source cleanup must authorize the internal duplicate owner"
Assert-Equal "real-internal-alias" $mixedInternalRows.ContactDependencyById["internal-old"].Alias "The raw FC-INTERNAL source must reserve its own base alias"
Assert-True ($mixedInternalRows.Contacts[0].Alias -ne "real-internal-alias") "A managed contact must never take an alias reserved by an older FC-INTERNAL duplicate"
Assert-Equal `
  ($mixedInternalRows | ConvertTo-Json -Depth 10 -Compress) `
  ($mixedInternalRowsReversed | ConvertTo-Json -Depth 10 -Compress) `
  "Mixed-source duplicate classification and alias reservation must be independent of input order"

$mixedInternalNewerRows = Build-ExchangeRows @(
  [pscustomobject]@{ id = "managed-old"; source_book = "FCUNO"; display_name = "Managed Duplicate"; primary_email = "mixed-owner-2@lantana.hk"; nickname = "MANAGED DUPLICATE TWO"; first_name = ""; last_name = ""; updated_at = "2026-07-21T03:00:00Z" },
  [pscustomobject]@{ id = "internal-new"; source_book = "FC-INTERNAL"; display_name = "Real Internal Mailbox"; primary_email = "mixed-owner-2@lantana.hk"; nickname = "REAL INTERNAL ALIAS TWO"; first_name = ""; last_name = ""; updated_at = "2026-07-22T03:00:00Z" }
) @() @()
Assert-Equal 0 @($mixedInternalNewerRows.Contacts).Count "A newer FC-INTERNAL duplicate must also suppress the shared email from managed mail contacts"
Assert-Equal "internal-new" $mixedInternalNewerRows.ContactByEmail["mixed-owner-2@lantana.hk"].SourceContactId "Timestamp ordering may select the internal row without changing suppression"

$oceanRows = Build-ExchangeRows @(
  [pscustomobject]@{ id = "ocean-anderson"; source_book = "FCUNO"; display_name = "OCEAN PARTNERS"; primary_email = "anderson@op-energy.co.kr"; nickname = "OCEAN PARTNERS"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" },
  [pscustomobject]@{ id = "ocean-bunkers"; source_book = "FCUNO"; display_name = "OCEAN PARTNERS"; primary_email = "bunkers@op-energy.co.kr"; nickname = "OCEAN PARTNERS"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
) @() @()
$oceanRowsReversed = Build-ExchangeRows @(
  [pscustomobject]@{ id = "ocean-bunkers"; source_book = "FCUNO"; display_name = "OCEAN PARTNERS"; primary_email = "bunkers@op-energy.co.kr"; nickname = "OCEAN PARTNERS"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" },
  [pscustomobject]@{ id = "ocean-anderson"; source_book = "FCUNO"; display_name = "OCEAN PARTNERS"; primary_email = "anderson@op-energy.co.kr"; nickname = "OCEAN PARTNERS"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
) @() @()
$oceanAnderson = $oceanRows.ContactByEmail["anderson@op-energy.co.kr"]
$oceanBunkers = $oceanRows.ContactByEmail["bunkers@op-energy.co.kr"]
Assert-Equal "OCEAN PARTNERS" $oceanAnderson.DisplayName "Duplicate FCUNO display names must remain visible exactly as entered"
Assert-Equal "OCEAN PARTNERS" $oceanBunkers.DisplayName "Both OCEAN PARTNERS contacts must retain the shared display name"
Assert-True ($oceanAnderson.DirectoryName -cne $oceanBunkers.DirectoryName) "Duplicate display names must receive unique Exchange directory names"
Assert-True ($oceanAnderson.DirectoryName.Length -le 64 -and $oceanBunkers.DirectoryName.Length -le 64) "Exchange directory names must remain within the 64-character limit"
Assert-True ($oceanAnderson.DirectoryName -match '^OCEAN PARTNERS \[[0-9a-f]{8,32}\]$') "A duplicate directory name must use a stable source-key hash suffix"
Assert-Equal $oceanAnderson.DirectoryName $oceanRowsReversed.ContactByEmail["anderson@op-energy.co.kr"].DirectoryName "Duplicate directory naming must be independent of input order"
Assert-Equal $oceanBunkers.DirectoryName $oceanRowsReversed.ContactByEmail["bunkers@op-energy.co.kr"].DirectoryName "Every duplicate directory name must be deterministic"

$contactGroupCollisionContacts = @(
  [pscustomobject]@{ id = "g-ocean-contact"; source_book = "FCUNO"; display_name = "G OCEAN"; primary_email = "enquiries@g-ocean.com.sg"; nickname = "G OCEAN"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" },
  [pscustomobject]@{ id = "other-group-member"; source_book = "FCUNO"; display_name = "Other Group Member"; primary_email = "other.group.member@example.com"; nickname = "OTHER GROUP MEMBER"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
)
$contactGroupCollisionGroups = @(
  [pscustomobject]@{ id = "g-ocean-group"; source_book = "FCUNO"; name = "G OCEAN"; nickname = "G OCEAN"; source_uid = "g-ocean-group"; description = "G OCEAN group" },
  [pscustomobject]@{ id = "other-group"; source_book = "FCUNO"; name = "Other Group"; nickname = "OTHER GROUP"; source_uid = "other-group"; description = "Other group" }
)
$contactGroupCollisionMembers = @(
  [pscustomobject]@{ group_id = "g-ocean-group"; contact_id = "g-ocean-contact"; source_book = "FCUNO" },
  [pscustomobject]@{ group_id = "other-group"; contact_id = "other-group-member"; source_book = "FCUNO" }
)
$contactGroupCollisionRows = Build-ExchangeRows $contactGroupCollisionContacts $contactGroupCollisionGroups $contactGroupCollisionMembers
$contactGroupCollisionRowsReversed = Build-ExchangeRows `
  @($contactGroupCollisionContacts[1], $contactGroupCollisionContacts[0]) `
  @($contactGroupCollisionGroups[1], $contactGroupCollisionGroups[0]) `
  @($contactGroupCollisionMembers[1], $contactGroupCollisionMembers[0])
$gOceanCollisionContact = $contactGroupCollisionRows.ContactById["g-ocean-contact"]
$gOceanCollisionGroup = $contactGroupCollisionRows.GroupById["g-ocean-group"]
Assert-Equal "G OCEAN" $gOceanCollisionContact.DirectoryName "A lone managed contact must retain the unsuffixed Exchange directory name"
Assert-Equal "G OCEAN" $gOceanCollisionGroup.GroupName "A group/contact collision must preserve the exact visible FCUNO group name"
Assert-True ($gOceanCollisionGroup.DirectoryName -cne $gOceanCollisionGroup.GroupName) "A group whose visible name matches a mail contact must receive a distinct Exchange directory name"
Assert-True ($gOceanCollisionGroup.DirectoryName -match '^G OCEAN \[[0-9a-f]{8,32}\]$') "A colliding group directory name must use its stable FCUNO source-key hash suffix"
Assert-True ($gOceanCollisionGroup.DirectoryName.Length -le 64) "A collision-safe group directory name must remain within Exchange's 64-character limit"
Assert-Equal $gOceanCollisionGroup.DirectoryName $contactGroupCollisionRowsReversed.GroupById["g-ocean-group"].DirectoryName "Group directory naming must be deterministic regardless of input order"
Assert-Equal "Other Group" $contactGroupCollisionRows.GroupById["other-group"].DirectoryName "An unrelated non-colliding group must retain its visible name as its directory name"

$emptyGroupNameRows = Build-ExchangeRows @(
  [pscustomobject]@{ id = "live-group-member"; source_book = "FCUNO"; display_name = "Live Group Member"; primary_email = "live.group.member@example.com"; nickname = "LIVE GROUP MEMBER"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
) @(
  [pscustomobject]@{ id = "a-empty-group"; source_book = "FCUNO"; name = "EMPTY NAME PEER"; nickname = "EMPTY NAME PEER"; source_uid = "a-empty-group"; description = "Empty" },
  [pscustomobject]@{ id = "z-live-group"; source_book = "FCUNO"; name = "EMPTY NAME PEER"; nickname = "EMPTY NAME PEER"; source_uid = "z-live-group"; description = "Projected" }
) @(
  [pscustomobject]@{ group_id = "z-live-group"; contact_id = "live-group-member"; source_book = "FCUNO" }
)
Assert-Equal 1 @($emptyGroupNameRows.Groups).Count "Only populated FCUNO groups may enter the Exchange projection"
Assert-Equal "EMPTY NAME PEER" $emptyGroupNameRows.GroupById["z-live-group"].DirectoryName "An empty same-name group must not reserve or suffix the populated group's Exchange directory Name"
Assert-True (-not $emptyGroupNameRows.GroupById["a-empty-group"].PSObject.Properties["DirectoryName"]) "An empty FCUNO group must not receive an Exchange directory Name"

$duplicateGroupNameContacts = @(
  [pscustomobject]@{ id = "duplicate-group-member-a"; source_book = "FCUNO"; display_name = "Duplicate Group Member A"; primary_email = "duplicate.group.a@example.com"; nickname = "DUPLICATE GROUP MEMBER A"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" },
  [pscustomobject]@{ id = "duplicate-group-member-b"; source_book = "FCUNO"; display_name = "Duplicate Group Member B"; primary_email = "duplicate.group.b@example.com"; nickname = "DUPLICATE GROUP MEMBER B"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
)
$duplicateGroupNames = @(
  [pscustomobject]@{ id = "duplicate-group-a"; source_book = "FCUNO"; name = "DUPLICATE GROUP NAME"; nickname = "DUPLICATE GROUP NAME"; source_uid = "duplicate-group-a"; description = "A" },
  [pscustomobject]@{ id = "duplicate-group-b"; source_book = "FCUNO"; name = "DUPLICATE GROUP NAME"; nickname = "DUPLICATE GROUP NAME"; source_uid = "duplicate-group-b"; description = "B" }
)
$duplicateGroupNameMembers = @(
  [pscustomobject]@{ group_id = "duplicate-group-a"; contact_id = "duplicate-group-member-a"; source_book = "FCUNO" },
  [pscustomobject]@{ group_id = "duplicate-group-b"; contact_id = "duplicate-group-member-b"; source_book = "FCUNO" }
)
$duplicateGroupNameRows = Build-ExchangeRows $duplicateGroupNameContacts $duplicateGroupNames $duplicateGroupNameMembers
$duplicateGroupNameRowsReversed = Build-ExchangeRows @($duplicateGroupNameContacts[1], $duplicateGroupNameContacts[0]) @($duplicateGroupNames[1], $duplicateGroupNames[0]) @($duplicateGroupNameMembers[1], $duplicateGroupNameMembers[0])
$duplicateGroupNameA = $duplicateGroupNameRows.GroupById["duplicate-group-a"].DirectoryName
$duplicateGroupNameB = $duplicateGroupNameRows.GroupById["duplicate-group-b"].DirectoryName
Assert-True ($duplicateGroupNameA -match '^DUPLICATE GROUP NAME \[[0-9a-f]{8,32}\]$') "Every projected duplicate group name must use a stable suffix"
Assert-True ($duplicateGroupNameB -match '^DUPLICATE GROUP NAME \[[0-9a-f]{8,32}\]$') "No projected duplicate group may own the order-dependent unsuffixed Name"
Assert-True ($duplicateGroupNameA -cne $duplicateGroupNameB) "Same-name projected groups must receive distinct Exchange directory Names"
Assert-Equal $duplicateGroupNameA $duplicateGroupNameRowsReversed.GroupById["duplicate-group-a"].DirectoryName "Duplicate group directory naming must be independent of input order"
Assert-Equal $duplicateGroupNameB $duplicateGroupNameRowsReversed.GroupById["duplicate-group-b"].DirectoryName "Every duplicate group directory Name must remain stable"

$gOceanExactRecipient = [pscustomobject]@{
  Name = $gOceanCollisionGroup.DirectoryName
  DisplayName = $gOceanCollisionGroup.GroupName
  Alias = $gOceanCollisionGroup.Alias
  PrimarySmtpAddress = $gOceanCollisionGroup.SmtpAddress
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = $gOceanCollisionGroup.SourceKey
  HiddenFromAddressListsEnabled = $false
}
$gOceanExactProfile = [pscustomobject]@{ Notes = $gOceanCollisionGroup.Description }
Assert-True (Test-ExchangeDistributionGroupMatches $gOceanExactRecipient $gOceanCollisionGroup $gOceanExactProfile) "Group verification must accept a collision-safe directory Name while preserving the exact DisplayName"
$gOceanWrongNameRecipient = [pscustomobject]@{
  Name = $gOceanCollisionGroup.GroupName
  DisplayName = $gOceanCollisionGroup.GroupName
  Alias = $gOceanCollisionGroup.Alias
  PrimarySmtpAddress = $gOceanCollisionGroup.SmtpAddress
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = $gOceanCollisionGroup.SourceKey
  HiddenFromAddressListsEnabled = $false
}
$gOceanWrongNameMismatches = @(Get-ExchangeDistributionGroupMismatches $gOceanWrongNameRecipient $gOceanCollisionGroup $gOceanExactProfile)
Assert-True ($gOceanWrongNameMismatches -contains "name") "Group verification must reject the colliding visible name when the collision-safe directory Name is required"
Assert-True ($gOceanWrongNameMismatches -notcontains "display name") "A correct visible group DisplayName must remain independent of the collision-safe directory Name"
$gOceanWrongSmtpRecipient = [pscustomobject]@{
  Name = $gOceanCollisionGroup.DirectoryName
  DisplayName = $gOceanCollisionGroup.GroupName
  Alias = $gOceanCollisionGroup.Alias
  PrimarySmtpAddress = "$($gOceanCollisionGroup.Alias)@wrong.example"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = $gOceanCollisionGroup.SourceKey
  HiddenFromAddressListsEnabled = $false
}
$gOceanWrongSmtpMismatches = @(Get-ExchangeDistributionGroupMismatches $gOceanWrongSmtpRecipient $gOceanCollisionGroup $gOceanExactProfile)
Assert-True ($gOceanWrongSmtpMismatches -contains "primary SMTP address") "Group verification must reject an Exchange PrimarySmtpAddress that differs from the certified projection"
$gOceanCreateChanges = @(Get-FullGroupMutationFieldChanges $null $null $gOceanCollisionGroup $true)
Assert-True ($gOceanCreateChanges -contains "Name: (missing) -> $($gOceanCollisionGroup.DirectoryName)") "The sync notice must report the exact collision-safe group directory Name"
Assert-True ($gOceanCreateChanges -contains "Group name: (missing) -> G OCEAN") "The sync notice must separately preserve the exact visible group name"
Assert-True ($gOceanCreateChanges -contains "Primary SMTP address: (missing) -> $($gOceanCollisionGroup.SmtpAddress)") "The sync notice must report the exact certified group SMTP address"

$contactGroupCollisionFingerprint = Get-CanonicalExchangeProjectionFingerprint $contactGroupCollisionRows
$contactGroupCollisionFingerprintVariant = Build-ExchangeRows $contactGroupCollisionContacts $contactGroupCollisionGroups $contactGroupCollisionMembers
$contactGroupCollisionFingerprintVariant.GroupById["g-ocean-group"].DirectoryName = "G OCEAN [fingerprint-variant]"
Assert-True ($contactGroupCollisionFingerprint -cne (Get-CanonicalExchangeProjectionFingerprint $contactGroupCollisionFingerprintVariant)) "The canonical fingerprint must include each group's collision-safe directory Name"

$differentAliasNamePeers = Build-ExchangeRows @(
  [pscustomobject]@{ id = "peer-existing"; source_book = "FCUNO"; display_name = "SHARED VISIBLE NAME"; primary_email = "existing@example.com"; nickname = "EXISTING NICKNAME"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" },
  [pscustomobject]@{ id = "peer-new"; source_book = "FCUNO"; display_name = "SHARED VISIBLE NAME"; primary_email = "new@example.com"; nickname = "DIFFERENT NICKNAME"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
) @() @()
$savedDirectoryPeerUpsert = (Get-Item Function:Upsert-ExchangeMailContact).ScriptBlock
$savedDirectoryPeerGroupUpsert = (Get-Item Function:Upsert-ExchangeDistributionGroup).ScriptBlock
$script:directoryPeerUpserts = @()
$script:directoryPeerEvents = @()
Set-Item Function:Upsert-ExchangeMailContact -Value {
  param($Contact, [hashtable]$Stats, [bool]$SkipNoOpWrites)
  $script:directoryPeerUpserts += [pscustomobject]@{ SourceKey = Clean-Text $Contact.SourceKey; SkipNoOpWrites = $SkipNoOpWrites }
  $script:directoryPeerEvents += "contact:$(Clean-Text $Contact.SourceKey)"
}
Set-Item Function:Upsert-ExchangeDistributionGroup -Value {
  param($Group, [hashtable]$Stats, [bool]$SkipNoOpWrites)
  $script:directoryPeerEvents += "group:$(Clean-Text $Group.SourceKey)"
}
try {
  $script:CanonicalExchangeRows = $differentAliasNamePeers
  Sync-ExchangeDirectoryNamePeers "SHARED VISIBLE NAME" @{} "FCUNO_CONTACT:peer-new" $false
  Assert-Equal 1 $script:directoryPeerUpserts.Count "A new duplicate display name must fan out to an existing peer even when nicknames and aliases differ"
  Assert-Equal "FCUNO_CONTACT:peer-existing" $script:directoryPeerUpserts[0].SourceKey "Directory-name fan-out must exclude only the queued source contact"
  Assert-True ([bool]$script:directoryPeerUpserts[0].SkipNoOpWrites) "Dependency peers must use verified no-op suppression"

  $loneDirectorySurvivor = Build-ExchangeRows @(
    [pscustomobject]@{ id = "peer-existing"; source_book = "FCUNO"; display_name = "SHARED VISIBLE NAME"; primary_email = "existing@example.com"; nickname = "EXISTING NICKNAME"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
  ) @() @()
  $script:CanonicalExchangeRows = $loneDirectorySurvivor
  $script:directoryPeerUpserts = @()
  Sync-ExchangeDirectoryNamePeers "SHARED VISIBLE NAME" @{} "FCUNO_CONTACT:peer-deleted" $true
  Assert-Equal 1 $script:directoryPeerUpserts.Count "Deleting or internalizing a duplicate must repair the lone survivor's directory name"
  Assert-Equal "SHARED VISIBLE NAME" $loneDirectorySurvivor.Contacts[0].DirectoryName "A lone survivor must deterministically revert to the unsuffixed directory name"

  $mixedDirectoryPeerRows = Build-ExchangeRows @(
    [pscustomobject]@{ id = "mixed-contact-survivor"; source_book = "FCUNO"; display_name = "MIXED DIRECTORY NAME"; primary_email = "mixed.survivor@example.com"; nickname = "MIXED CONTACT"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
  ) @(
    [pscustomobject]@{ id = "mixed-group"; source_book = "FCUNO"; name = "MIXED DIRECTORY NAME"; nickname = "MIXED GROUP"; source_uid = "mixed-group"; description = "Mixed peer group" }
  ) @(
    [pscustomobject]@{ group_id = "mixed-group"; contact_id = "mixed-contact-survivor"; source_book = "FCUNO" }
  )
  $script:CanonicalExchangeRows = $mixedDirectoryPeerRows
  $script:directoryPeerEvents = @()
  Sync-ExchangeDirectoryNamePeers "MIXED DIRECTORY NAME" @{} "FCUNO_CONTACT:mixed-contact-deleted" $true
  Assert-Equal `
    "group:FCUNO_GROUP:mixed-group,contact:FCUNO_CONTACT:mixed-contact-survivor" `
    ($script:directoryPeerEvents -join ",") `
    "A collision peer vacating the unsuffixed Name must update before the surviving contact claims it"

  $script:directoryPeerEvents = @()
  Reconcile-ExchangeContactEmail `
    "mixed.survivor@example.com" `
    ([pscustomobject]@{ entity_id = "mixed-contact-deleted"; entity_alias = "mixed-contact-deleted" }) `
    @{} `
    $false `
    $false
  Assert-Equal `
    "group:FCUNO_GROUP:mixed-group,contact:FCUNO_CONTACT:mixed-contact-survivor" `
    ($script:directoryPeerEvents -join ",") `
    "A promoted canonical duplicate must vacate its desired Name peers before the contact upsert"

  $internalAliasCollisionRows = Build-ExchangeRows @(
    [pscustomobject]@{ id = "internal-alias-owner"; source_book = "FC-INTERNAL"; display_name = "Internal Alias Owner"; primary_email = "z-internal@lantana.hk"; nickname = "RESERVED ALIAS"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" },
    [pscustomobject]@{ id = "external-alias-peer"; source_book = "FCUNO"; display_name = "External Alias Peer"; primary_email = "a-external@example.com"; nickname = "RESERVED ALIAS"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
  ) @() @()
  $script:CanonicalExchangeRows = $internalAliasCollisionRows
  $script:directoryPeerUpserts = @()
  Sync-ExchangeAliasPeers "reserved-alias" @{} $false $true
  Assert-Equal 1 $script:directoryPeerUpserts.Count "An internal alias owner must still fan out to the one managed external peer"
  Assert-Equal "reserved-alias" $internalAliasCollisionRows.ContactById["internal-alias-owner"].Alias "FC-INTERNAL must reserve the base alias even when its email sorts after the managed external peer"
  Assert-True ($internalAliasCollisionRows.Contacts[0].Alias -ne "reserved-alias") "The managed external peer must retain the deterministic collision-safe alias reserved by FC-INTERNAL"
} finally {
  Set-Item Function:Upsert-ExchangeMailContact -Value $savedDirectoryPeerUpsert
  Set-Item Function:Upsert-ExchangeDistributionGroup -Value $savedDirectoryPeerGroupUpsert
  $script:CanonicalExchangeRows = $null
}

$internalAliasRows = Build-ExchangeRows @(
  [pscustomobject]@{ id = "c-internal-alias"; source_book = "FC-INTERNAL"; display_name = "CIRIC CHEUNG"; primary_email = "ciric@lantana.hk"; nickname = ""; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
) @(
  [pscustomobject]@{ id = "g-internal"; source_book = "FC-INTERNAL"; name = "Internal Group"; nickname = "INTERNAL GROUP"; source_uid = "g-internal"; description = "" }
) @(
  [pscustomobject]@{ group_id = "g-internal"; contact_id = "c-internal-alias"; source_book = "FC-INTERNAL" }
)
Assert-Equal 0 @($internalAliasRows.Contacts).Count "FC-INTERNAL users must not be duplicated as managed mail contacts when their mailbox uses a non-Cosulich domain"
Assert-Equal 1 @($internalAliasRows.Members).Count "FC-INTERNAL users must remain available for distribution-group membership resolution"
Assert-Equal "ciric@lantana.hk" $internalAliasRows.ContactById["c-internal-alias"].ExternalEmailAddress "An FC-INTERNAL mailbox alias must remain addressable by group membership"
Assert-True (Is-InternalContact $internalAliasRows.ContactById["c-internal-alias"] "ciric@lantana.hk") "Incremental projection rows must preserve FC-INTERNAL classification"
$script:CanonicalExchangeRows = $internalAliasRows
Assert-True ($null -eq (Get-ContactExchangeRowFromSource "c-internal-alias")) "Incremental source lookup must never return an FC-INTERNAL row for mail-contact upsert"
$originalUpsertExchangeMailContactForInternal = (Get-Item Function:Upsert-ExchangeMailContact).ScriptBlock
$originalRemoveManagedExchangeMailContactForInternal = (Get-Item Function:Remove-ManagedExchangeMailContact).ScriptBlock
$script:internalIncrementalUpserts = 0
$script:internalIncrementalCleanup = 0
$script:internalCleanupOwnerSets = @()
Set-Item Function:Upsert-ExchangeMailContact -Value {
  param($Contact, [hashtable]$Stats)
  $script:internalIncrementalUpserts += 1
}
Set-Item Function:Remove-ManagedExchangeMailContact -Value {
  param($Email, $Alias, [hashtable]$Stats, $SourceContactId, $ExpectedDisplayName, [bool]$AllowUntaggedExactDelete, $AllowedOwnerSourceKeys)
  $script:internalIncrementalCleanup += 1
  Assert-Equal "c-internal-alias" $SourceContactId "Internal cleanup must remain scoped to the exact FCUNO source contact"
  Assert-True (@($AllowedOwnerSourceKeys) -contains "FCUNO_CONTACT:c-internal-alias") "Internal cleanup must carry the projection-bounded owner set"
  $script:internalCleanupOwnerSets += ,@($AllowedOwnerSourceKeys)
}
try {
  Reconcile-ExchangeContactEmail "ciric@lantana.hk" ([pscustomobject]@{ entity_id = "c-internal-alias"; entity_alias = "CIRIC CHEUNG" }) @{} $false $false
  Assert-Equal 0 $script:internalIncrementalUpserts "Incremental CIRIC reconciliation must never create or update a mail contact"
  Assert-Equal 1 $script:internalIncrementalCleanup "Incremental CIRIC reconciliation must remove only a stale managed copy through its exact source key"
  $auditedHistoricalInternalRow = [pscustomobject]@{
    entity_id = "c-former-managed-duplicate"
    entity_alias = "FORMER MANAGED DUPLICATE"
    audit_log_id = "99999999-8888-4777-8666-555555555555"
    payload = [pscustomobject]@{ userAuthorized = $true }
  }
  Reconcile-ExchangeContactEmail "ciric@lantana.hk" $auditedHistoricalInternalRow @{} $true $true
  Assert-True (@($script:internalCleanupOwnerSets[1]) -contains "FCUNO_CONTACT:c-former-managed-duplicate") "An audit-authorized before-email internal cleanup must include its exact queued historical owner"
  Reconcile-ExchangeContactEmail "ciric@lantana.hk" $auditedHistoricalInternalRow @{} $false $false
  Assert-True (@($script:internalCleanupOwnerSets[2]) -notcontains "FCUNO_CONTACT:c-former-managed-duplicate") "The current-email internal cleanup leg must not inherit the historical audit owner exception"
} finally {
  Set-Item Function:Upsert-ExchangeMailContact -Value $originalUpsertExchangeMailContactForInternal
  Set-Item Function:Remove-ManagedExchangeMailContact -Value $originalRemoveManagedExchangeMailContactForInternal
  $script:CanonicalExchangeRows = $null
}

$savedLoadSingleRowForInternalAlias = (Get-Item Function:Load-SingleRow).ScriptBlock
$savedReconcileEmailForInternalAlias = (Get-Item Function:Reconcile-ExchangeContactEmail).ScriptBlock
$savedSyncGroupsForInternalAlias = (Get-Item Function:Sync-ExchangeGroupsForEmail).ScriptBlock
$savedSyncAliasPeersForInternalAlias = (Get-Item Function:Sync-ExchangeAliasPeers).ScriptBlock
$savedSyncDirectoryPeersForInternalAlias = (Get-Item Function:Sync-ExchangeDirectoryNamePeers).ScriptBlock
$script:internalAliasFanoutCalls = @()
Set-Item Function:Load-SingleRow -Value {
  param($Table, $Column, $Value)
  return [pscustomobject]@{ id = "internal-alias-owner"; source_book = "FC-INTERNAL"; display_name = "Internal Alias Owner"; primary_email = "z-internal@lantana.hk"; nickname = "RESERVED ALIAS" }
}
Set-Item Function:Reconcile-ExchangeContactEmail -Value { param($Email, $Row, [hashtable]$Stats, [bool]$UseQueuedSourceKeyForDelete, [bool]$AllowQueuedHistoricalOwner) }
Set-Item Function:Sync-ExchangeGroupsForEmail -Value { param($Email, [hashtable]$Stats) }
Set-Item Function:Sync-ExchangeDirectoryNamePeers -Value { param($DisplayName, [hashtable]$Stats, $ExcludeSourceKey, [bool]$IncludeSinglePeer) }
Set-Item Function:Sync-ExchangeAliasPeers -Value {
  param($BaseAlias, [hashtable]$Stats, [bool]$SkipNoOpWrites, [bool]$IncludeSinglePeer)
  $script:internalAliasFanoutCalls += [pscustomobject]@{ BaseAlias = Clean-Text $BaseAlias; IncludeSinglePeer = $IncludeSinglePeer }
}
try {
  $script:CanonicalExchangeRows = $internalAliasCollisionRows
  Sync-ExchangeContactQueueState ([pscustomobject]@{
    entity_id = "internal-alias-owner"
    entity_alias = "old-reserved-alias"
    entity_email = "z-internal@lantana.hk"
    payload = [pscustomobject]@{
      beforeContact = [pscustomobject]@{ nickname = "OLD RESERVED ALIAS"; display_name = "Internal Alias Owner"; primary_email = "z-internal@lantana.hk"; source_book = "FC-INTERNAL" }
    }
  }) @{}
  $currentInternalAliasFanout = @($script:internalAliasFanoutCalls | Where-Object { $_.BaseAlias -eq "reserved-alias" })
  Assert-Equal 1 $currentInternalAliasFanout.Count "An FC-INTERNAL rename must fan out through its current raw projected base alias"
  Assert-True ([bool]$currentInternalAliasFanout[0].IncludeSinglePeer) "An internal alias dependency must repair even one managed external peer"
} finally {
  Set-Item Function:Load-SingleRow -Value $savedLoadSingleRowForInternalAlias
  Set-Item Function:Reconcile-ExchangeContactEmail -Value $savedReconcileEmailForInternalAlias
  Set-Item Function:Sync-ExchangeGroupsForEmail -Value $savedSyncGroupsForInternalAlias
  Set-Item Function:Sync-ExchangeAliasPeers -Value $savedSyncAliasPeersForInternalAlias
  Set-Item Function:Sync-ExchangeDirectoryNamePeers -Value $savedSyncDirectoryPeersForInternalAlias
  $script:CanonicalExchangeRows = $null
}

$contactQueueOrderingRows = Build-ExchangeRows @(
  [pscustomobject]@{ id = "contact-ordering"; source_book = "FCUNO"; display_name = "NEW CONTACT NAME"; primary_email = "contact.ordering@example.com"; nickname = "CONTACT ORDERING"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
) @() @()
$savedLoadSingleRowForContactOrder = (Get-Item Function:Load-SingleRow).ScriptBlock
$savedReconcileEmailForContactOrder = (Get-Item Function:Reconcile-ExchangeContactEmail).ScriptBlock
$savedSyncGroupsForContactOrder = (Get-Item Function:Sync-ExchangeGroupsForEmail).ScriptBlock
$savedSyncAliasPeersForContactOrder = (Get-Item Function:Sync-ExchangeAliasPeers).ScriptBlock
$savedSyncDirectoryPeersForContactOrder = (Get-Item Function:Sync-ExchangeDirectoryNamePeers).ScriptBlock
$script:contactOrderSourceExists = $true
$script:contactQueueOrderEvents = @()
Set-Item Function:Load-SingleRow -Value {
  param($Table, $Column, $Value)
  if (-not $script:contactOrderSourceExists) { return $null }
  return [pscustomobject]@{ id = "contact-ordering"; source_book = "FCUNO"; display_name = "NEW CONTACT NAME"; primary_email = "contact.ordering@example.com"; nickname = "CONTACT ORDERING" }
}
Set-Item Function:Reconcile-ExchangeContactEmail -Value {
  param($Email, $Row, [hashtable]$Stats, [bool]$UseQueuedSourceKeyForDelete, [bool]$AllowQueuedHistoricalOwner)
  $script:contactQueueOrderEvents += "mutate:$(Normalize-Email $Email)"
}
Set-Item Function:Sync-ExchangeGroupsForEmail -Value { param($Email, [hashtable]$Stats) }
Set-Item Function:Sync-ExchangeAliasPeers -Value { param($BaseAlias, [hashtable]$Stats, [bool]$SkipNoOpWrites, [bool]$IncludeSinglePeer) }
Set-Item Function:Sync-ExchangeDirectoryNamePeers -Value {
  param($DisplayName, [hashtable]$Stats, $ExcludeSourceKey, [bool]$IncludeSinglePeer)
  $script:contactQueueOrderEvents += "peers:$(Clean-Text $DisplayName):$IncludeSinglePeer"
}
try {
  $script:CanonicalExchangeRows = $contactQueueOrderingRows
  $contactRenameQueueRow = [pscustomobject]@{
    entity_id = "contact-ordering"
    entity_alias = "contact-ordering"
    entity_email = "contact.ordering@example.com"
    display_name = "OLD CONTACT NAME"
    payload = [pscustomobject]@{
      beforeContact = [pscustomobject]@{ display_name = "OLD CONTACT NAME"; primary_email = "contact.ordering@example.com"; nickname = "CONTACT ORDERING" }
    }
  }
  Sync-ExchangeContactQueueState $contactRenameQueueRow @{}
  Assert-Equal `
    "mutate:contact.ordering@example.com,peers:OLD CONTACT NAME:True" `
    ($script:contactQueueOrderEvents -join ",") `
    "After contact reconciliation handles the new Name, the queue must repair old-name survivors only after the contact vacates its old Name"

  $script:contactOrderSourceExists = $false
  $script:contactQueueOrderEvents = @()
  Sync-ExchangeContactQueueState $contactRenameQueueRow @{}
  Assert-Equal `
    "mutate:contact.ordering@example.com,peers:OLD CONTACT NAME:True" `
    ($script:contactQueueOrderEvents -join ",") `
    "A deleted contact must be removed before an old-name peer can reclaim the unsuffixed Exchange Name"
} finally {
  Set-Item Function:Load-SingleRow -Value $savedLoadSingleRowForContactOrder
  Set-Item Function:Reconcile-ExchangeContactEmail -Value $savedReconcileEmailForContactOrder
  Set-Item Function:Sync-ExchangeGroupsForEmail -Value $savedSyncGroupsForContactOrder
  Set-Item Function:Sync-ExchangeAliasPeers -Value $savedSyncAliasPeersForContactOrder
  Set-Item Function:Sync-ExchangeDirectoryNamePeers -Value $savedSyncDirectoryPeersForContactOrder
  $script:CanonicalExchangeRows = $null
}

$savedLoadSingleRowForGroupOrder = (Get-Item Function:Load-SingleRow).ScriptBlock
$savedGetGroupRowsForGroupOrder = (Get-Item Function:Get-GroupExchangeRowsFromSource).ScriptBlock
$savedSyncGroupStateForGroupOrder = (Get-Item Function:Sync-ExchangeGroupState).ScriptBlock
$savedSyncAliasPeersForGroupOrder = (Get-Item Function:Sync-ExchangeAliasPeers).ScriptBlock
$savedSyncDirectoryPeersForGroupOrder = (Get-Item Function:Sync-ExchangeDirectoryNamePeers).ScriptBlock
$script:groupOrderProjected = $true
$script:groupQueueOrderEvents = @()
$groupQueueOrderingDesired = [pscustomobject]@{
  SourceGroupId = "group-ordering"
  GroupName = "NEW GROUP NAME"
  DirectoryName = "NEW GROUP NAME"
  BaseAlias = "new-group-name"
  Alias = "new-group-name"
  Description = "Ordering test"
  MemberCount = 1
  SourceKey = "FCUNO_GROUP:group-ordering"
}
Set-Item Function:Load-SingleRow -Value {
  param($Table, $Column, $Value)
  return [pscustomobject]@{ id = "group-ordering"; source_book = "FCUNO"; name = "NEW GROUP NAME"; nickname = "NEW GROUP NAME" }
}
Set-Item Function:Get-GroupExchangeRowsFromSource -Value {
  param($GroupId)
  return @{ Groups = $(if ($script:groupOrderProjected) { @($groupQueueOrderingDesired) } else { @() }); Members = @() }
}
Set-Item Function:Sync-ExchangeGroupState -Value {
  param($GroupId, $FallbackAlias, [hashtable]$Stats, $FallbackDisplayName = "", [bool]$AllowUntaggedExactDelete = $false)
  $script:groupQueueOrderEvents += "mutate:$(Clean-Text $GroupId)"
}
Set-Item Function:Sync-ExchangeAliasPeers -Value { param($BaseAlias, [hashtable]$Stats, [bool]$SkipNoOpWrites, [bool]$IncludeSinglePeer) }
Set-Item Function:Sync-ExchangeDirectoryNamePeers -Value {
  param($DisplayName, [hashtable]$Stats, $ExcludeSourceKey, [bool]$IncludeSinglePeer)
  $script:groupQueueOrderEvents += "peers:$(Clean-Text $DisplayName):$IncludeSinglePeer"
}
try {
  $groupRenameQueueRow = [pscustomobject]@{
    entity_id = "group-ordering"
    entity_alias = "old-group-name"
    display_name = "OLD GROUP NAME"
    payload = [pscustomobject]@{
      beforeGroup = [pscustomobject]@{ name = "OLD GROUP NAME"; nickname = "OLD GROUP NAME" }
    }
  }
  Sync-ExchangeGroupQueueState $groupRenameQueueRow @{}
  Assert-Equal `
    "peers:NEW GROUP NAME:False,mutate:group-ordering,peers:OLD GROUP NAME:True" `
    ($script:groupQueueOrderEvents -join ",") `
    "A group rename must move new-name blockers before mutation and repair old-name survivors only after the group vacates its old Name"

  $script:groupOrderProjected = $false
  $script:groupQueueOrderEvents = @()
  Sync-ExchangeGroupQueueState $groupRenameQueueRow @{}
  Assert-Equal `
    "mutate:group-ordering,peers:OLD GROUP NAME:True" `
    ($script:groupQueueOrderEvents -join ",") `
    "A last-member removal must delete the now-empty Exchange group before an old-name peer reclaims its Name"
} finally {
  Set-Item Function:Load-SingleRow -Value $savedLoadSingleRowForGroupOrder
  Set-Item Function:Get-GroupExchangeRowsFromSource -Value $savedGetGroupRowsForGroupOrder
  Set-Item Function:Sync-ExchangeGroupState -Value $savedSyncGroupStateForGroupOrder
  Set-Item Function:Sync-ExchangeAliasPeers -Value $savedSyncAliasPeersForGroupOrder
  Set-Item Function:Sync-ExchangeDirectoryNamePeers -Value $savedSyncDirectoryPeersForGroupOrder
}

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
Assert-Equal `
  "f5847eff319cad03ba72c507f19322697070f58408e7e549b843b7373db5b6fb" `
  $firstFingerprint `
  "The exact canonical projection serializer and SHA-256 contract must remain byte-for-byte stable"
$script:ExchangeAddressBookDomain = "alternate.onmicrosoft.com"
$wrongRuntimeDomainRejected = $false
try {
  Get-CanonicalExchangeProjectionFingerprint `
    (Build-ExchangeRows $contacts $groups $members) | Out-Null
} catch {
  $wrongRuntimeDomainRejected = $_.Exception.Message -match "cosulich1\.onmicrosoft\.com"
} finally {
  $script:ExchangeAddressBookDomain = "cosulich1.onmicrosoft.com"
}
Assert-True $wrongRuntimeDomainRejected "Changing the runtime Exchange group domain must fail before any projection can be certified"
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
$queueHighWaterOriginalInvokeSupabaseRest = (Get-Item Function:Invoke-SupabaseRest).ScriptBlock
$script:queueHighWaterResponse = $null
Set-Item Function:Invoke-SupabaseRest -Value {
  param($Method, $Path, $Body = $null)
  return $script:queueHighWaterResponse
}
try {
  Assert-Equal "0" (Get-ExchangeQueueHighWater) "An empty durable queue must retain its zero high-water fence"
  $preciseQueueUpdatedAt = [DateTime]::new(2026, 7, 22, 11, 32, 18, [DateTimeKind]::Utc).AddTicks(5895450)
  $script:queueHighWaterResponse = [pscustomobject]@{
    queue_sequence = 42
    updated_at = $preciseQueueUpdatedAt
  }
  $preciseQueueHighWater = Get-ExchangeQueueHighWater
  Assert-Equal "42@2026-07-22T11:32:18.5895450Z" $preciseQueueHighWater "A materialized DateTime queue timestamp must retain its ticks in invariant round-trip ISO form"
  $preciseParsedQueueFence = ConvertFrom-ExchangeQueueHighWater $preciseQueueHighWater
  Assert-Equal 42 $preciseParsedQueueFence.Sequence "The precise queue fence must preserve its sequence"
  Assert-Equal "2026-07-22T11:32:18.5895450Z" $preciseParsedQueueFence.UpdatedAt "The precise queue fence passed to the certification RPC must preserve the exact invariant ISO timestamp"
} finally {
  Set-Item Function:Invoke-SupabaseRest -Value $queueHighWaterOriginalInvokeSupabaseRest
  $script:queueHighWaterResponse = $null
}
$preciseOffsetQueueTimestamp = [DateTimeOffset]::new(2026, 7, 22, 19, 32, 18, [TimeSpan]::FromHours(8)).AddTicks(5895450)
Assert-Equal "2026-07-22T19:32:18.5895450+08:00" (ConvertTo-ExchangeQueueTimestampText $preciseOffsetQueueTimestamp) "A materialized DateTimeOffset queue timestamp must retain its ticks and explicit offset"
Assert-Equal "2026-07-22T19:32:18.5895450+08:00" (ConvertTo-ExchangeQueueTimestampText "2026-07-22T19:32:18.589545+08:00") "An already serialized ISO queue timestamp must retain its fractional ticks and offset in invariant round-trip form"
Assert-True (Test-ExchangeQueueFenceTimestampMatch $preciseQueueUpdatedAt "2026-07-22T11:32:18.589545+00:00") "A materialized DateTime certification receipt must match the exact submitted queue timestamp without locale formatting loss"
Assert-True (Test-ExchangeQueueFenceTimestampMatch $preciseOffsetQueueTimestamp "2026-07-22T11:32:18.589545Z") "A materialized DateTimeOffset certification receipt must compare by exact UTC ticks across equivalent offsets"
Assert-True (-not (Test-ExchangeQueueFenceTimestampMatch $preciseQueueUpdatedAt "2026-07-22T11:32:18.589546Z")) "A certification receipt timestamp that differs by one microsecond must still fail the queue fence"
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
$script:projectionStageRpcCalls = 0
$script:projectionStageRpcBodies = @()
$script:rawStageRpcCalls = 0
$script:rawStageRpcBodies = @()
$script:certificationRpcCalls = 0
$script:certificationRpcBodies = @()
$script:templateReconciliationRpcCalls = 0
$script:templateReconciliationRpcBodies = @()
$script:capturedResolvedSubject = ""
$script:capturedResolvedHtml = ""
$atomicProjectionCanonicalJson = Get-CanonicalExchangeProjectionJson $built
$atomicProjectionFingerprint = Get-Sha256Hex $atomicProjectionCanonicalJson
$atomicProjectionCounts = Get-CanonicalExchangeProjectionCounts $built
$atomicVerificationSummary = [ordered]@{
  status = "match"
  mismatchCount = 0
  verifiedManagedContacts = 2
  verifiedManagedGroups = 2
  verifiedMembershipGroups = 2
  verifiedMemberships = 2
  sourceFenceStable = $true
  queueFence = "42@2026-07-22T07:15:00Z"
  sourceFingerprint = $atomicProjectionFingerprint
}
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
  if ($Path -eq "rpc/stage_outlook_exchange_projection_snapshot") {
    $script:projectionStageRpcCalls += 1
    $script:projectionStageRpcBodies += [pscustomobject]@{
      fingerprint = $Body.p_source_fingerprint
      projectionCanonicalJson = $Body.p_projection_canonical_json
      projectionCounts = $Body.p_projection_counts
      verificationSummary = $Body.p_verification_summary
      workerVersion = $Body.p_worker_version
    }
    if ($script:projectionStageRpcCalls -eq 1) {
      throw "The HTTP response was lost after immutable projection staging committed."
    }
    return [pscustomobject]@{
      staged = $true
      idempotent = $true
      reason = "The exact canonical Exchange projection was already staged."
      sourceFingerprint = $atomicProjectionFingerprint
      projectionSnapshotHash = $atomicProjectionFingerprint
      projectionCounts = $atomicProjectionCounts
      workerVersion = $ExchangeTruthWorkerVersion
      supersededCount = 0
      supersededRows = @()
    }
  }
  if ($Path -eq "rpc/stage_outlook_exchange_raw_source_snapshot") {
    $script:rawStageRpcCalls += 1
    $script:rawStageRpcBodies += [pscustomobject]@{
      run = $Body.p_run_id
      sequence = $Body.p_queue_high_water_sequence
      updatedAt = $Body.p_queue_high_water_updated_at
      fingerprint = $Body.p_source_fingerprint
    }
    if ($script:rawStageRpcCalls -eq 1) {
      throw "The HTTP response was lost after immutable raw-source staging committed."
    }
    return [pscustomobject]@{
      staged = $true
      idempotent = $true
      reason = "The exact raw FCUNO source snapshot was already staged."
      runId = $script:CurrentQueueRunId
      sourceFingerprint = $atomicProjectionFingerprint
      rawSourceSnapshotHash = ("b" * 64)
      rawSourceCounts = [pscustomobject]@{
        contacts = 2
        groups = 2
        members = 2
      }
      supersededCount = 0
      supersededRows = @()
      queueFence = [pscustomobject]@{
        expectedSequence = 42
        expectedUpdatedAt = "2026-07-22T07:15:00Z"
        currentSequence = 42
        currentUpdatedAt = "2026-07-22T07:15:00Z"
      }
    }
  }
  if ($Path -eq "rpc/certify_staged_full_outlook_exchange_truth") {
    $script:certificationRpcCalls += 1
    $script:certificationRpcBodies += [pscustomobject]@{
      run = $Body.p_run_id
      sequence = $Body.p_queue_high_water_sequence
      updatedAt = $Body.p_queue_high_water_updated_at
      fingerprint = $Body.p_source_fingerprint
      rawSourceSnapshotHash = $Body.p_raw_source_snapshot_hash
      projectionCounts = $Body.p_projection_counts
      rawSourceCounts = $Body.p_raw_source_counts
      verificationSummary = $Body.p_verification_summary
      workerVersion = $Body.p_worker_version
    }
    if ($script:certificationRpcCalls -eq 1) { throw "The HTTP response was lost after full certification committed." }
    return [pscustomobject]@{
      certified = $true
      idempotent = $true
      reason = "This full certification run was already committed; returning its durable result."
      runId = $script:CurrentQueueRunId
      certifiedAt = "2026-07-22T07:21:00Z"
      sourceFingerprint = $atomicProjectionFingerprint
      evidenceRecorded = $true
      truthLedgerSequence = 123
      truthLedgerHash = ("a" * 64)
      sourceSnapshotHash = $atomicProjectionFingerprint
      rawSourceSnapshotHash = ("b" * 64)
      workerVersion = $ExchangeTruthWorkerVersion
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
  if ($Path -eq "rpc/reconcile_outlook_templates_with_certification_batch") {
    $script:templateReconciliationRpcCalls += 1
    $script:templateReconciliationRpcBodies += [pscustomobject]@{
      run = $Body.p_run_id
      fingerprint = $Body.p_source_fingerprint
      batchLimit = $Body.p_batch_limit
    }
    if ($script:templateReconciliationRpcCalls -eq 1) {
      throw "The HTTP response was lost after a bounded Outlook-template reconciliation batch committed."
    }
    if ($script:templateReconciliationRpcCalls -eq 2) {
      return [pscustomobject]@{
        processed = $true
        idempotent = $false
        reason = "One bounded Outlook template recipient batch was reconciled."
        runId = $script:CurrentQueueRunId
        sourceFingerprint = $atomicProjectionFingerprint
        certifiedAt = "2026-07-22T07:21:00Z"
        reconciledAt = "2026-07-22T07:21:05Z"
        complete = $false
        currentTemplates = 531
        remainingTemplates = 25
        verification = $null
        batch = [pscustomobject]@{
          limit = 25
          selected = 25
          updated = 25
        }
        supersededCount = 0
        supersededRows = @()
      }
    }
    return [pscustomobject]@{
      processed = $true
      idempotent = $false
      reason = "Outlook template recipient evidence is fully reconciled."
      runId = $script:CurrentQueueRunId
      sourceFingerprint = $atomicProjectionFingerprint
      certifiedAt = "2026-07-22T07:21:00Z"
      reconciledAt = "2026-07-22T07:21:10Z"
      complete = $true
      currentTemplates = 556
      remainingTemplates = 0
      verification = [pscustomobject]@{
        schema = "fcuno.outlook-template-recipient-truth/v2"
        valid = $true
        allTemplatesSendable = $false
        sourceTruthValid = $true
        certificationRunId = $script:CurrentQueueRunId
        certifiedAt = "2026-07-22T07:21:00Z"
        sourceFingerprint = $atomicProjectionFingerprint
        templates = [pscustomobject]@{
          total = 556
          unresolved = 0
          stale = 0
          invalidShape = 0
          withMissingRecipients = 51
          withAmbiguousRecipients = 1
          sendable = 504
        }
        queue = [pscustomobject]@{
          pending = 0
          processing = 0
          failed = 0
          terminalFailed = 0
        }
      }
      batch = [pscustomobject]@{
        limit = 25
        selected = 25
        updated = 25
      }
      supersededCount = 0
      supersededRows = @()
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
  $completionResult.completedRow.id = "45454545-4545-4454-8454-454545454545"
  Assert-True `
    ((Get-VerifiedExchangeQueueCompletionContractError $completionResult $atomicQueueRowId $script:CurrentQueueRunId) -match "requested queue row") `
    "Atomic completion must reject a durable receipt for a different queue row"
  $completionResult.completedRow.id = $atomicQueueRowId
  $completionResult.completedRow.runId = "46464646-4646-4464-8464-464646464646"
  Assert-True `
    ((Get-VerifiedExchangeQueueCompletionContractError $completionResult $atomicQueueRowId $script:CurrentQueueRunId) -match "active run") `
    "Atomic completion must reject a durable receipt for a different run"
  $completionResult.completedRow.runId = $script:CurrentQueueRunId

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
  Assert-Equal "" $resolvedDetail.queuedAt "A superseded receipt without an original createdAt value must never fabricate the current time as its queued time"

  $resolvedOutcome = Get-IncrementalSyncOutcome $resolvedStats
  Assert-Equal "completed" $resolvedOutcome.Status "Safely resolved terminal rows must not be reported as actionable skips or failures"
  $resolvedNotificationDelivery = Send-ExchangeSyncNotification "completed" $resolvedOutcome.Message $resolvedStats ([pscustomobject]@{
    requestedBy = "SC"
    requestedByEmail = "sc@example.com"
    requestedAt = "2026-07-22T07:22:00Z"
  })
  Assert-Equal "delivered" $resolvedNotificationDelivery.Status "A resolved-terminal notice must return an explicit successful delivery receipt"
  Assert-True ($script:capturedResolvedSubject -match "1 terminal resolved") "The notice subject must state how many terminal failures were resolved"
  Assert-True ($script:capturedResolvedHtml -match "Resolved") "The notice must visibly label a superseded terminal row as resolved"
  Assert-True ($script:capturedResolvedHtml -match "Old terminal Exchange error") "The notice must show the exact prior terminal error"
  Assert-True ($script:capturedResolvedHtml -match "processing_failed") "The notice must show the durable queue error history"
  Assert-True ($script:capturedResolvedHtml -match $atomicQueueRowId) "The notice must show the superseding verified queue row ID"

  $certificationResult = Commit-FullExchangeQueueCertification `
    "42@2026-07-22T07:15:00Z" `
    $atomicProjectionFingerprint `
    $atomicProjectionCanonicalJson `
    $atomicProjectionCounts `
    $atomicVerificationSummary
  Assert-Equal 2 $script:projectionStageRpcCalls "An ambiguous projection-stage response must retry against the immutable snapshot receipt"
  Assert-Equal 2 $script:rawStageRpcCalls "An ambiguous raw-source-stage response must retry against the immutable snapshot receipt"
  Assert-Equal 2 $script:certificationRpcCalls "An ambiguous full-certification response must retry against its durable certification receipt"
  Assert-True ([bool]$certificationResult.certified -and [bool]$certificationResult.idempotent) "A confirmed idempotent full-certification replay must count as success"
  Assert-True ([bool]$certificationResult.evidenceRecorded) "A successful full certification must confirm canonical projection evidence"
  Assert-Equal $script:projectionStageRpcBodies[0].fingerprint $script:projectionStageRpcBodies[1].fingerprint "Projection-stage retry must reuse the exact source fingerprint"
  Assert-Equal $script:projectionStageRpcBodies[0].projectionCanonicalJson $script:projectionStageRpcBodies[1].projectionCanonicalJson "Projection-stage retry must reuse the exact canonical JSON"
  Assert-Equal $script:rawStageRpcBodies[0].run $script:rawStageRpcBodies[1].run "Raw-source-stage retry must reuse the exact run UUID"
  Assert-Equal $script:rawStageRpcBodies[0].sequence $script:rawStageRpcBodies[1].sequence "Raw-source-stage retry must reuse the exact queue fence sequence"
  Assert-Equal $script:rawStageRpcBodies[0].updatedAt $script:rawStageRpcBodies[1].updatedAt "Raw-source-stage retry must reuse the exact queue fence timestamp"
  Assert-Equal $script:rawStageRpcBodies[0].fingerprint $script:rawStageRpcBodies[1].fingerprint "Raw-source-stage retry must reuse the exact source fingerprint"
  Assert-Equal $script:certificationRpcBodies[0].run $script:certificationRpcBodies[1].run "Full-certification retry must reuse the exact same run UUID"
  Assert-Equal $script:certificationRpcBodies[0].sequence $script:certificationRpcBodies[1].sequence "Full-certification retry must reuse the exact same queue fence sequence"
  Assert-Equal $script:certificationRpcBodies[0].updatedAt $script:certificationRpcBodies[1].updatedAt "Full-certification retry must reuse the exact same queue fence timestamp"
  Assert-Equal $script:certificationRpcBodies[0].fingerprint $script:certificationRpcBodies[1].fingerprint "Full-certification retry must reuse the exact same source fingerprint"
  Assert-Equal ("b" * 64) $script:certificationRpcBodies[0].rawSourceSnapshotHash "Final certification must consume the separately staged raw-source hash"
  Assert-Equal $atomicProjectionCanonicalJson $script:projectionStageRpcBodies[0].projectionCanonicalJson "Projection staging must submit the exact canonical JSON whose bytes produced the fingerprint"
  Assert-Equal $atomicProjectionFingerprint (Get-Sha256Hex $script:projectionStageRpcBodies[0].projectionCanonicalJson) "The staged canonical projection must hash to the submitted fingerprint"
  foreach ($countName in @("contacts", "groups", "members", "invalidContacts", "skippedInvalidContacts", "duplicateContacts")) {
    Assert-True ($script:projectionStageRpcBodies[0].projectionCounts.Contains($countName)) "Projection staging must submit the '$countName' canonical projection count"
    Assert-Equal `
      $atomicProjectionCounts[$countName] `
      $script:projectionStageRpcBodies[0].projectionCounts[$countName] `
      "Projection staging must submit the exact '$countName' canonical projection count"
  }
  Assert-Equal $atomicProjectionFingerprint $script:projectionStageRpcBodies[0].verificationSummary.sourceFingerprint "The projection-stage verification summary must link to the exact submitted projection fingerprint"
  Assert-True ([bool]$script:projectionStageRpcBodies[0].verificationSummary.sourceFenceStable) "The projection-stage verification summary must confirm that the source fence remained stable"
  Assert-Equal 2 $script:certificationRpcBodies[0].rawSourceCounts.contacts "Final certification must consume separately staged raw contact counts"
  Assert-Equal 2 $script:certificationRpcBodies[0].rawSourceCounts.groups "Final certification must consume separately staged raw group counts"
  Assert-Equal 2 $script:certificationRpcBodies[0].rawSourceCounts.members "Final certification must consume separately staged raw membership counts"
  Assert-Equal $ExchangeTruthWorkerVersion $script:certificationRpcBodies[0].workerVersion "Full certification must identify the exact truth-evidence worker contract"
  $certificationResult.runId = "47474747-4747-4474-8474-474747474747"
  Assert-True `
    ((Get-FullExchangeTruthCertificationContractError $certificationResult $script:CurrentQueueRunId $atomicProjectionFingerprint 42 "2026-07-22T07:15:00Z") -match "active run") `
    "Full certification must reject a durable receipt for a different run"
  $certificationResult.runId = $script:CurrentQueueRunId
  $certificationResult.queueFence.currentSequence = 43
  Assert-True `
    ((Get-FullExchangeTruthCertificationContractError $certificationResult $script:CurrentQueueRunId $atomicProjectionFingerprint 42 "2026-07-22T07:15:00Z") -match "submitted sequence") `
    "Full certification must reject a durable receipt whose current queue sequence differs from the submitted fence"
  $certificationResult.queueFence.currentSequence = 42
  $certificationResult.queueFence.currentUpdatedAt = "2026-07-22T07:15:01Z"
  Assert-True `
    ((Get-FullExchangeTruthCertificationContractError $certificationResult $script:CurrentQueueRunId $atomicProjectionFingerprint 42 "2026-07-22T07:15:00Z") -match "submitted timestamp") `
    "Full certification must reject a durable receipt whose current queue timestamp differs from the submitted fence"
  $certificationResult.queueFence.currentUpdatedAt = "2026-07-22T07:15:00Z"
  $fullResolvedStats = @{
    failedQueueRows = 0
    skippedQueueRows = 0
    resolvedTerminalQueueRows = 0
    verifiedManagedContacts = 2
    verifiedManagedGroups = 2
    groups = 2
    groupMembers = 2
    fullCertificationCommitted = $false
    fullCertificationIdempotent = $false
    changeDetails = @()
  }
  $projectionStageCallsBeforeEligibleFinalize = $script:projectionStageRpcCalls
  $rawStageCallsBeforeEligibleFinalize = $script:rawStageRpcCalls
  $certificationCallsBeforeEligibleFinalize = $script:certificationRpcCalls
  Complete-FullExchangeQueueCertificationIfEligible `
    $fullResolvedStats `
    "42@2026-07-22T07:15:00Z" `
    $atomicProjectionFingerprint `
    $atomicProjectionCanonicalJson `
    $atomicProjectionCounts `
    @() | Out-Null
  Assert-Equal ($projectionStageCallsBeforeEligibleFinalize + 1) $script:projectionStageRpcCalls "A zero-failure, zero-drift final projection must stage immutable projection evidence"
  Assert-Equal ($rawStageCallsBeforeEligibleFinalize + 1) $script:rawStageRpcCalls "A zero-failure, zero-drift final projection must stage immutable raw-source evidence"
  Assert-Equal ($certificationCallsBeforeEligibleFinalize + 1) $script:certificationRpcCalls "A zero-failure, zero-drift final projection must invoke durable full certification"
  Assert-True ([bool]$fullResolvedStats.fullCertificationCommitted) "A confirmed full-certification replay must be recorded as durably committed"
  Assert-True ([bool]$fullResolvedStats.fullCertificationIdempotent) "A confirmed certification receipt replay must retain its idempotent status"
  Assert-True ([bool]$fullResolvedStats.truthEvidenceRecorded) "An eligible full run must retain the durable projection-evidence confirmation"
  Assert-Equal 123 $fullResolvedStats.truthEvidenceLedgerSequence "An eligible full run must retain the projection-evidence ledger receipt sequence"
  Assert-Equal ("a" * 64) $fullResolvedStats.truthEvidenceLedgerHash "An eligible full run must retain the projection-evidence ledger receipt hash"
  Assert-Equal $atomicProjectionFingerprint $fullResolvedStats.sourceSnapshotHash "An eligible full run must retain the exact canonical projection snapshot hash"
  Assert-Equal ("b" * 64) $fullResolvedStats.rawSourceSnapshotHash "An eligible full run must retain the raw FCUNO source snapshot hash"
  Assert-Equal $ExchangeTruthWorkerVersion $fullResolvedStats.truthWorkerVersion "An eligible full run must retain the evidence worker version"
  Assert-Equal 3 $script:templateReconciliationRpcCalls "An ambiguous Outlook-template batch response must retry and then continue until every stale template is reconciled"
  Assert-Equal $script:templateReconciliationRpcBodies[0].run $script:templateReconciliationRpcBodies[1].run "Outlook-template reconciliation retry must reuse the exact certification run UUID"
  Assert-Equal $script:templateReconciliationRpcBodies[0].fingerprint $script:templateReconciliationRpcBodies[1].fingerprint "Outlook-template reconciliation retry must reuse the exact certified projection fingerprint"
  Assert-Equal 25 $script:templateReconciliationRpcBodies[0].batchLimit "Outlook-template reconciliation must keep every database transaction to a bounded batch"
  Assert-True ([bool]$fullResolvedStats.templateRecipientTruthReconciled) "A full run is not successful until Outlook-template recipient truth is reconciled"
  Assert-True (-not [bool]$fullResolvedStats.templateRecipientTruthIdempotent) "A completing Outlook-template batch that updates evidence must not be labeled idempotent"
  Assert-Equal 556 $fullResolvedStats.templateRecipientTruthUpdatedTemplates "The final batch receipt must report every template on current certified evidence"
  Assert-Equal 556 $fullResolvedStats.templateRecipientTruthTotalTemplates "The full run must retain the total Outlook-template verification count"
  Assert-Equal 504 $fullResolvedStats.templateRecipientTruthSendableTemplates "The full run must retain the currently sendable Outlook-template count"
  Assert-Equal 51 $fullResolvedStats.templateRecipientTruthMissingTemplates "Missing Outlook-template recipients must remain visible as safe send blocks"
  Assert-Equal 1 $fullResolvedStats.templateRecipientTruthAmbiguousTemplates "Ambiguous Outlook-template recipients must remain visible as safe send blocks"
  Assert-Equal 1 $fullResolvedStats.resolvedTerminalQueueRows "A successful full certification must count every terminal queue row it superseded"
  Assert-Equal $script:CurrentQueueRunId @($fullResolvedStats.changeDetails)[0].supersededByFullRunId "A full-certification resolution detail must show the certifying run ID"
  Assert-True (@($fullResolvedStats.changeDetails)[0].result -match "Old terminal full-sync error") "A full-certification resolution detail must retain the exact previous terminal error"

  $projectionStageCallsBeforeIneligibleFinalize = $script:projectionStageRpcCalls
  $rawStageCallsBeforeIneligibleFinalize = $script:rawStageRpcCalls
  $certificationCallsBeforeIneligibleFinalize = $script:certificationRpcCalls
  Complete-FullExchangeQueueCertificationIfEligible `
    @{ failedQueueRows = 1 } `
    "42@2026-07-22T07:15:00Z" `
    $atomicProjectionFingerprint `
    $atomicProjectionCanonicalJson `
    $atomicProjectionCounts `
    @() | Out-Null
  Assert-Equal $projectionStageCallsBeforeIneligibleFinalize $script:projectionStageRpcCalls "Any local full-sync failure must prevent projection evidence staging"
  Assert-Equal $rawStageCallsBeforeIneligibleFinalize $script:rawStageRpcCalls "Any local full-sync failure must prevent raw-source evidence staging"
  Assert-Equal $certificationCallsBeforeIneligibleFinalize $script:certificationRpcCalls "Any local full-sync failure must prevent the terminal supersession sweep"
  Complete-FullExchangeQueueCertificationIfEligible `
    @{ failedQueueRows = 0 } `
    "42@2026-07-22T07:15:00Z" `
    $atomicProjectionFingerprint `
    $atomicProjectionCanonicalJson `
    $atomicProjectionCounts `
    @("queue high-water changed") | Out-Null
  Assert-Equal $projectionStageCallsBeforeIneligibleFinalize $script:projectionStageRpcCalls "Any source/high-water drift must prevent projection evidence staging"
  Assert-Equal $rawStageCallsBeforeIneligibleFinalize $script:rawStageRpcCalls "Any source/high-water drift must prevent raw-source evidence staging"
  Assert-Equal $certificationCallsBeforeIneligibleFinalize $script:certificationRpcCalls "Any source/high-water drift must prevent the terminal supersession sweep"
} finally {
  Set-Item Function:Invoke-SupabaseRest -Value $atomicOriginalInvokeSupabaseRest
  Set-Item Function:Get-OptionalAutomationSetting -Value $atomicOriginalGetOptionalAutomationSetting
  Set-Item Function:Send-ExchangeSmtpMail -Value $atomicOriginalSendExchangeSmtpMail
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
}

$originalCommitFullExchangeQueueCertification = (Get-Item Function:Commit-FullExchangeQueueCertification).ScriptBlock
$failedCertificationPlaceholderStats = @{
  failedQueueRows = 0
  skippedQueueRows = 0
  skippedInvalidContacts = 0
  fullCertificationCommitted = $false
  fullCertificationIdempotent = $false
  changeDetails = @()
}
Set-Item Function:Commit-FullExchangeQueueCertification -Value {
  param($QueueHighWater, $SourceFingerprint, $ProjectionCanonicalJson, $ProjectionCounts, $VerificationSummary)
  throw "Simulated durable full-certification RPC failure."
}
try {
  Complete-FullExchangeQueueCertificationIfEligible `
    $failedCertificationPlaceholderStats `
    "42@2026-07-22T07:15:00Z" `
    $atomicProjectionFingerprint `
    $atomicProjectionCanonicalJson `
    $atomicProjectionCounts `
    @() | Out-Null
  Add-FullSyncGroupShadowPlaceholderDetail `
    $failedCertificationPlaceholderStats `
    $groupShadowRows.SkippedInvalidContacts[0] `
    ([bool]$failedCertificationPlaceholderStats.fullCertificationCommitted)
} finally {
  Set-Item Function:Commit-FullExchangeQueueCertification -Value $originalCommitFullExchangeQueueCertification
}
$failedCertificationPlaceholderDetail = @($failedCertificationPlaceholderStats.changeDetails | Where-Object { $_.actionLabel -eq "Skip group-shadow placeholder" })[0]
Assert-Equal 1 $failedCertificationPlaceholderStats.failedQueueRows "A durable certification RPC failure must mark the full run failed before placeholder details are emitted"
Assert-True (-not [bool]$failedCertificationPlaceholderStats.fullCertificationCommitted) "A durable certification RPC failure must leave the certification receipt uncommitted"
Assert-Equal "skipped" $failedCertificationPlaceholderDetail.status "The placeholder remains an explicit skipped row when durable certification fails"
Assert-True ($failedCertificationPlaceholderDetail.result -match "did not complete final certification") "The placeholder detail must state that certification did not complete after the RPC failure"
Assert-True ($failedCertificationPlaceholderDetail.result -notmatch "were certified as") "A failed durable certification RPC must never produce a certified placeholder claim"

$truthCheckpointOriginalInvokeSupabaseRest = (Get-Item Function:Invoke-SupabaseRest).ScriptBlock
$script:truthCheckpointResponse = $null
Set-Item Function:Invoke-SupabaseRest -Value {
  param($Method, $Path, $Body = $null)
  if ($Method -ne "GET" -or $Path -ne "rpc/get_outlook_exchange_truth_checkpoint") {
    throw "Unexpected truth-checkpoint request $Method $Path"
  }
  return $script:truthCheckpointResponse
}
try {
  $script:truthCheckpointResponse = [pscustomobject]@{
    checkpointValid = $false
    headSequence = 124
    headSha256 = ("c" * 64)
  }
  $nativeFalseCheckpointRejected = $false
  try {
    Add-ExchangeTruthLedgerEvidence @{} $false | Out-Null
  } catch {
    $nativeFalseCheckpointRejected = $_.Exception.Message -match "failed its hash, link, timestamp, or referenced-snapshot verification"
  }
  Assert-True $nativeFalseCheckpointRejected "A native boolean false checkpoint result must be rejected instead of becoming truthy through coercion"

  $script:truthCheckpointResponse = [pscustomobject]@{
    checkpointValid = $true
    headSequence = 125
    headSha256 = ("c" * 64)
    ledgerEntries = 125
    snapshots = 8
    latestCertificationRunId = $script:CurrentQueueRunId
    latestCertificationAt = "2026-07-22T07:21:00Z"
    latestSourceFingerprint = $atomicProjectionFingerprint
    latestCertificationHasProjectionEvidence = $true
    latestProjectionSnapshotSha256 = $atomicProjectionFingerprint
  }
  $missingQueueCheckpointRejected = $false
  try {
    Add-ExchangeTruthLedgerEvidence @{} $true $atomicProjectionFingerprint | Out-Null
  } catch {
    $missingQueueCheckpointRejected = $_.Exception.Message -match "missing the 'pending' queue count"
  }
  Assert-True $missingQueueCheckpointRejected "A current full certification must reject a checkpoint that omits its authoritative queue counts"
  $script:truthCheckpointResponse | Add-Member -NotePropertyName queue -NotePropertyValue ([pscustomobject]@{
    pending = 0
    processing = 0
    failed = 0
    terminalFailed = 0
  })
  $script:truthCheckpointResponse.queue.pending = "0"
  $stringQueueCountRejected = $false
  try {
    Add-ExchangeTruthLedgerEvidence @{} $false | Out-Null
  } catch {
    $stringQueueCountRejected = $_.Exception.Message -match "non-native or invalid 'pending' queue count"
  }
  Assert-True $stringQueueCountRejected "A string queue count must not be coerced into a trusted truth-checkpoint number"
  $script:truthCheckpointResponse.queue.pending = 0
  $script:truthCheckpointResponse.queue.terminalFailed = 1
  $inconsistentQueueCountsRejected = $false
  try {
    Add-ExchangeTruthLedgerEvidence @{} $false | Out-Null
  } catch {
    $inconsistentQueueCountsRejected = $_.Exception.Message -match "more terminal failed queue rows"
  }
  Assert-True $inconsistentQueueCountsRejected "A truth checkpoint must reject internally inconsistent failed and terminal-failed queue counts"
  $script:truthCheckpointResponse.queue.terminalFailed = 0
  $truthCheckpointStats = @{
    truthEvidenceLedgerSequence = 123
    truthEvidenceLedgerHash = ("a" * 64)
    sourceSnapshotHash = $atomicProjectionFingerprint
  }
  Add-ExchangeTruthLedgerEvidence $truthCheckpointStats $true $atomicProjectionFingerprint | Out-Null
  Assert-True ([bool]$truthCheckpointStats.truthLedgerCheckpointVerified) "A hash-valid checkpoint must be marked verified"
  Assert-True ([bool]$truthCheckpointStats.currentProjectionCertified) "A full-run checkpoint must certify the current projection only when the run ID, evidence flag, and snapshot hash all match"
  Assert-Equal 125 $truthCheckpointStats.truthLedgerHeadSequence "Checkpoint evidence must retain the latest ledger head sequence"
  Assert-Equal ("c" * 64) $truthCheckpointStats.truthLedgerHeadHash "Checkpoint evidence must retain the latest ledger head hash"
  Assert-Equal 123 $truthCheckpointStats.truthEvidenceLedgerSequence "Refreshing the ledger checkpoint must not overwrite the full-certification receipt sequence"
  Assert-Equal ("a" * 64) $truthCheckpointStats.truthEvidenceLedgerHash "Refreshing the ledger checkpoint must not overwrite the full-certification receipt hash"
  Assert-Equal $atomicProjectionFingerprint $truthCheckpointStats.latestProjectionSnapshotHash "The checkpoint must expose the exact canonical projection linked to the current full certification"
  Assert-Equal 0 $truthCheckpointStats.truthCheckpointPendingQueueRows "The verified checkpoint must copy its native pending count into final outcome evidence"
  Assert-Equal 0 $truthCheckpointStats.truthCheckpointProcessingQueueRows "The verified checkpoint must copy its native processing count into final outcome evidence"
  Assert-Equal 0 $truthCheckpointStats.truthCheckpointFailedQueueRows "The verified checkpoint must copy its native failed count into final outcome evidence"
  Assert-Equal 0 $truthCheckpointStats.truthCheckpointTerminalFailedQueueRows "The verified checkpoint must copy its native terminal-failed count into final outcome evidence"

  $script:truthCheckpointResponse.latestProjectionSnapshotSha256 = ("d" * 64)
  $wrongProjectionLinkRejected = $false
  try {
    Add-ExchangeTruthLedgerEvidence @{} $true $atomicProjectionFingerprint | Out-Null
  } catch {
    $wrongProjectionLinkRejected = $_.Exception.Message -match "not linked to the exact canonical projection"
  }
  Assert-True $wrongProjectionLinkRejected "A current full certification must be rejected when its ledger evidence points to a different projection snapshot"
} finally {
  Set-Item Function:Invoke-SupabaseRest -Value $truthCheckpointOriginalInvokeSupabaseRest
  $script:truthCheckpointResponse = $null
}

$checkpointClassificationStats = @{
  truthCheckpointPendingQueueRows = [long]2
  truthCheckpointProcessingQueueRows = [long]1
  truthCheckpointFailedQueueRows = [long]3
  truthCheckpointTerminalFailedQueueRows = [long]1
}
Set-IncrementalBacklogFromTruthCheckpoint $checkpointClassificationStats
Assert-Equal 6 $checkpointClassificationStats.backlogRows "Final incremental backlog must come from the atomic checkpoint, not an earlier non-atomic row query"
Assert-Equal 4 $checkpointClassificationStats.retryableBacklogRows "Pending plus non-terminal failed checkpoint rows must be classified as retryable"
Assert-Equal 1 $checkpointClassificationStats.terminalBacklogRows "The checkpoint terminal-failed count must remain explicit"
Assert-Equal 1 $checkpointClassificationStats.activeBacklogRows "The checkpoint processing count must remain explicit"

$finalizationOriginalAddTruthLedgerEvidence = (Get-Item Function:Add-ExchangeTruthLedgerEvidence).ScriptBlock
$finalizationOriginalSaveSyncStatus = (Get-Item Function:Save-SyncStatus).ScriptBlock
$finalizationOriginalGetBacklogRows = (Get-Item Function:Get-ExchangeQueueBacklogRows).ScriptBlock
$finalizationOriginalRunId = $script:CurrentQueueRunId
$script:CurrentQueueRunId = "77777777-7777-4777-8777-777777777777"
$script:finalizationCheckpoints = @()
$script:finalizationCheckpointCalls = 0
$script:finalizationStatusWrites = [System.Collections.ArrayList]::new()
$script:finalizationBacklogRows = @()
Set-Item Function:Add-ExchangeTruthLedgerEvidence -Value {
  param(
    [hashtable]$Stats,
    [bool]$RequireCurrentFullCertification = $false,
    $ExpectedProjectionHash = ""
  )
  if ($script:finalizationCheckpointCalls -ge @($script:finalizationCheckpoints).Count) {
    throw "Unexpected finalization checkpoint call."
  }
  $checkpoint = @($script:finalizationCheckpoints)[$script:finalizationCheckpointCalls]
  $script:finalizationCheckpointCalls += 1
  $Stats["truthLedgerCheckpointVerified"] = $true
  $Stats["truthLedgerHeadSequence"] = [long]$checkpoint.Sequence
  $Stats["truthLedgerHeadHash"] = $checkpoint.Hash
  $Stats["truthLedgerHeadPreviousHash"] = $checkpoint.PreviousHash
  $Stats["truthLedgerHeadEventType"] = $checkpoint.EventType
  $Stats["truthLedgerHeadRunId"] = $checkpoint.RunId
  $Stats["truthCheckpointPendingQueueRows"] = [long]$checkpoint.Pending
  $Stats["truthCheckpointProcessingQueueRows"] = [long]$checkpoint.Processing
  $Stats["truthCheckpointFailedQueueRows"] = [long]$checkpoint.Failed
  $Stats["truthCheckpointTerminalFailedQueueRows"] = [long]$checkpoint.TerminalFailed
  return $checkpoint
}
Set-Item Function:Save-SyncStatus -Value {
  param($Status, $Message, $Details = $null)
  [void]$script:finalizationStatusWrites.Add([pscustomobject]@{
    Status = $Status
    Message = $Message
  })
}
Set-Item Function:Get-ExchangeQueueBacklogRows -Value {
  return @($script:finalizationBacklogRows)
}
try {
  $script:finalizationCheckpoints = @(
    [pscustomobject]@{ Sequence = 300; Hash = ("1" * 64); PreviousHash = ("0" * 64); EventType = "queue_updated"; RunId = ""; Pending = 0; Processing = 0; Failed = 0; TerminalFailed = 0 },
    [pscustomobject]@{ Sequence = 305; Hash = ("2" * 64); PreviousHash = ("1" * 64); EventType = "run_status"; RunId = $script:CurrentQueueRunId; Pending = 0; Processing = 0; Failed = 0; TerminalFailed = 0 }
  )
  $script:finalizationCheckpointCalls = 0
  $script:finalizationStatusWrites.Clear()
  $stableFinalizationStats = @{
    syncMode = "incremental"
    queuedRows = 0
    completedQueueRows = 0
    failedQueueRows = 0
    skippedQueueRows = 0
    supersededQueueRows = 0
    resolvedTerminalQueueRows = 0
    changeDetails = @()
  }
  $stableFinalizationOutcome = Complete-IncrementalSyncOutcomeWithCheckpoint $stableFinalizationStats
  Assert-Equal "completed" $stableFinalizationOutcome.Status "A zero-backlog incremental run may complete only after a stable checkpoint pair"
  Assert-True ($stableFinalizationOutcome.Message -match "checkpoint sequence 305") "A successful incremental result must state the exact queue checkpoint through which it is valid"
  Assert-Equal 1 $script:finalizationStatusWrites.Count "A stable checkpoint pair must require only one intermediate status ledger write"
  Assert-True ([long]$stableFinalizationStats.truthLedgerHeadSequence -gt 301) "A direct cryptographic ledger link must remain valid even when an aborted transaction left harmless sequence gaps"

  $script:finalizationCheckpoints = @(
    [pscustomobject]@{ Sequence = 400; Hash = ("3" * 64); PreviousHash = ("2" * 64); EventType = "queue_updated"; RunId = ""; Pending = 0; Processing = 0; Failed = 0; TerminalFailed = 0 },
    [pscustomobject]@{ Sequence = 405; Hash = ("5" * 64); PreviousHash = ("4" * 64); EventType = "run_status"; RunId = $script:CurrentQueueRunId; Pending = 1; Processing = 0; Failed = 0; TerminalFailed = 0 },
    [pscustomobject]@{ Sequence = 405; Hash = ("5" * 64); PreviousHash = ("4" * 64); EventType = "run_status"; RunId = $script:CurrentQueueRunId; Pending = 1; Processing = 0; Failed = 0; TerminalFailed = 0 },
    [pscustomobject]@{ Sequence = 410; Hash = ("6" * 64); PreviousHash = ("5" * 64); EventType = "run_status"; RunId = $script:CurrentQueueRunId; Pending = 1; Processing = 0; Failed = 0; TerminalFailed = 0 }
  )
  $script:finalizationBacklogRows = @([pscustomobject]@{
    id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    status = "pending"
    attempts = 0
    action = "update_contact"
    entity_type = "contact"
    entity_id = "intervening-contact"
    entity_email = "intervening@example.com"
    display_name = "Intervening contact"
    created_at = "2026-07-22T08:00:00Z"
  })
  $script:finalizationCheckpointCalls = 0
  $script:finalizationStatusWrites.Clear()
  $racingFinalizationStats = @{
    syncMode = "incremental"
    queuedRows = 0
    completedQueueRows = 0
    failedQueueRows = 0
    skippedQueueRows = 0
    supersededQueueRows = 0
    resolvedTerminalQueueRows = 0
    changeDetails = @()
  }
  $racingFinalizationOutcome = Complete-IncrementalSyncOutcomeWithCheckpoint $racingFinalizationStats
  Assert-Equal "failed" $racingFinalizationOutcome.Status "A queue row inserted between outcome and checkpoint must prevent a false green no-op"
  Assert-Equal 1 $racingFinalizationStats.backlogRows "The retried final outcome must retain the authoritative intervening pending row"
  Assert-True ($racingFinalizationOutcome.Message -match "1 unresolved queue change") "The retried outcome must explain the exact remaining backlog"
  Assert-Equal 2 $script:finalizationStatusWrites.Count "An intervening truth event must force a new checkpointed status attempt"
  Assert-Equal 410 $racingFinalizationStats.truthLedgerHeadSequence "The final details must expose the stable post-status checkpoint, not the stale pre-race checkpoint"
} finally {
  Set-Item Function:Add-ExchangeTruthLedgerEvidence -Value $finalizationOriginalAddTruthLedgerEvidence
  Set-Item Function:Save-SyncStatus -Value $finalizationOriginalSaveSyncStatus
  Set-Item Function:Get-ExchangeQueueBacklogRows -Value $finalizationOriginalGetBacklogRows
  $script:CurrentQueueRunId = $finalizationOriginalRunId
  $script:finalizationCheckpoints = @()
  $script:finalizationBacklogRows = @()
}

$lockContractOriginalInvokeSupabaseRest = (Get-Item Function:Invoke-SupabaseRest).ScriptBlock
$script:lockContractResponse = $false
Set-Item Function:Invoke-SupabaseRest -Value {
  param($Method, $Path, $Body = $null)
  return $script:lockContractResponse
}
try {
  Assert-Equal 30 (Get-ExchangeSyncLockLeaseMinutes "incremental") "Incremental syncs must retain the bounded 30-minute mutation lease"
  Assert-Equal 180 (Get-ExchangeSyncLockLeaseMinutes "full") "Full reconciliation must retain its mutation lease across slow Exchange Online commands"
  Assert-True (-not (Acquire-ExchangeSyncLock "incremental")) "A native false lock-acquisition result must remain false"
  $script:lockContractResponse = "false"
  $stringAcquireRejected = $false
  try {
    Acquire-ExchangeSyncLock "incremental" | Out-Null
  } catch {
    $stringAcquireRejected = $_.Exception.Message -match "native boolean"
  }
  Assert-True $stringAcquireRejected "A string 'false' lock-acquisition result must be rejected instead of coercing to true"

  $stringRenewRejected = $false
  try {
    Renew-ExchangeSyncLock
  } catch {
    $stringRenewRejected = $_.Exception.Message -match "native boolean"
  }
  Assert-True $stringRenewRejected "A string 'false' lock-renewal result must be rejected instead of preserving an unconfirmed lease"
} finally {
  Set-Item Function:Invoke-SupabaseRest -Value $lockContractOriginalInvokeSupabaseRest
  $script:lockContractResponse = $null
  $script:SyncLockLastRenewedAt = [DateTimeOffset]::MinValue
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
    $page = @(1..1000 | ForEach-Object { [pscustomobject]@{ id = "row-$_" } })
    Write-Output -NoEnumerate $page
    return
  }
  $page = @([pscustomobject]@{ id = "row-1001" }, [pscustomobject]@{ id = "row-1002" })
  Write-Output -NoEnumerate $page
}
try {
  $nonEnumeratedBacklogRows = @(Get-ExchangeQueueBacklogRows)
  Assert-Equal 1002 $nonEnumeratedBacklogRows.Count "Queue backlog visibility must flatten a top-level JSON array and paginate beyond the first 1,000 unresolved rows"
  Assert-Equal "row-1" $nonEnumeratedBacklogRows[0].id "A non-enumerated REST array must produce individual queue rows, not one nested System.Object[]"
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
    truthLedgerCheckpointVerified = $true
    truthLedgerHeadSequence = 201
    truthLedgerHeadHash = ("e" * 64)
    currentProjectionCertified = $false
    changeDetails = @($terminalBacklogDetail, $pendingBacklogDetail)
  }
  $backlogNotificationDelivery = Send-ExchangeSyncNotification "failed" "Two unresolved rows remain." $emailBacklogDetails ([pscustomobject]@{
    requestedBy = "SC"
    requestedByEmail = "sc@example.com"
    requestedAt = "2026-07-22T07:00:00Z"
  })
  Assert-Equal "delivered" $backlogNotificationDelivery.Status "A successful SMTP call must return an explicit delivered receipt"
  Assert-True ([bool]$backlogNotificationDelivery.Attempted) "A successful SMTP receipt must state that delivery was attempted"
  Assert-True ([bool]$backlogNotificationDelivery.Delivered) "A successful SMTP receipt must state that delivery completed"
  Assert-Equal 1 $backlogNotificationDelivery.RecipientCount "A successful SMTP receipt must retain the exact recipient count"
  Assert-True ([bool](Clean-Text $backlogNotificationDelivery.DeliveredAt)) "A successful SMTP receipt must retain its UTC delivery timestamp"
  Assert-True ($script:capturedBacklogHtml -match "Queue change and backlog results") "A backlog notice must use a backlog-specific result title"
  Assert-True ($script:capturedBacklogHtml -match "Terminal stale group") "A backlog notice must name the terminal item"
  Assert-True ($script:capturedBacklogHtml -match $terminalBacklogId) "A backlog notice must show the exact queue row ID"
  Assert-True ($script:capturedBacklogHtml -match "retry limit exhausted") "A backlog notice must explain terminal retry exhaustion"
  Assert-True ($script:capturedBacklogHtml -match "Not attempted") "A pending zero-attempt row must be labelled as not attempted"
  Assert-True ($script:capturedBacklogHtml -notmatch "No pending changes") "A backlog notice must never claim there are no pending changes"
  Assert-True ($script:capturedBacklogHtml -notmatch "Next retry") "Terminal and pending rows without next_attempt_at must not fabricate next-retry metadata"
  Assert-True ($script:capturedBacklogHtml -match "Immutable audit checkpoint recorded") "A failed incremental notice may anchor its audit receipt without claiming that Exchange is fully certified"
  Assert-True ($script:capturedBacklogHtml -match "does not mean every queued change succeeded") "A generic failed incremental checkpoint must explicitly separate ledger integrity from sync success"
  Assert-True ($script:capturedBacklogHtml -notmatch "Current source-of-truth projection certified") "A failed incremental notice must never use full-certification wording"

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
    fullCertificationCommitted = $true
    fullCertificationIdempotent = $false
    fullCertificationAt = "2026-07-22T07:21:00Z"
    templateRecipientTruthReconciled = $true
    templateRecipientTruthIdempotent = $false
    templateRecipientTruthUpdatedTemplates = 556
    templateRecipientTruthTotalTemplates = 556
    templateRecipientTruthSendableTemplates = 504
    templateRecipientTruthMissingTemplates = 51
    templateRecipientTruthAmbiguousTemplates = 1
    truthEvidenceRecorded = $true
    truthEvidenceLedgerSequence = 200
    truthEvidenceLedgerHash = ("f" * 64)
    sourceSnapshotHash = $atomicProjectionFingerprint
    rawSourceSnapshotHash = ("b" * 64)
    truthWorkerVersion = $ExchangeTruthWorkerVersion
    truthLedgerCheckpointVerified = $true
    truthLedgerHeadSequence = 202
    truthLedgerHeadHash = ("c" * 64)
    truthLedgerEntries = 202
    truthSnapshots = 8
    currentProjectionCertified = $true
    latestCertificationRunId = $script:CurrentQueueRunId
    latestCertificationAt = "2026-07-22T07:21:00Z"
    latestSourceFingerprint = $atomicProjectionFingerprint
    latestCertificationHasProjectionEvidence = $true
    latestProjectionSnapshotHash = $atomicProjectionFingerprint
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
  $fullNotificationDelivery = Send-ExchangeSyncNotification "completed" "Full Exchange reconciliation completed." $fullNoticeStats ([pscustomobject]@{
    requestedBy = "SC"
    requestedByEmail = "sc@example.com"
    requestedAt = "2026-07-22T07:10:00Z"
  })
  Assert-Equal "delivered" $fullNotificationDelivery.Status "A successful full-sync notice must return an explicit delivered receipt"
  Assert-True ($script:capturedBacklogHtml -match "Full reconciliation results") "A full-run notice must use a full-reconciliation result title"
  Assert-True ($script:capturedBacklogHtml -match "Create contact") "A full-run notice must show each mutation action"
  Assert-True ($script:capturedBacklogHtml -match "Email: \(missing\) -&gt; full-notice@example.com") "A full-run notice must show exact before/after fields"
  Assert-True ($script:capturedBacklogHtml -match "FCUNO_CONTACT:c-full-notice") "A full-run notice must show the stable FCUNO identity"
  Assert-True ($script:capturedBacklogHtml -match "dddddddd-dddd-4ddd-8ddd-dddddddddddd") "A full-run notice must show the verified Exchange identity"
  Assert-True ($script:capturedBacklogHtml -notmatch "No Exchange mutations required") "A mutated full run must never use the zero-mutation fallback"
  Assert-True ($script:capturedBacklogHtml -match "Current source-of-truth projection certified") "A fully certified run notice must clearly state that the current FCUNO-to-Exchange projection was certified"
  Assert-True ($script:capturedBacklogHtml -match "FCUNO is authoritative") "A fully certified run notice must identify FCUNO as the authority"
  Assert-True ($script:capturedBacklogHtml -notmatch "does not mean every queued change succeeded") "A fully certified run must not use the generic checkpoint-only qualification"
  Assert-True ($script:capturedBacklogHtml -match "Projection evidence ledger sequence") "The notice summary must label the full-certification receipt sequence separately"
  Assert-True ($script:capturedBacklogHtml -match "Ledger checkpoint sequence") "The notice summary must label the later ledger-head checkpoint separately"
  Assert-True ($script:capturedBacklogHtml -match "Outlook template recipient truth reconciled") "The full notice must confirm that Outlook-template recipient evidence followed the certified projection"
  Assert-True ($script:capturedBacklogHtml -match "Outlook templates currently sendable") "The full notice must report how many Outlook templates are currently safe to insert"
  Assert-True ($script:capturedBacklogHtml -match "Outlook templates blocked by missing recipients") "The full notice must expose missing-recipient send blocks"
  Assert-True ($script:capturedBacklogHtml -match "Outlook templates blocked by ambiguous recipients") "The full notice must expose ambiguous-recipient send blocks"
  Assert-True ($script:capturedBacklogHtml -match ("f" * 64)) "The notice summary must retain the projection-evidence receipt hash"
  Assert-True ($script:capturedBacklogHtml -match ("c" * 64)) "The notice summary must retain the latest checkpoint head hash"
  Assert-True ($script:capturedBacklogHtml -match $atomicProjectionFingerprint) "The fully certified notice must display the exact canonical FCUNO-to-Exchange projection hash"

  Set-Item Function:Send-ExchangeSmtpMail -Value {
    param($From, $To, $Subject, $Html)
    throw "Simulated SMTP transport failure."
  }
  $failedNotificationDelivery = Send-ExchangeSyncNotification "failed" "SMTP test." $emailBacklogDetails ([pscustomobject]@{
    requestedBy = "SC"
    requestedByEmail = "sc@example.com"
    requestedAt = "2026-07-22T07:00:00Z"
  })
  Assert-Equal "failed" $failedNotificationDelivery.Status "An SMTP exception must return an explicit failed delivery receipt"
  Assert-True ([bool]$failedNotificationDelivery.Attempted) "An SMTP transport exception occurs after a delivery attempt begins"
  Assert-True (-not [bool]$failedNotificationDelivery.Delivered) "An SMTP transport exception must never be recorded as delivered"
  Assert-True ($failedNotificationDelivery.Error -match "Simulated SMTP transport failure") "The failed delivery receipt must retain the exact SMTP error"
} finally {
  Set-Item Function:Get-OptionalAutomationSetting -Value $originalGetOptionalAutomationSetting
  Set-Item Function:Send-ExchangeSmtpMail -Value $originalSendExchangeSmtpMail
}

$notificationOutcomeStats = @{}
$notRequiredNotificationDelivery = New-ExchangeNotificationDeliveryResult `
  "not_required" `
  $false `
  $false `
  0 `
  "" `
  ""
Set-ExchangeNotificationDeliveryStats $notificationOutcomeStats $notRequiredNotificationDelivery
Assert-Equal "not_required" $notificationOutcomeStats.notificationDeliveryStatus "A deliberately silent scheduled no-op must persist an explicit not-required notice outcome"
Assert-True (-not [bool]$notificationOutcomeStats.notificationDeliveryAttempted) "A not-required notice outcome must not claim an SMTP attempt"
Assert-True (-not [bool]$notificationOutcomeStats.notificationDelivered) "A not-required notice outcome must not claim delivery"
Assert-Equal 0 $notificationOutcomeStats.notificationRecipientCount "A not-required notice outcome must persist a zero recipient count"

$notificationWrapperOriginalSend = (Get-Item Function:Send-ExchangeSyncNotification).ScriptBlock
Set-Item Function:Send-ExchangeSyncNotification -Value {
  param($Status, $Message, $Details, $WebhookPayload)
  throw "Simulated notification configuration lookup failure."
}
try {
  $preSendFailureDelivery = Invoke-ExchangeSyncNotificationSafely "completed" "Verified." @{} ([pscustomobject]@{})
  Assert-Equal "failed" $preSendFailureDelivery.Status "A pre-SMTP notification exception must still return a durable failed delivery receipt"
  Assert-True (-not [bool]$preSendFailureDelivery.Attempted) "A notification preparation failure must not claim an SMTP delivery attempt"
  Assert-True ($preSendFailureDelivery.Error -match "configuration lookup failure") "A notification preparation failure must retain its exact error"
} finally {
  Set-Item Function:Send-ExchangeSyncNotification -Value $notificationWrapperOriginalSend
}

$notificationSaveOriginalSaveSyncStatus = (Get-Item Function:Save-SyncStatus).ScriptBlock
$script:notificationReceiptSaveAttempts = 0
$script:notificationReceiptSavedStatuses = [System.Collections.ArrayList]::new()
Set-Item Function:Save-SyncStatus -Value {
  param($Status, $Message, $Details = $null)
  $script:notificationReceiptSaveAttempts += 1
  [void]$script:notificationReceiptSavedStatuses.Add($Status)
  throw "Simulated final notification-receipt persistence failure."
}
Set-Item Function:Start-Sleep -Value { param($Seconds) }
try {
  $notificationReceiptPersisted = Save-SyncStatusAfterNotification "completed" "Exchange reconciliation remains verified." $notificationOutcomeStats
  Assert-True (-not [bool]$notificationReceiptPersisted) "A failed notification-receipt status write must be reported separately from the Exchange reconciliation outcome"
  Assert-Equal 3 $script:notificationReceiptSaveAttempts "Notification-receipt status persistence must use exactly three bounded attempts"
  Assert-True (@($script:notificationReceiptSavedStatuses | Where-Object { $_ -ne "completed" }).Count -eq 0) "Notification-receipt persistence retries must never convert a correct Exchange outcome into failed"
} finally {
  Set-Item Function:Save-SyncStatus -Value $notificationSaveOriginalSaveSyncStatus
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
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
Assert-True (-not (Test-IncrementalSyncNotificationRequired $emptyOutcome)) "An hourly webhook invocation must not override a zero-change outcome and force an email"

$changedOutcome = Get-IncrementalSyncOutcome @{
  queuedRows = 1
  completedQueueRows = 1
  failedQueueRows = 0
  backlogRows = 0
  skippedQueueRows = 0
  supersededQueueRows = 0
  resolvedTerminalQueueRows = 0
}
Assert-Equal "completed" $changedOutcome.Status "A verified user change must complete successfully"
Assert-True (Test-IncrementalSyncNotificationRequired $changedOutcome) "A verified user change must send an informative email report"
Assert-True (Test-IncrementalSyncNotificationRequired $backlogOutcome) "An unresolved failure must continue to send an alert"

$silentFullOutcome = @{
  failedQueueRows = 0
  skippedQueueRows = 3
  createdContacts = 0
  updatedContacts = 0
  removedContacts = 0
  createdGroups = 0
  updatedGroups = 0
  removedGroups = 0
  addedMembers = 0
  removedMembers = 0
}
Assert-True (-not (Test-FullSyncNotificationRequired "completed" $silentFullOutcome)) "A verified daily full reconciliation with no Exchange mutations must remain silent"
$mutatedFullOutcome = @{}
foreach ($key in @(
  "createdContacts",
  "updatedContacts",
  "removedContacts",
  "createdGroups",
  "updatedGroups",
  "removedGroups",
  "addedMembers",
  "removedMembers"
)) {
  $mutatedFullOutcome[$key] = 1
  Assert-True (Test-FullSyncNotificationRequired "completed" $mutatedFullOutcome) "A successful full reconciliation must notify when $key records an Exchange mutation"
  $mutatedFullOutcome[$key] = 0
}
Assert-True (Test-FullSyncNotificationRequired "failed" $silentFullOutcome) "A failed full reconciliation must always notify"
$failedFullOutcome = $silentFullOutcome.Clone()
$failedFullOutcome.failedQueueRows = 1
Assert-True (Test-FullSyncNotificationRequired "completed" $failedFullOutcome) "A full reconciliation with a recorded row failure must always notify"

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
$script:allowedDuplicateOwnerPresent = $true
$allowedDuplicateOwner = [pscustomobject]@{
  Identity = "allowed-duplicate-owner"
  Guid = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
  DistinguishedName = "CN=Allowed Duplicate Owner,OU=Contacts,DC=example,DC=com"
  DisplayName = "Allowed Duplicate Owner"
  ExternalEmailAddress = "allowed-duplicate@example.com"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_CONTACT:c-older-duplicate"
}
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
  if ($Identity -eq $allowedDuplicateOwner.Guid -or $Identity -eq $allowedDuplicateOwner.DistinguishedName) {
    if ($script:allowedDuplicateOwnerPresent) { return $allowedDuplicateOwner }
    return $null
  }
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_CONTACT:c-current-duplicate'") { return @() }
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_CONTACT:c-older-duplicate'") {
    if ($script:allowedDuplicateOwnerPresent) { return $allowedDuplicateOwner }
    return @()
  }
  if ($Filter -like "ExternalEmailAddress -eq 'allowed-duplicate@example.com'") {
    if ($script:allowedDuplicateOwnerPresent) { return $allowedDuplicateOwner }
    return @()
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
  if ((Clean-Text $Identity) -eq (Clean-Text $allowedDuplicateOwner.Guid)) {
    $script:allowedDuplicateOwnerPresent = $false
  }
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
Remove-ManagedExchangeMailContact `
  "allowed-duplicate@example.com" `
  "allowed-duplicate-owner" `
  $guardStats `
  "c-current-duplicate" `
  "Current Duplicate" `
  $false `
  @("FCUNO_CONTACT:c-current-duplicate", "FCUNO_CONTACT:c-older-duplicate")
Assert-True $script:removeCalled "Internal suppression must remove a stale managed contact owned by another legitimate duplicate source row"
Assert-True (-not $script:allowedDuplicateOwnerPresent) "Duplicate-owner cleanup must verify deletion of the exact immutable Exchange object"

$script:removeCalled = $false
$foreignAllowedOwnerFailedClosed = $false
try {
  Remove-ManagedExchangeMailContact `
    "dup@example.com" `
    "dup" `
    $guardStats `
    "c-old" `
    "Older" `
    $false `
    @("FCUNO_CONTACT:c-old", "FCUNO_CONTACT:c-other-legitimate-duplicate")
} catch {
  $foreignAllowedOwnerFailedClosed = $_.Exception.Message -match "outside the exact FCUNO duplicate owner set"
}
Assert-True $foreignAllowedOwnerFailedClosed "Projection-bounded duplicate cleanup must still reject an unrelated Exchange owner"
Assert-True (-not $script:removeCalled) "A foreign owner must never reach Remove-MailContact through the duplicate-owner exception"

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
$savedSyncDirectoryPeersForGroupQueue = (Get-Item Function:Sync-ExchangeDirectoryNamePeers).ScriptBlock
$script:syncedGroupIds = @()
$script:groupQueueDirectoryEvents = @()
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
  $script:groupQueueDirectoryEvents += "group-state:$(Clean-Text $GroupId)"
}
function Sync-ExchangeDirectoryNamePeers {
  param($DisplayName, [hashtable]$Stats, $ExcludeSourceKey = "", [bool]$IncludeSinglePeer = $false)
  $script:groupQueueDirectoryEvents += "directory-peers:$(Clean-Text $DisplayName)"
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
Assert-Equal "group-state:g-new,directory-peers:Reused Group" ($script:groupQueueDirectoryEvents -join ",") "A deleted group must vacate its old Exchange Name before repairing directory-name peers"

$script:recreatedGroupRemoved = $false
$script:aliasAlreadyCurrent = $true
$script:syncedGroupIds = @()
$script:groupQueueDirectoryEvents = @()
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
Set-Item Function:Sync-ExchangeDirectoryNamePeers -Value $savedSyncDirectoryPeersForGroupQueue

$desiredNoOpContact = [pscustomobject]@{
  DirectoryName = "Unchanged Contact"
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
  Guid = "11111111-1111-1111-1111-111111111111"
  ExternalDirectoryObjectId = "profile-external-unchanged"
  DistinguishedName = "CN=Profile Unchanged Contact,OU=Contacts,DC=example,DC=com"
  Alias = "unchanged-contact"
  FirstName = "Unchanged"
  LastName = "Contact"
}
$script:getMailContactCalls = 0
$script:setMailContactCalls = 0
$script:setContactCalls = 0
$script:lastSetContactIdentity = ""
$script:lastGetContactFilter = ""
$script:lastGetContactIdentity = ""
$script:getContactIdentityCalls = 0
$script:forceGraphContactFilterFallback = $false
$script:graphFallbackIdentityNotFoundRemaining = 0
$script:setContactError = ""
$script:setContactFailed = $false
$script:rereadReplacementContact = $null
$script:liveMailContactSnapshot = @($script:noOpMailContact)
$script:forceGraphMailContactFilterFallback = $false
$script:forceGraphMailContactSnapshotFailure = $false
$script:unfilteredMailContactCalls = 0
function Get-MailContact {
  [CmdletBinding()]
  param($Filter, $ResultSize, $Identity)
  $script:getMailContactCalls += 1
  if ($Filter -and $script:forceGraphMailContactFilterFallback) {
    throw "Required field ExternalDirectoryObjectId was not returned from Graph API."
  }
  if ($Identity -in @($script:noOpMailContact.Guid, $script:noOpMailContact.DistinguishedName, $script:noOpMailContact.ExternalDirectoryObjectId)) {
    if ($script:setContactFailed -and $script:rereadReplacementContact) { return $script:rereadReplacementContact }
    return $script:noOpMailContact
  }
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_CONTACT:c-unchanged'") {
    if ($script:setContactFailed -and $script:rereadReplacementContact) { return $script:rereadReplacementContact }
    return $script:noOpMailContact
  }
  if ($Filter -like "ExternalEmailAddress -eq 'unchanged@example.com'") {
    return $script:noOpMailContact
  }
  if (-not $Filter -and -not $Identity) {
    $script:unfilteredMailContactCalls += 1
    if ($script:forceGraphMailContactSnapshotFailure) {
      throw "Required field ExternalDirectoryObjectId was not returned from Graph API."
    }
    if ($script:setContactFailed -and $script:rereadReplacementContact) { return @($script:rereadReplacementContact) }
    return @($script:liveMailContactSnapshot)
  }
  return $null
}
function Get-Contact {
  [CmdletBinding()]
  param($Identity, $Filter, $RecipientTypeDetails, $ResultSize)
  if ($Filter) { $script:lastGetContactFilter = Clean-Text $Filter }
  if ($Filter -like "Guid -eq '11111111-1111-1111-1111-111111111111'") {
    if ($script:forceGraphContactFilterFallback) { throw "Required field ExternalDirectoryObjectId was not returned from Graph API." }
    return $script:noOpContactProfile
  }
  if ($Identity -in @("11111111-1111-1111-1111-111111111111", "CN=Profile Unchanged Contact,OU=Contacts,DC=example,DC=com")) {
    $script:lastGetContactIdentity = Clean-Text $Identity
    $script:getContactIdentityCalls += 1
    if ($script:graphFallbackIdentityNotFoundRemaining -gt 0) {
      $script:graphFallbackIdentityNotFoundRemaining -= 1
      throw "The operation couldn't be performed because object '$Identity' couldn't be found."
    }
    return $script:noOpContactProfile
  }
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
  $script:lastSetContactIdentity = Clean-Text $Identity
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

$immutableProfile = [pscustomobject]@{ Identity = "11111111-1111-1111-1111-111111111111"; Guid = "33333333-3333-4333-8333-333333333333"; FirstName = "Unchanged"; LastName = "Contact" }
$mutableAndImmutableProfileLookup = New-ExchangeContactProfileLookup @(
  [pscustomobject]@{ Identity = "unchanged-contact"; Guid = "44444444-4444-4444-8444-444444444444"; FirstName = "Wrong"; LastName = "Mutable" },
  $immutableProfile
)
Assert-True ([object]::ReferenceEquals($immutableProfile, (Resolve-ExchangeContactProfileHint $script:noOpMailContact $mutableAndImmutableProfileLookup))) "A plain mutable contact Identity must never compete with an immutable profile join"

$ambiguousProfileLookup = New-ExchangeContactProfileLookup @(
  [pscustomobject]@{ Identity = "CN=Unchanged Contact,OU=Contacts,DC=example,DC=com"; Guid = "55555555-5555-4555-8555-555555555555"; FirstName = "Unchanged"; LastName = "Contact" },
  [pscustomobject]@{ Identity = "CN=Other Profile,OU=Contacts,DC=example,DC=com"; Guid = "11111111-1111-1111-1111-111111111111"; FirstName = "Unchanged"; LastName = "Contact" }
)
$ambiguousProfileFailedClosed = $false
try {
  Resolve-ExchangeContactProfileHint $script:noOpMailContact $ambiguousProfileLookup | Out-Null
} catch {
  $ambiguousProfileFailedClosed = $_.Exception.Message -match "More than one Exchange contact profile"
}
Assert-True $ambiguousProfileFailedClosed "Multiple immutable bulk contact-profile joins must fail closed"

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
  CustomAttribute1 = ""
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

$orphanedManagedEmailOwner = [pscustomobject]@{
  Identity = "orphaned-managed-owner"
  ExternalEmailAddress = "unchanged@example.com"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_CONTACT:c-deleted"
}
$resolvedOrphanedManagedOwner = Resolve-ExchangeMailContactHint $desiredNoOpContact (New-ExchangeMailContactLookup @($orphanedManagedEmailOwner))
Assert-Equal "orphaned-managed-owner" $resolvedOrphanedManagedOwner.Identity "A canonical FCUNO contact may adopt the exact-email projection left by a deleted FCUNO source card"
Assert-True (Test-ExchangeManagedContactOwnershipTransferRequired $orphanedManagedEmailOwner $desiredNoOpContact) "A managed exact-email contact with an obsolete FCUNO source owner must be recreated before profile mutation"
$orphanedManagedEmailOwner.CustomAttribute1 = ""
Assert-True (-not (Test-ExchangeManagedContactOwnershipTransferRequired $orphanedManagedEmailOwner $desiredNoOpContact)) "An unmanaged exact-email contact must never enter the ownership-transfer recreation path"
$orphanedManagedEmailOwner.CustomAttribute1 = $ManagedMarker
$orphanedManagedEmailOwner.CustomAttribute2 = $desiredNoOpContact.SourceKey
Assert-True (-not (Test-ExchangeManagedContactOwnershipTransferRequired $orphanedManagedEmailOwner $desiredNoOpContact)) "A managed contact already owned by the canonical FCUNO source must not be recreated"
Assert-True (Test-ExchangeRecreateEligibleError "Required field ExternalDirectoryObjectId was not returned from Graph API.") "An Exchange managed contact whose Graph profile is invalid must be eligible for exact verified recreation"

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
$staleSplitNoOpHint = Get-ExchangeMailContactExactNoOpHint `
  $desiredNoOpContact `
  (New-ExchangeMailContactLookup @($desiredSourceObject, $desiredEmailObject)) `
  (New-ExchangeContactProfileLookup @())
Assert-True ($null -eq $staleSplitNoOpHint) "A stale bulk source/email split must be discarded so the mutation path can resolve fresh live ownership"

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
Assert-Equal "11111111-1111-1111-1111-111111111111" $script:lastSetContactIdentity "Contact profile updates must target the exact resolved Get-Contact GUID"
Assert-Equal "Guid -eq '11111111-1111-1111-1111-111111111111'" $script:lastGetContactFilter "Get-Contact discovery must use the documented exact GUID filter, never the unsupported Alias filter"
Assert-Equal 1 $incrementalContactStats.updatedContacts "Incremental contact processing must still report its update"

$script:forceGraphContactFilterFallback = $true
$script:lastGetContactIdentity = ""
$graphFallbackProfile = Resolve-ExchangeContactProfileForMailContact $script:noOpMailContact "Graph-invalid filter contact" 1
Assert-True ([object]::ReferenceEquals($script:noOpContactProfile, $graphFallbackProfile)) "A Graph-invalid immutable filter must fall back to the same immutable direct identity"
Assert-Equal "11111111-1111-1111-1111-111111111111" $script:lastGetContactIdentity "The Graph fallback must use the mail contact's immutable GUID, never email or alias"
$script:getContactIdentityCalls = 0
$script:graphFallbackIdentityNotFoundRemaining = 1
$graphFallbackAfterPropagationMiss = Resolve-ExchangeContactProfileForMailContact $script:noOpMailContact "Graph-invalid propagating contact" 2
Assert-True ([object]::ReferenceEquals($script:noOpContactProfile, $graphFallbackAfterPropagationMiss)) "A direct immutable identity that is briefly not found must be retried before contact recreation is considered"
Assert-Equal 2 $script:getContactIdentityCalls "A propagation-time direct identity miss must consume the resolver retry instead of escaping after one attempt"
$script:graphFallbackIdentityNotFoundRemaining = 0
$script:forceGraphContactFilterFallback = $false

$script:forceGraphMailContactFilterFallback = $true
$script:unfilteredMailContactCalls = 0
$graphInvalidMailContactResolved = Resolve-ExchangeMailContactFromLiveRead $desiredNoOpContact
Assert-True ([object]::ReferenceEquals($script:noOpMailContact, $graphInvalidMailContactResolved)) "An exact Graph-invalid targeted mail-contact lookup must resolve ownership from a fresh unfiltered snapshot"
Assert-Equal 1 $script:unfilteredMailContactCalls "A Graph-invalid targeted lookup must take exactly one unfiltered fallback snapshot"
$script:forceGraphMailContactFilterFallback = $false

$strictImmutableReread = Get-ExchangeMailContactByImmutableIdentity $script:noOpMailContact "unchanged@example.com" "FCUNO_CONTACT:c-unchanged" "Strict immutable reread"
Assert-True ([object]::ReferenceEquals($script:noOpMailContact, $strictImmutableReread)) "A destructive immutable reread must return the sole current email/source-key owner"
$duplicateSourceOwner = [pscustomobject]@{
  Identity = "duplicate-source-owner"
  Guid = "22222222-2222-4222-8222-222222222222"
  DistinguishedName = "CN=Duplicate Source Owner,OU=Contacts,DC=example,DC=com"
  ExternalEmailAddress = "SMTP:duplicate-source@example.com"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_CONTACT:c-unchanged"
}
$script:liveMailContactSnapshot = @($script:noOpMailContact, $duplicateSourceOwner)
$duplicateSourceRereadFailedClosed = $false
try {
  Get-ExchangeMailContactByImmutableIdentity $script:noOpMailContact "unchanged@example.com" "FCUNO_CONTACT:c-unchanged" "Duplicate source-key reread" | Out-Null
} catch {
  $duplicateSourceRereadFailedClosed = $_.Exception.Message -match "no longer belongs uniquely"
}
Assert-True $duplicateSourceRereadFailedClosed "A destructive immutable reread must fail before deletion when another contact acquires the same source key"
$sameDnReplacement = [pscustomobject]@{
  Identity = "same-dn-replacement"
  Guid = "99999999-9999-4999-8999-999999999999"
  ExternalDirectoryObjectId = "replacement-external-contact"
  DistinguishedName = $script:noOpMailContact.DistinguishedName
  ExternalEmailAddress = $script:noOpMailContact.ExternalEmailAddress
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = $script:noOpMailContact.CustomAttribute2
}
$script:liveMailContactSnapshot = @($sameDnReplacement)
$sameDnReplacementFailedClosed = $false
try {
  Get-ExchangeMailContactByImmutableIdentity $script:noOpMailContact "unchanged@example.com" "FCUNO_CONTACT:c-unchanged" "Same-DN replacement reread" | Out-Null
} catch {
  $sameDnReplacementFailedClosed = $_.Exception.Message -match "resolved to 0 Exchange mail contacts"
}
Assert-True $sameDnReplacementFailedClosed "A destructive reread must reject a replacement with a new GUID even when its distinguished name is reused"
$script:liveMailContactSnapshot = @($script:noOpMailContact)

$preMutationEmailContact = [pscustomobject]@{}
foreach ($property in $script:noOpMailContact.PSObject.Properties) {
  $preMutationEmailContact | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
}
$preMutationEmailContact.ExternalEmailAddress = "SMTP:before-update@example.com"
$script:forceGraphMailContactSnapshotFailure = $true
$postMutationGraphFallback = Get-ExchangeMailContactByImmutableIdentity $preMutationEmailContact "after-update@example.com" "FCUNO_CONTACT:c-unchanged" "Post-mutation Graph fallback" $true
Assert-True ([object]::ReferenceEquals($preMutationEmailContact, $postMutationGraphFallback)) "The exact post-mutation Graph defect may retain the fresh immutable FCUNO source ownership proof when the email write may already have applied"
$preMutationEmailFallbackBlocked = $false
try {
  Get-ExchangeMailContactByImmutableIdentity $preMutationEmailContact "after-update@example.com" "FCUNO_CONTACT:c-unchanged" "Pre-mutation Graph fallback" | Out-Null
} catch {
  $preMutationEmailFallbackBlocked = $_.Exception.Message -match "could not use the pre-mutation immutable contact"
}
Assert-True $preMutationEmailFallbackBlocked "A Graph-invalid bulk reread before a confirmed mutation must still reject mismatched email evidence"
$script:forceGraphMailContactSnapshotFailure = $false

$staleProfileHint = [pscustomobject]@{
  Identity = "CN=Stale Snapshot Profile,OU=Contacts,DC=example,DC=com"
  Guid = "77777777-7777-4777-8777-777777777777"
  DistinguishedName = "CN=Stale Snapshot Profile Object,OU=Contacts,DC=example,DC=com"
  Alias = "unchanged-contact"
  FirstName = "Stale"
  LastName = "Snapshot"
}
$script:lastSetContactIdentity = ""
Upsert-ExchangeMailContact $desiredNoOpContact @{} $false $null $false $staleProfileHint
Assert-Equal "11111111-1111-1111-1111-111111111111" $script:lastSetContactIdentity "A stale bulk profile hint must be discarded and live-correlated before any profile mutation"
Assert-True ($script:lastSetContactIdentity -cne $staleProfileHint.Guid) "A live mail contact must never be paired with a stale snapshot profile from a different object"

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
  $replacementRaceFailedClosed = $_.Exception.Message -match "resolved to 0 Exchange mail contacts"
}
Assert-True $replacementRaceFailedClosed "An update/recreate race must fail closed when the immutable identity reread no longer resolves to the original contact"
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

$upsertContactFunctionText = (Get-Item Function:Upsert-ExchangeMailContact).ScriptBlock.ToString()
$managedTransferDecisionIndex = $upsertContactFunctionText.IndexOf('$managedOwnershipTransfer = Test-ExchangeManagedContactOwnershipTransferRequired')
$managedTransferDeleteIndex = $upsertContactFunctionText.IndexOf('Remove-MailContact -Identity $removeIdentity')
$liveProfileResolutionIndex = $upsertContactFunctionText.IndexOf('Resolve-ExchangeContactProfileForMailContact $existing')
$profileResolutionRecreationIndex = $upsertContactFunctionText.IndexOf('Managed contact recreation after profile-resolution failure')
$graphInvalidUpdateGateIndex = $upsertContactFunctionText.IndexOf('required field ExternalDirectoryObjectId was not returned from Graph API')
$updateErrorIndex = $upsertContactFunctionText.IndexOf('$updateError = Clean-Text $_.Exception.Message')
$updateRecreateDeleteIndex = $upsertContactFunctionText.IndexOf('Remove-MailContact -Identity $removeIdentity', $updateErrorIndex)
$updateRecreateConfirmationIndex = $upsertContactFunctionText.IndexOf('Confirm-ExchangeMailContactDeletion $reread $email $sourceKey', $updateRecreateDeleteIndex)
$updateRecreateNewIndex = $upsertContactFunctionText.IndexOf('$newContact = New-MailContact', $updateRecreateDeleteIndex)
Assert-True ($managedTransferDecisionIndex -ge 0) "Contact upsert must detect an exact managed source-owner transfer"
Assert-True ($managedTransferDecisionIndex -lt $managedTransferDeleteIndex) "Contact ownership transfer must be proven before deleting the old managed projection"
Assert-True ($managedTransferDeleteIndex -lt $liveProfileResolutionIndex) "A stale managed owner must be deleted and recreated before Graph contact-profile resolution"
Assert-True ($profileResolutionRecreationIndex -gt $liveProfileResolutionIndex) "A managed Graph-profile failure must enter the exact verified recreation path"
Assert-True ($graphInvalidUpdateGateIndex -gt $liveProfileResolutionIndex) "A managed Set-Contact Graph identity failure must pass the narrow invalid-object recreation gate"
Assert-True ($updateRecreateDeleteIndex -gt $updateErrorIndex) "A managed Set-Contact invalid-object failure must remove only the reread immutable contact"
Assert-True ($updateRecreateConfirmationIndex -gt $updateRecreateDeleteIndex) "A managed Set-Contact invalid-object recreation must confirm exact deletion after removal"
Assert-True ($updateRecreateNewIndex -gt $updateRecreateConfirmationIndex) "A managed Set-Contact invalid-object recreation must confirm absence before New-MailContact"

$fullSyncFunctionText = (Get-Item Function:Invoke-FullExchangeSync).ScriptBlock.ToString()
Assert-True ($fullSyncFunctionText -match 'Get-ExchangeMailContactExactNoOpHint \$contact') "Full reconciliation must treat its bulk contact lookup only as a non-authoritative exact-no-op optimization"
Assert-True ($fullSyncFunctionText -match '(?m)^\s*\$useExistingHint = \$null -ne \$noOpHint\s*$') "Full reconciliation may reuse a bulk contact hint only when the exact-no-op probe succeeds"
Assert-True ($upsertContactFunctionText -match 'Resolve-ExchangeMailContactFromLiveRead \$Contact') "A stale bulk contact hint that needs mutation must be replaced by a fresh targeted read with a narrow Graph fallback"
Assert-True ($upsertContactFunctionText -match 'Get-ExchangeMailContactByImmutableIdentity \$existing') "A Graph-invalid managed contact must be reread by immutable identity before exact recreation"
$confirmContactDeletionFunctionText = (Get-Item Function:Confirm-ExchangeMailContactDeletion).ScriptBlock.ToString()
Assert-True ($confirmContactDeletionFunctionText -match '\$ExchangeGroupPropagationMaxAttempts') "Contact deletion verification must use the bounded Exchange propagation window"
Assert-True ($confirmContactDeletionFunctionText -match 'legacy Graph-invalid contact by immutable identity') "Contact deletion verification must retry the exact legacy Graph-invalid identity read instead of declaring absence"
Assert-True ($confirmContactDeletionFunctionText -match 'legacy Graph-invalid contact to filtered reads') "Contact deletion verification must retry the exact legacy Graph-invalid filtered read instead of declaring absence"

$savedGetMailContact = (Get-Item Function:Get-MailContact).ScriptBlock
$savedGetContact = (Get-Item Function:Get-Contact).ScriptBlock
$savedSetMailContact = (Get-Item Function:Set-MailContact).ScriptBlock
$savedSetContact = (Get-Item Function:Set-Contact).ScriptBlock
$savedNewMailContact = (Get-Item Function:New-MailContact).ScriptBlock
$hadStartSleepFunction = Test-Path Function:Start-Sleep
$savedStartSleep = if ($hadStartSleepFunction) { (Get-Item Function:Start-Sleep).ScriptBlock } else { $null }
$desiredOceanCreate = [pscustomobject]@{
  DirectoryName = $oceanAnderson.DirectoryName
  DisplayName = "OCEAN PARTNERS"
  ExternalEmailAddress = "anderson@op-energy.co.kr"
  Alias = $oceanAnderson.Alias
  FirstName = ""
  LastName = ""
  SourceKey = "FCUNO_CONTACT:ocean-anderson"
  AllowedOwnerSourceKeys = @("FCUNO_CONTACT:ocean-anderson")
}
$script:createdOceanMailContact = [pscustomobject]@{
  Identity = "ocean-created"
  Guid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  ExternalDirectoryObjectId = "external-ocean-created"
  DistinguishedName = "CN=OCEAN PARTNERS Created,OU=Contacts,DC=example,DC=com"
  Name = $desiredOceanCreate.DirectoryName
  DisplayName = "OCEAN PARTNERS"
  ExternalEmailAddress = "SMTP:anderson@op-energy.co.kr"
  Alias = $desiredOceanCreate.Alias
  CustomAttribute1 = ""
  CustomAttribute2 = ""
  HiddenFromAddressListsEnabled = $false
}
$script:createdOceanProfile = [pscustomobject]@{
  Identity = $script:createdOceanMailContact.DistinguishedName
  Guid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  DistinguishedName = "CN=OCEAN PARTNERS Profile,OU=Contacts,DC=example,DC=com"
  Alias = $desiredOceanCreate.Alias
  FirstName = ""
  LastName = ""
}
$script:createdOceanNewCalled = $false
$script:createdOceanSourceReads = 0
$script:createdOceanProfileFilterCalls = 0
$script:createdOceanSetIdentity = ""
$script:createdOceanNewName = ""
$script:createdOceanNewDisplayName = ""
$script:createdOceanSleepCalls = 0
$script:createdOceanAmbiguousProfiles = $false
Set-Item Function:Get-MailContact -Value {
  [CmdletBinding()]
  param($Filter, $ResultSize, $Identity)
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_CONTACT:ocean-anderson'" -and $script:createdOceanNewCalled) {
    $script:createdOceanSourceReads += 1
    if ($script:createdOceanSourceReads -eq 2) {
      return [pscustomobject]@{
        Identity = $script:createdOceanMailContact.Identity
        Guid = $script:createdOceanMailContact.Guid
        ExternalDirectoryObjectId = $script:createdOceanMailContact.ExternalDirectoryObjectId
        DistinguishedName = $script:createdOceanMailContact.DistinguishedName
        Name = "Eventually consistent old OCEAN name"
        DisplayName = $script:createdOceanMailContact.DisplayName
        ExternalEmailAddress = $script:createdOceanMailContact.ExternalEmailAddress
        Alias = $script:createdOceanMailContact.Alias
        CustomAttribute1 = $script:createdOceanMailContact.CustomAttribute1
        CustomAttribute2 = $script:createdOceanMailContact.CustomAttribute2
        HiddenFromAddressListsEnabled = $script:createdOceanMailContact.HiddenFromAddressListsEnabled
      }
    }
    return $script:createdOceanMailContact
  }
  return $null
}
Set-Item Function:Get-Contact -Value {
  [CmdletBinding()]
  param($Identity, $Filter, $RecipientTypeDetails, $ResultSize)
  if ($Filter -like "Guid -eq '$($script:createdOceanMailContact.Guid)'") {
    $script:createdOceanProfileFilterCalls += 1
    if ($script:createdOceanAmbiguousProfiles) {
      return @($script:createdOceanProfile, [pscustomobject]@{
        Identity = $script:createdOceanMailContact.DistinguishedName
        Guid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        DistinguishedName = "CN=Conflicting OCEAN Profile,OU=Contacts,DC=example,DC=com"
        Alias = $desiredOceanCreate.Alias
      })
    }
    if ($script:createdOceanProfileFilterCalls -le 2) { return $null }
    return $script:createdOceanProfile
  }
  if ($Identity -eq $script:createdOceanProfile.Guid) { return $script:createdOceanProfile }
  return $null
}
Set-Item Function:Set-MailContact -Value {
  [CmdletBinding()]
  param($Identity, $ExternalEmailAddress, $Alias, $CustomAttribute1, $CustomAttribute2, $HiddenFromAddressListsEnabled)
  $script:createdOceanMailContact.CustomAttribute1 = $CustomAttribute1
  $script:createdOceanMailContact.CustomAttribute2 = $CustomAttribute2
  $script:createdOceanMailContact.HiddenFromAddressListsEnabled = [bool]$HiddenFromAddressListsEnabled
}
Set-Item Function:Set-Contact -Value {
  [CmdletBinding()]
  param($Identity, $Name, $DisplayName, $FirstName, $LastName)
  $script:createdOceanSetIdentity = Clean-Text $Identity
  $script:createdOceanMailContact.Name = Clean-Text $Name
  $script:createdOceanMailContact.DisplayName = Clean-Text $DisplayName
}
Set-Item Function:New-MailContact -Value {
  [CmdletBinding()]
  param($Name, $DisplayName, $ExternalEmailAddress, $Alias)
  $script:createdOceanNewCalled = $true
  $script:createdOceanNewName = Clean-Text $Name
  $script:createdOceanNewDisplayName = Clean-Text $DisplayName
  return $script:createdOceanMailContact
}
Set-Item Function:Start-Sleep -Value {
  param($Seconds)
  $script:createdOceanSleepCalls += 1
}
try {
  $createdOceanStats = @{}
  Upsert-ExchangeMailContact $desiredOceanCreate $createdOceanStats
  Assert-Equal $desiredOceanCreate.DirectoryName $script:createdOceanNewName "New-MailContact must use the unique deterministic directory Name"
  Assert-Equal "OCEAN PARTNERS" $script:createdOceanNewDisplayName "New-MailContact must retain the exact shared FCUNO display name"
  Assert-Equal $script:createdOceanProfile.Guid $script:createdOceanSetIdentity "Set-Contact must target the exact resolved profile GUID after creation"
  Assert-True ($script:createdOceanSetIdentity -cne $desiredOceanCreate.ExternalEmailAddress) "Set-Contact must never use external email as its command identity"
  Assert-Equal 3 $script:createdOceanSleepCalls "Profile and mail-contact metadata propagation must both use bounded retry waits"
  Assert-Equal 3 $script:createdOceanSourceReads "Final verification must reread a stale Name until the exact directory name becomes visible"
  Assert-Equal 1 $createdOceanStats.createdContacts "A fully verified new OCEAN contact must be counted once"

  $script:createdOceanAmbiguousProfiles = $true
  $ambiguousAliasReadStart = $script:createdOceanProfileFilterCalls
  $ambiguousAliasSleepStart = $script:createdOceanSleepCalls
  $ambiguousAliasFailedClosed = $false
  try {
    Resolve-ExchangeContactProfileForMailContact $script:createdOceanMailContact "Ambiguous OCEAN contact" 4 | Out-Null
  } catch {
    $ambiguousAliasFailedClosed = $_.Exception.Message -match "found 2 Exchange contact profiles"
  }
  Assert-True $ambiguousAliasFailedClosed "An alias resolving to multiple contact profiles must fail closed"
  Assert-Equal 1 ($script:createdOceanProfileFilterCalls - $ambiguousAliasReadStart) "An ambiguous profile alias must fail immediately without repeated reads"
  Assert-Equal 0 ($script:createdOceanSleepCalls - $ambiguousAliasSleepStart) "An ambiguous profile alias must not wait or retry"
} finally {
  Set-Item Function:Get-MailContact -Value $savedGetMailContact
  Set-Item Function:Get-Contact -Value $savedGetContact
  Set-Item Function:Set-MailContact -Value $savedSetMailContact
  Set-Item Function:Set-Contact -Value $savedSetContact
  Set-Item Function:New-MailContact -Value $savedNewMailContact
  if ($hadStartSleepFunction) {
    Set-Item Function:Start-Sleep -Value $savedStartSleep
  } else {
    Remove-Item Function:Start-Sleep
  }
}

$desiredNoOpGroup = [pscustomobject]@{
  SourceGroupId = "g-unchanged"
  DirectoryName = "Unchanged Group"
  GroupName = "Unchanged Group"
  Alias = "unchanged-group"
  SmtpAddress = "unchanged-group@cosulich1.onmicrosoft.com"
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
  PrimarySmtpAddress = "unchanged-group@cosulich1.onmicrosoft.com"
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
$script:newDistributionGroupInitialName = ""
$script:newDistributionGroupInitialDisplayName = ""
$script:newGroupProfile = $null
$script:newGroupProfilePropagationMisses = 0
$script:newGroupMetadataWriteMisses = 0
$script:newGroupMetadataSetAttempts = 0
$script:newGroupMetadataSetIdentities = @()
$script:newGroupMetadataHardFailure = $false
$script:newGroupMetadataHardFailureMessage = "||Exchange authorization denied the distribution-group metadata write."
$script:newGroupMetadataNotFoundMessage = "||The operation couldn't be performed because object 'g-ocean-bba895' couldn't be found on 'TPXPR04A01DC002.APCPR04A001.prod.outlook.com'."
$script:newGroupProfileWriteMisses = 0
$script:newGroupProfileSetAttempts = 0
$script:newGroupProfileSleepCalls = 0
$script:newGroupProfileSleepSeconds = @()
$script:newGroupSetIdentity = ""
$script:membershipResolvedGroup = $null
$script:collisionRenameOrder = @()
$script:collisionRenameSetGroupIdentity = ""
$script:collisionRenameDistributionGroup = [pscustomobject]@{
  Identity = "g-ocean"
  Guid = "66666666-6666-4666-8666-666666666666"
  ExternalDirectoryObjectId = "external-g-ocean-shared"
  DistinguishedName = "CN=G OCEAN,OU=Groups,DC=example,DC=com"
  Name = "G OCEAN"
  DisplayName = "G OCEAN"
  Alias = "g-ocean"
  PrimarySmtpAddress = "g-ocean@cosulich1.onmicrosoft.com"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_GROUP:g-ocean-collision"
  HiddenFromAddressListsEnabled = $false
}
$script:collisionRenameGroupProfile = [pscustomobject]@{
  Identity = "CN=G OCEAN,OU=Groups,DC=example,DC=com"
  Guid = "77777777-7777-4777-8777-777777777777"
  ExternalDirectoryObjectId = "external-g-ocean-shared"
  DistinguishedName = "CN=G OCEAN,OU=Groups,DC=example,DC=com"
  Notes = "Current G OCEAN description"
}
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
  if (
    $Filter -like "CustomAttribute2 -eq 'FCUNO_GROUP:g-new'" -and
    $script:newDistributionGroup -and
    $script:newDistributionGroup.CustomAttribute2 -eq "FCUNO_GROUP:g-new"
  ) {
    return $script:newDistributionGroup
  }
  if ($script:newDistributionGroup -and $Identity -eq $script:newDistributionGroup.Alias) {
    return $script:newDistributionGroup
  }
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_GROUP:g-ocean-collision'") {
    return $script:collisionRenameDistributionGroup
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
  if ($script:newGroupProfile -and $Identity -eq "44444444-4444-4444-8444-444444444444") {
    if ($script:newGroupProfilePropagationMisses -gt 0) {
      $script:newGroupProfilePropagationMisses -= 1
      throw "The operation couldn't be performed because object 'new-group' couldn't be found on 'TPXPR04A01DC002.APCPR04A001.prod.outlook.com'."
    }
    return $script:newGroupProfile
  }
  if ($script:newGroupProfile -and $Identity -in @("new-group", "88888888-8888-4888-8888-888888888888")) {
    return $script:newGroupProfile
  }
  if ($Identity -in @(
    $script:collisionRenameDistributionGroup.Guid,
    $script:collisionRenameGroupProfile.Guid,
    $script:collisionRenameGroupProfile.DistinguishedName
  )) {
    return $script:collisionRenameGroupProfile
  }
  return $null
}
function Set-DistributionGroup {
  [CmdletBinding()]
  param($Identity, $Alias, $PrimarySmtpAddress, $Name, $DisplayName, $Notes, $CustomAttribute1, $CustomAttribute2, $HiddenFromAddressListsEnabled)
  $script:setDistributionGroupCalls += 1
  if ($script:newDistributionGroup -and $Identity -in @($script:newDistributionGroup.Identity, $script:newDistributionGroup.Guid)) {
    $script:newGroupMetadataSetAttempts += 1
    $script:newGroupMetadataSetIdentities += $Identity
    if ($script:newGroupMetadataHardFailure) {
      throw $script:newGroupMetadataHardFailureMessage
    }
    if ($script:newGroupMetadataWriteMisses -gt 0) {
      $script:newGroupMetadataWriteMisses -= 1
      throw $script:newGroupMetadataNotFoundMessage
    }
    $script:newDistributionGroup.CustomAttribute1 = $CustomAttribute1
    $script:newDistributionGroup.CustomAttribute2 = $CustomAttribute2
    $script:newDistributionGroup.HiddenFromAddressListsEnabled = [bool]$HiddenFromAddressListsEnabled
    if (Clean-Text $Alias) { $script:newDistributionGroup.Alias = $Alias }
    if (Clean-Text $PrimarySmtpAddress) { $script:newDistributionGroup.PrimarySmtpAddress = $PrimarySmtpAddress }
    if (Clean-Text $Name) { $script:newDistributionGroup.Name = $Name }
    if (Clean-Text $DisplayName) { $script:newDistributionGroup.DisplayName = $DisplayName }
  }
  if ($Identity -eq $script:collisionRenameDistributionGroup.Guid) {
    $script:collisionRenameOrder += "distribution recipient"
    $script:collisionRenameDistributionGroup.Alias = $Alias
    $script:collisionRenameDistributionGroup.PrimarySmtpAddress = $PrimarySmtpAddress
    $script:collisionRenameDistributionGroup.Name = $Name
    $script:collisionRenameDistributionGroup.DisplayName = $DisplayName
    $script:collisionRenameDistributionGroup.CustomAttribute1 = $CustomAttribute1
    $script:collisionRenameDistributionGroup.CustomAttribute2 = $CustomAttribute2
    $script:collisionRenameDistributionGroup.HiddenFromAddressListsEnabled = [bool]$HiddenFromAddressListsEnabled
  }
}
function Set-Group {
  [CmdletBinding()]
  param($Identity, $Notes)
  $script:setGroupCalls += 1
  if ($Identity -in @("44444444-4444-4444-8444-444444444444", "88888888-8888-4888-8888-888888888888")) {
    $script:newGroupSetIdentity = $Identity
    if ($Identity -ne "88888888-8888-4888-8888-888888888888") {
      throw "Set-Group must not use the New-DistributionGroup recipient identity."
    }
    $script:newGroupProfileSetAttempts += 1
    if ($script:newGroupProfileWriteMisses -gt 0) {
      $script:newGroupProfileWriteMisses -= 1
      throw "The operation couldn't be performed because object 'new-group' couldn't be found on 'TPXPR04A01DC003.APCPR04A001.prod.outlook.com'."
    }
    $script:newGroupProfile.Notes = $Notes
  }
  if ($Identity -in @("unchanged-group", "33333333-3333-4333-8333-333333333333")) { $script:noOpGroupProfile.Notes = $Notes }
  if ($Identity -in @($script:collisionRenameDistributionGroup.Guid, $script:collisionRenameGroupProfile.Guid)) {
    $script:collisionRenameOrder += "group profile"
    $script:collisionRenameSetGroupIdentity = $Identity
    if ($script:collisionRenameDistributionGroup.Alias -eq "g-ocean-bba895" -or $Identity -ne $script:collisionRenameGroupProfile.Guid) {
      throw "The operation couldn't be performed because object 'g-ocean-bba895' couldn't be found on 'TPXPR04A01DC002.APCPR04A001.prod.outlook.com'."
    }
    $script:collisionRenameGroupProfile.Notes = $Notes
  }
}
function New-DistributionGroup {
  [CmdletBinding()]
  param($Name, $DisplayName, $Alias, $PrimarySmtpAddress)
  if ($Alias -eq "new-group") {
    $script:newDistributionGroupCalls += 1
    $script:newDistributionGroupInitialName = $Name
    $script:newDistributionGroupInitialDisplayName = $DisplayName
    $script:newDistributionGroup = [pscustomobject]@{
      Identity = "new-group"
      Guid = "44444444-4444-4444-8444-444444444444"
      ExternalDirectoryObjectId = "external-new-group"
      DistinguishedName = "CN=New Group,OU=Groups,DC=example,DC=com"
      Name = $Name
      DisplayName = $DisplayName
      Alias = $Alias
      PrimarySmtpAddress = $PrimarySmtpAddress
      CustomAttribute1 = ""
      CustomAttribute2 = ""
      HiddenFromAddressListsEnabled = $false
    }
    $script:newGroupProfile = [pscustomobject]@{
      Identity = "CN=New Group,OU=Groups,DC=example,DC=com"
      Guid = "88888888-8888-4888-8888-888888888888"
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

$desiredCollisionRenameGroup = [pscustomobject]@{
  SourceGroupId = "g-ocean-collision"
  DirectoryName = "G OCEAN [managed-group]"
  GroupName = "G OCEAN"
  BaseAlias = "g-ocean"
  Alias = "g-ocean-bba895"
  SmtpAddress = "g-ocean-bba895@cosulich1.onmicrosoft.com"
  Description = "Current G OCEAN description"
  SourceKey = "FCUNO_GROUP:g-ocean-collision"
}
$script:collisionRenameOrder = @()
$script:collisionRenameSetGroupIdentity = ""
$collisionRenameStats = @{}
Upsert-ExchangeDistributionGroup $desiredCollisionRenameGroup $collisionRenameStats $true
Assert-Equal "group profile,distribution recipient" ($script:collisionRenameOrder -join ",") "A stale group whose alias changes after a contact/group collision must update its immutable group profile before renaming the distribution recipient"
Assert-Equal $script:collisionRenameGroupProfile.Guid $script:collisionRenameSetGroupIdentity "Set-Group must use the correlated Get-Group profile identity, never the distribution-recipient identity"
Assert-Equal "g-ocean-bba895" $script:collisionRenameDistributionGroup.Alias "The collision-suffixed group alias must be applied in place"
Assert-Equal $desiredCollisionRenameGroup.SmtpAddress $script:collisionRenameDistributionGroup.PrimarySmtpAddress "An updated group must receive the exact certified PrimarySmtpAddress"
Assert-Equal $desiredCollisionRenameGroup.DirectoryName $script:collisionRenameDistributionGroup.Name "A contact/group collision must update the group to its distinct directory Name"
Assert-Equal $desiredCollisionRenameGroup.GroupName $script:collisionRenameDistributionGroup.DisplayName "A collision-safe directory rename must preserve the exact visible group DisplayName"
Assert-Equal 1 $collisionRenameStats.updatedGroups "A collision-suffixed existing group must be counted as updated"
Assert-Equal 1 $collisionRenameStats.verifiedQueueRows "A collision-suffixed existing group must pass exact post-rename verification"

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
Assert-Equal 2 $script:getGroupCalls "Incremental group processing must resolve the authoritative profile before mutation and verify Notes afterward"
Assert-Equal 1 $script:setDistributionGroupCalls "Incremental group processing must retain its existing upsert behavior"
Assert-Equal 1 $script:setGroupCalls "Incremental group processing must update Notes through Set-Group"
Assert-Equal 1 $incrementalGroupStats.updatedGroups "Incremental group processing must still report its update"

$script:getDistributionGroupCalls = 0
$script:getGroupCalls = 0
$script:staleGroupProfileReads = 6
$script:eventualGroupSleepSeconds = @()
Set-Item Function:Start-Sleep -Value { param($Seconds) $script:eventualGroupSleepSeconds += $Seconds }
try {
  $eventualGroupStats = @{}
  Upsert-ExchangeDistributionGroup $desiredNoOpGroup $eventualGroupStats
  Assert-Equal 7 $script:getDistributionGroupCalls "Final group verification must outlast five lagging Exchange DC reads before metadata settles"
  Assert-Equal 7 $script:getGroupCalls "Final group verification must outlast five lagging authoritative Notes reads"
  Assert-Equal 5 $script:eventualGroupSleepSeconds.Count "Final verification must keep retrying beyond the previous four-attempt window"
  Assert-Equal $ExchangeGroupPropagationDelaySeconds (@($script:eventualGroupSleepSeconds | Sort-Object -Unique) -join ",") "Final verification retries must use the shared Exchange propagation delay"
  Assert-Equal 1 $eventualGroupStats.verifiedQueueRows "Eventually consistent group Notes must be accepted only after an exact fresh verification"
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
  $script:staleGroupProfileReads = 0
}

$newDesiredGroup = [pscustomobject]@{
  SourceGroupId = "g-new"
  DirectoryName = "New Group [collision-safe]"
  GroupName = "New Group"
  Alias = "new-group"
  SmtpAddress = "new-group@cosulich1.onmicrosoft.com"
  Description = "New group notes"
  SourceKey = "FCUNO_GROUP:g-new"
}
$newGroupStats = @{}
$script:getGroupCalls = 0
$script:newGroupMetadataWriteMisses = 2
$script:newGroupMetadataSetAttempts = 0
$script:newGroupProfilePropagationMisses = 1
$script:newGroupProfileWriteMisses = 2
$script:newGroupProfileSetAttempts = 0
$script:newGroupProfileSleepCalls = 0
$script:newGroupProfileSleepSeconds = @()
Set-Item Function:Start-Sleep -Value {
  param($Seconds)
  $script:newGroupProfileSleepCalls += 1
  $script:newGroupProfileSleepSeconds += $Seconds
}
try {
  Upsert-ExchangeDistributionGroup $newDesiredGroup $newGroupStats
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
}
Assert-Equal 1 $script:newDistributionGroupCalls "A missing distribution group must still be created"
Assert-Equal $newDesiredGroup.DirectoryName $script:newDistributionGroupInitialName "New-DistributionGroup must use the collision-safe directory Name from the canonical projection"
Assert-Equal $newDesiredGroup.GroupName $script:newDistributionGroupInitialDisplayName "New-DistributionGroup must preserve the exact visible FCUNO group name as DisplayName"
Assert-Equal $newDesiredGroup.SmtpAddress $script:newDistributionGroup.PrimarySmtpAddress "New-DistributionGroup must set the exact certified PrimarySmtpAddress"
Assert-Equal 3 $script:newGroupMetadataSetAttempts "A newly created group marker write must retry the exact live transport-prefixed cross-DC not-found response"
Assert-Equal 3 $script:newGroupProfileSetAttempts "A newly created group Notes write must retry transient cross-DC not-found responses"
Assert-Equal 5 $script:getGroupCalls "Transient Notes-write misses must force four immutable profile resolutions before the final exact verification read"
Assert-Equal 5 $script:newGroupProfileSleepCalls "New group marker, profile, and Notes propagation must use bounded retry waits"
Assert-Equal $ExchangeGroupPropagationDelaySeconds (@($script:newGroupProfileSleepSeconds | Sort-Object -Unique) -join ",") "All new-group retries must use the shared Exchange propagation delay"
Assert-Equal $script:newGroupProfile.Guid $script:newGroupSetIdentity "Set-Group must use the independently resolved new-group profile GUID"
Assert-True ($script:newGroupSetIdentity -ne $script:newDistributionGroup.Guid) "Set-Group must never reuse the New-DistributionGroup recipient GUID"
Assert-Equal "New group notes" $script:newGroupProfile.Notes "A new distribution group must receive authoritative Notes through Set-Group"
Assert-Equal 1 $newGroupStats.createdGroups "A new distribution group must be reported as created"

Assert-True ($ExchangeGroupPropagationMaxAttempts -ge 8) "Exchange group propagation must retain at least eight bounded attempts"
Assert-True (($ExchangeGroupPropagationMaxAttempts - 1) * $ExchangeGroupPropagationDelaySeconds -ge 30) "Exchange group propagation must retain at least a 30-second retry window"

$script:newGroupMetadataHardFailure = $true
$script:newGroupMetadataSetAttempts = 0
$script:newGroupMetadataSetIdentities = @()
$script:nonTransientGroupSleepCalls = 0
$nonTransientGroupFailure = ""
Set-Item Function:Start-Sleep -Value { param($Seconds) $script:nonTransientGroupSleepCalls += 1 }
try {
  try {
    Set-ExchangeDistributionGroupMetadataWithRetry $script:newDistributionGroup $newDesiredGroup "Non-transient new group"
  } catch {
    $nonTransientGroupFailure = $_.Exception.Message
  }
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
  $script:newGroupMetadataHardFailure = $false
}
Assert-True ($nonTransientGroupFailure -match "authorization denied") "A non-not-found Exchange write error must be returned unchanged"
Assert-Equal 1 $script:newGroupMetadataSetAttempts "A non-not-found metadata error must fail immediately"
Assert-Equal 0 $script:nonTransientGroupSleepCalls "A non-not-found metadata error must not enter the propagation retry loop"

$script:newGroupMetadataHardFailure = $true
$script:newGroupMetadataHardFailureMessage = "||Exchange request failed because the remote transport session was interrupted."
$script:newGroupMetadataSetAttempts = 0
$script:unrelatedGroupSleepCalls = 0
$unrelatedGroupFailure = ""
Set-Item Function:Start-Sleep -Value { param($Seconds) $script:unrelatedGroupSleepCalls += 1 }
try {
  try {
    Set-ExchangeDistributionGroupMetadataWithRetry $script:newDistributionGroup $newDesiredGroup "Unrelated new group failure"
  } catch {
    $unrelatedGroupFailure = $_.Exception.Message
  }
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
  $script:newGroupMetadataHardFailure = $false
  $script:newGroupMetadataHardFailureMessage = "||Exchange authorization denied the distribution-group metadata write."
}
Assert-True ($unrelatedGroupFailure -match "transport session was interrupted") "A transport-prefixed unrelated Exchange write error must be returned unchanged"
Assert-Equal 1 $script:newGroupMetadataSetAttempts "A transport-prefixed unrelated metadata error must fail immediately"
Assert-Equal 0 $script:unrelatedGroupSleepCalls "A transport-prefixed unrelated metadata error must not enter the propagation retry loop"

# Prove that exhausting the bounded metadata window leaves one recoverable bare group, and that
# the next run adopts it by the exact alias instead of issuing a duplicate New-DistributionGroup.
$script:newDistributionGroupCalls = 0
$script:newDistributionGroup = $null
$script:newGroupProfile = $null
$script:newGroupMetadataWriteMisses = $ExchangeGroupPropagationMaxAttempts
$script:newGroupMetadataSetAttempts = 0
$script:newGroupMetadataSetIdentities = @()
$script:newGroupProfilePropagationMisses = 0
$script:newGroupProfileWriteMisses = 0
$script:exhaustedGroupSleepSeconds = @()
$exhaustedGroupFailure = ""
$exhaustedGroupStats = @{}
Set-Item Function:Start-Sleep -Value { param($Seconds) $script:exhaustedGroupSleepSeconds += $Seconds }
try {
  try {
    Upsert-ExchangeDistributionGroup $newDesiredGroup $exhaustedGroupStats
  } catch {
    $exhaustedGroupFailure = $_.Exception.Message
  }
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
}
Assert-True ($exhaustedGroupFailure -match "metadata propagation failed after $ExchangeGroupPropagationMaxAttempts attempt") "A fully exhausted propagation window must report the bounded attempt count"
Assert-Equal 1 $script:newDistributionGroupCalls "A failed first run must create exactly one bare Exchange group"
Assert-Equal $ExchangeGroupPropagationMaxAttempts $script:newGroupMetadataSetAttempts "A transient metadata miss must consume the complete shared propagation budget before failing"
Assert-Equal ($ExchangeGroupPropagationMaxAttempts - 1) $script:exhaustedGroupSleepSeconds.Count "A bounded propagation failure must wait only between attempts"
Assert-Equal $ExchangeGroupPropagationDelaySeconds (@($script:exhaustedGroupSleepSeconds | Sort-Object -Unique) -join ",") "An exhausted metadata retry must use the shared propagation delay"
Assert-Equal 1 @($script:newGroupMetadataSetIdentities | Sort-Object -Unique).Count "Every metadata retry must target one immutable Exchange identity"
Assert-Equal $script:newDistributionGroup.Guid (@($script:newGroupMetadataSetIdentities | Sort-Object -Unique)[0]) "Every metadata retry must use the New-DistributionGroup GUID, never its alias"
Assert-Equal "" $script:newDistributionGroup.CustomAttribute2 "A failed marker write must leave the bare group unclaimed for exact alias recovery"
Assert-Equal 0 ([int]$exhaustedGroupStats.createdGroups) "A group must not be counted as created when its metadata write never verified"

# The next run must enter the existing/alias-recovery branch. A non-not-found write error must
# fail immediately there as well, without sleeping or attempting a duplicate group creation.
$script:newGroupMetadataHardFailure = $true
$script:newGroupMetadataSetAttempts = 0
$script:newGroupMetadataSetIdentities = @()
$script:newGroupProfilePropagationMisses = 0
$script:newGroupProfileWriteMisses = 0
$script:newGroupProfileSetAttempts = 0
$script:aliasRecoveryHardFailureSleepCalls = 0
$aliasRecoveryHardFailure = ""
$aliasRecoveryHardFailureStats = @{}
Set-Item Function:Start-Sleep -Value { param($Seconds) $script:aliasRecoveryHardFailureSleepCalls += 1 }
try {
  try {
    Upsert-ExchangeDistributionGroup $newDesiredGroup $aliasRecoveryHardFailureStats
  } catch {
    $aliasRecoveryHardFailure = $_.Exception.Message
  }
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
  $script:newGroupMetadataHardFailure = $false
}
Assert-True ($aliasRecoveryHardFailure -match "authorization denied") "Alias recovery must return a non-not-found metadata error unchanged"
Assert-Equal 1 $script:newGroupMetadataSetAttempts "Alias recovery must fail immediately on a non-not-found metadata error"
Assert-Equal 0 $script:aliasRecoveryHardFailureSleepCalls "Alias recovery must not sleep after a non-not-found metadata error"
Assert-Equal 1 $script:newDistributionGroupCalls "A hard failure while recovering an exact alias must not create a duplicate group"
Assert-Equal 0 ([int]$aliasRecoveryHardFailureStats.updatedGroups) "A failed alias recovery must not be counted as updated"
Assert-Equal $script:newDistributionGroup.Guid $script:newGroupMetadataSetIdentities[0] "Alias recovery must target the existing group's immutable GUID"

# Transient not-found responses in that same existing branch must consume the complete shared
# retry budget before failure and must keep targeting only the immutable recovered recipient.
$script:newGroupMetadataWriteMisses = $ExchangeGroupPropagationMaxAttempts
$script:newGroupMetadataSetAttempts = 0
$script:newGroupMetadataSetIdentities = @()
$script:aliasRecoveryExhaustedSleepSeconds = @()
$aliasRecoveryExhaustedFailure = ""
$aliasRecoveryExhaustedStats = @{}
Set-Item Function:Start-Sleep -Value { param($Seconds) $script:aliasRecoveryExhaustedSleepSeconds += $Seconds }
try {
  try {
    Upsert-ExchangeDistributionGroup $newDesiredGroup $aliasRecoveryExhaustedStats
  } catch {
    $aliasRecoveryExhaustedFailure = $_.Exception.Message
  }
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
}
Assert-True ($aliasRecoveryExhaustedFailure -match "metadata propagation failed after $ExchangeGroupPropagationMaxAttempts attempt") "Alias recovery must report exhaustion of the shared metadata retry budget"
Assert-Equal $ExchangeGroupPropagationMaxAttempts $script:newGroupMetadataSetAttempts "Alias recovery must use every shared propagation attempt for transient not-found writes"
Assert-Equal ($ExchangeGroupPropagationMaxAttempts - 1) $script:aliasRecoveryExhaustedSleepSeconds.Count "Alias recovery must wait only between transient metadata attempts"
Assert-Equal $ExchangeGroupPropagationDelaySeconds (@($script:aliasRecoveryExhaustedSleepSeconds | Sort-Object -Unique) -join ",") "Alias recovery must use the shared propagation delay"
Assert-Equal 1 @($script:newGroupMetadataSetIdentities | Sort-Object -Unique).Count "Every exhausted alias-recovery retry must target one immutable Exchange identity"
Assert-Equal $script:newDistributionGroup.Guid (@($script:newGroupMetadataSetIdentities | Sort-Object -Unique)[0]) "Every exhausted alias-recovery retry must use the existing Exchange GUID"
Assert-Equal 1 $script:newDistributionGroupCalls "An exhausted exact-alias recovery must not create a duplicate group"
Assert-Equal 0 ([int]$aliasRecoveryExhaustedStats.updatedGroups) "An exhausted alias recovery must not be counted as updated"

# A later alias-recovery run must tolerate transient cross-DC misses and complete in place.
$script:newGroupMetadataWriteMisses = 2
$script:newGroupMetadataSetAttempts = 0
$script:newGroupMetadataSetIdentities = @()
$script:aliasRecoverySuccessSleepSeconds = @()
$recoveredGroupStats = @{}
Set-Item Function:Start-Sleep -Value { param($Seconds) $script:aliasRecoverySuccessSleepSeconds += $Seconds }
try {
  Upsert-ExchangeDistributionGroup $newDesiredGroup $recoveredGroupStats
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
}
Assert-Equal 1 $script:newDistributionGroupCalls "The next run must recover the exact alias and must not create a second Exchange group"
Assert-Equal 3 $script:newGroupMetadataSetAttempts "Alias recovery must retry transient metadata not-found responses until success"
Assert-Equal 2 $script:aliasRecoverySuccessSleepSeconds.Count "A successful alias recovery must wait only between its transient write attempts"
Assert-Equal $ExchangeGroupPropagationDelaySeconds (@($script:aliasRecoverySuccessSleepSeconds | Sort-Object -Unique) -join ",") "Successful alias recovery must use the shared propagation delay"
Assert-Equal 1 @($script:newGroupMetadataSetIdentities | Sort-Object -Unique).Count "Successful alias-recovery retries must keep one immutable target"
Assert-Equal $script:newDistributionGroup.Guid (@($script:newGroupMetadataSetIdentities | Sort-Object -Unique)[0]) "Successful alias recovery must use the existing Exchange GUID, never its alias"
Assert-Equal 1 $recoveredGroupStats.updatedGroups "The recovered bare group must be completed as an in-place update"
Assert-Equal 1 $recoveredGroupStats.verifiedQueueRows "The recovered bare group must pass exact metadata and Notes verification"
Assert-Equal $newDesiredGroup.SourceKey $script:newDistributionGroup.CustomAttribute2 "Alias recovery must attach the exact FCUNO group source key"
Assert-Equal $newDesiredGroup.Description $script:newGroupProfile.Notes "Alias recovery must complete the authoritative group Notes"

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
$script:noOpDistributionGroup.PrimarySmtpAddress = "unchanged-group@wrong.example"
$driftedGroupSmtpFinalStats = @{ failedQueueRows = 0; changeDetails = @() }
Confirm-FinalExchangeProjection $finalProjectionRows @($script:noOpMailContact) @($script:noOpContactProfile) @($script:noOpDistributionGroup) @($script:noOpGroupProfile) $driftedGroupSmtpFinalStats
Assert-True ([int]$driftedGroupSmtpFinalStats.failedQueueRows -gt 0) "Fresh final certification must reject a drifted Exchange group PrimarySmtpAddress"
Assert-True ((@($driftedGroupSmtpFinalStats.changeDetails | ForEach-Object { $_.result }) -join " ") -match "primary SMTP address") "Fresh final certification must identify the drifted group PrimarySmtpAddress"
$script:noOpDistributionGroup.PrimarySmtpAddress = $desiredNoOpGroup.SmtpAddress

$preservedShadowMailContact = [pscustomobject]@{
  Identity = "preserved-shadow-placeholder"
  Guid = "b1111111-1111-4111-8111-111111111111"
  ExternalDirectoryObjectId = "b2222222-2222-4222-8222-222222222222"
  DistinguishedName = "CN=Preserved Shadow Placeholder,OU=Contacts,DC=example,DC=com"
  Name = "Preserved Shadow Placeholder"
  DisplayName = "Preserved Shadow Placeholder"
  Alias = "preserved-shadow-placeholder"
  ExternalEmailAddress = $desiredNoOpContact.ExternalEmailAddress
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_CONTACT:shadow-placeholder"
  HiddenFromAddressListsEnabled = $false
}
$shadowFinalProjectionRows = @{
  Contacts = @($desiredNoOpContact)
  Groups = @($desiredNoOpGroup)
  Members = @()
  SkippedInvalidContacts = @($groupShadowRows.SkippedInvalidContacts)
}
$shadowFinalStats = @{ failedQueueRows = 0; changeDetails = @() }
Confirm-FinalExchangeProjection `
  $shadowFinalProjectionRows `
  @($script:noOpMailContact, $preservedShadowMailContact) `
  @($script:noOpContactProfile) `
  @($script:noOpDistributionGroup) `
  @($script:noOpGroupProfile) `
  $shadowFinalStats
Assert-Equal 0 $shadowFinalStats.failedQueueRows "A preserved managed contact for a skipped placeholder source key must not invalidate final certification"
Assert-Equal 1 $shadowFinalStats.verifiedManagedContacts "Preserved placeholder contacts must be excluded from the certifiable managed-contact count"

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

$script:removeCalled = $false
$shadowManagedContact = [pscustomobject]@{
  Identity = "managed-shadow-placeholder"
  DisplayName = "Managed shadow placeholder"
  ExternalEmailAddress = "formerly-valid-shadow@example.com"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_CONTACT:shadow-placeholder"
}
$shadowProtectionRows = @{
  Contacts = @()
  InvalidContacts = @()
  SkippedInvalidContacts = @($groupShadowRows.SkippedInvalidContacts)
}
$shadowProtectionStats = @{ removedContacts = 0; preservedInvalidContacts = 0; failedQueueRows = 0; changeDetails = @() }
Remove-StaleManagedExchangeContacts @($shadowManagedContact) $shadowProtectionRows $shadowProtectionStats
Assert-True (-not $script:removeCalled) "A stale managed contact owned by a skipped group-shadow placeholder must be preserved, never deleted"
Assert-Equal 1 $shadowProtectionStats.preservedInvalidContacts "A preserved group-shadow placeholder contact must be included in the preservation count"
Assert-Equal 0 $shadowProtectionStats.removedContacts "Group-shadow placeholder preservation must report zero removals"

$fullDuplicateOwnerRows = Build-ExchangeRows @(
  [pscustomobject]@{ id = "full-duplicate-old"; source_book = "FCUNO"; display_name = "Full Duplicate Old"; primary_email = "full.duplicate@example.com"; nickname = "FULL DUPLICATE OLD"; first_name = ""; last_name = ""; updated_at = "2026-07-21T02:00:00Z" },
  [pscustomobject]@{ id = "full-duplicate-new"; source_book = "FCUNO"; display_name = "Full Duplicate New"; primary_email = "full.duplicate@example.com"; nickname = "FULL DUPLICATE NEW"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
) @() @()
$validDuplicateOwnerContact = [pscustomobject]@{
  Identity = "valid-duplicate-owner"
  Guid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  Name = "Full Duplicate Old"
  DisplayName = "Full Duplicate Old"
  ExternalEmailAddress = "full.duplicate@example.com"
  Alias = "full-duplicate-old"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_CONTACT:full-duplicate-old"
}
$script:removeCalled = $false
$validDuplicateOwnerStats = @{ removedContacts = 0; preservedInvalidContacts = 0; failedQueueRows = 0; changeDetails = @() }
Remove-StaleManagedExchangeContacts @($validDuplicateOwnerContact) $fullDuplicateOwnerRows $validDuplicateOwnerStats | Out-Null
Assert-True (-not $script:removeCalled) "Full cleanup must preserve a managed contact owned by any still-valid duplicate source row"
Assert-Equal 0 $validDuplicateOwnerStats.removedContacts "A valid duplicate source owner must not be counted as stale"

$obsoleteReusedEmailContact = [pscustomobject]@{
  Identity = "obsolete-reused-email-owner"
  Guid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  Name = "Obsolete Reused Email Owner"
  DisplayName = "Obsolete Reused Email Owner"
  ExternalEmailAddress = "full.duplicate@example.com"
  Alias = "obsolete-reused-email-owner"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_CONTACT:obsolete-reused-email-owner"
}
$script:removeCalled = $false
$obsoleteReusedEmailStats = @{ removedContacts = 0; preservedInvalidContacts = 0; failedQueueRows = 0; changeDetails = @() }
Remove-StaleManagedExchangeContacts @($obsoleteReusedEmailContact) $fullDuplicateOwnerRows $obsoleteReusedEmailStats | Out-Null
Assert-True $script:removeCalled "Full cleanup must remove a stale foreign source owner even when a current FCUNO contact reuses its email"
Assert-Equal 1 $obsoleteReusedEmailStats.removedContacts "A verified stale reused-email owner deletion must be counted exactly once"
Assert-True (@($obsoleteReusedEmailStats.changeDetails[0].fieldChanges) -contains "Name: Obsolete Reused Email Owner -> (missing)") "A stale-contact deletion notice must report the exact Exchange Name"

$fullStaleGroupRows = Build-ExchangeRows @(
  [pscustomobject]@{ id = "full-stale-group-member"; source_book = "FCUNO"; display_name = "Full Stale Group Member"; primary_email = "full.stale.group.member@example.com"; nickname = "FULL STALE GROUP MEMBER"; first_name = ""; last_name = ""; updated_at = "2026-07-22T02:00:00Z" }
) @(
  [pscustomobject]@{ id = "full-current-group"; source_book = "FCUNO"; name = "FULL CURRENT GROUP"; nickname = "FULL CURRENT GROUP"; source_uid = "full-current-group"; description = "Current" }
) @(
  [pscustomobject]@{ group_id = "full-current-group"; contact_id = "full-stale-group-member"; source_book = "FCUNO" }
)
$desiredFullGroup = $fullStaleGroupRows.GroupById["full-current-group"]
$obsoleteReusedAliasGroup = [pscustomobject]@{
  Identity = "obsolete-reused-alias-group"
  Guid = "ffffffff-ffff-4fff-8fff-ffffffffffff"
  Name = "Obsolete Reused Alias Group"
  DisplayName = "FULL CURRENT GROUP"
  Alias = $desiredFullGroup.Alias
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_GROUP:obsolete-reused-alias-group"
}
$script:recreatedGroupRemoved = $false
$obsoleteReusedAliasStats = @{ removedGroups = 0; failedQueueRows = 0; changeDetails = @() }
Remove-StaleManagedExchangeGroups @($obsoleteReusedAliasGroup) $fullStaleGroupRows $obsoleteReusedAliasStats | Out-Null
Assert-True $script:recreatedGroupRemoved "Full cleanup must remove a stale managed group owner even when a current FCUNO group reuses its alias"
Assert-Equal 1 $obsoleteReusedAliasStats.removedGroups "A verified stale reused-alias group deletion must be counted exactly once"
Assert-True (@($obsoleteReusedAliasStats.changeDetails[0].fieldChanges) -contains "Name: Obsolete Reused Alias Group -> (missing)") "A stale-group deletion notice must report its exact Exchange Name separately"
Assert-True (@($obsoleteReusedAliasStats.changeDetails[0].fieldChanges) -contains "Group name: FULL CURRENT GROUP -> (missing)") "A stale-group deletion notice must preserve the visible DisplayName separately"

$legacyDesiredAliasGroup = [pscustomobject]@{
  Identity = "legacy-desired-alias-group"
  Guid = "abababab-abab-4bab-8bab-abababababab"
  Name = "FULL CURRENT GROUP"
  DisplayName = "FULL CURRENT GROUP"
  Alias = $desiredFullGroup.Alias
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = ""
}
$script:recreatedGroupRemoved = $false
$legacyDesiredAliasStats = @{ removedGroups = 0; failedQueueRows = 0; changeDetails = @() }
Remove-StaleManagedExchangeGroups @($legacyDesiredAliasGroup) $fullStaleGroupRows $legacyDesiredAliasStats | Out-Null
Assert-True (-not $script:recreatedGroupRemoved) "A legacy managed group with no source key must be preserved by an exact desired alias for safe in-place adoption"
Assert-Equal 0 $legacyDesiredAliasStats.removedGroups "A preserved legacy desired-alias group must not be counted as stale"

$fullSyncFunctionText = (Get-Item Function:Invoke-FullExchangeSync).ScriptBlock.ToString()
$fullPreCleanupSnapshotIndex = $fullSyncFunctionText.IndexOf('Pre-cleanup managed contact snapshot')
$fullStaleContactCleanupIndex = $fullSyncFunctionText.IndexOf('Remove-StaleManagedExchangeContacts $preCleanupManagedContacts')
$fullDirectoryPrerequisiteIndex = $fullSyncFunctionText.IndexOf('Sync-ExchangeGroupDirectoryNamePrerequisites $exchangeRows')
$fullFreshRecipientSnapshotIndex = $fullSyncFunctionText.IndexOf('Managed contact projection snapshot')
$fullDesiredContactLoopIndex = $fullSyncFunctionText.IndexOf('$contactPosition = 0')
Assert-True ($fullPreCleanupSnapshotIndex -ge 0) "Full sync must take the managed-recipient cleanup snapshot"
Assert-True ($fullPreCleanupSnapshotIndex -lt $fullStaleContactCleanupIndex) "Full sync must snapshot before exact stale cleanup"
Assert-True ($fullStaleContactCleanupIndex -lt $fullDirectoryPrerequisiteIndex) "Full sync must delete verified stale recipients before collision-safe directory prerequisites"
Assert-True ($fullDirectoryPrerequisiteIndex -lt $fullFreshRecipientSnapshotIndex) "Full sync must finish directory and alias prepasses before taking lookup snapshots"
Assert-True ($fullFreshRecipientSnapshotIndex -lt $fullDesiredContactLoopIndex) "Desired upserts must use a fresh post-prepass Exchange snapshot"
Assert-True ($fullSyncFunctionText.IndexOf('Final managed contact snapshot') -ge 0) "Final contact certification reads must use bounded temporary-error retry"
Assert-True ($fullSyncFunctionText.IndexOf('Final managed group snapshot') -ge 0) "Final group certification reads must use bounded temporary-error retry"

$desiredNoOpGroupMembers = @(
  [pscustomobject]@{ MemberEmail = "existing@example.com" },
  [pscustomobject]@{ MemberEmail = "missing@example.com" }
)

$savedGetContactExchangeRowFromSource = (Get-Item Function:Get-ContactExchangeRowFromSource).ScriptBlock
$savedSyncExchangeAliasPeers = (Get-Item Function:Sync-ExchangeAliasPeers).ScriptBlock
$savedSyncExchangeDirectoryNamePeers = (Get-Item Function:Sync-ExchangeDirectoryNamePeers).ScriptBlock
$savedUpsertExchangeMailContact = (Get-Item Function:Upsert-ExchangeMailContact).ScriptBlock
$savedGetManagedExchangeMailContactBySourceKey = (Get-Item Function:Get-ManagedExchangeMailContactBySourceKey).ScriptBlock
$script:memberPrerequisiteEvents = @()
function Get-ContactExchangeRowFromSource {
  param($SourceContactId)
  if ((Clean-Text $SourceContactId) -ne "c-external-member") { return $null }
  return [pscustomobject]@{
    SourceContactId = "c-external-member"
    SourceKey = "FCUNO_CONTACT:c-external-member"
    DisplayName = "External Member"
    BaseAlias = "external-member"
    Alias = "external-member"
    ExternalEmailAddress = "external-member@example.com"
    AllowedOwnerSourceKeys = @("FCUNO_CONTACT:c-external-member")
  }
}
function Sync-ExchangeAliasPeers {
  param($BaseAlias, [hashtable]$Stats, [bool]$SkipNoOpWrites = $false, [bool]$IncludeSinglePeer = $false)
  $script:memberPrerequisiteEvents += "alias:$BaseAlias"
}
function Sync-ExchangeDirectoryNamePeers {
  param($DisplayName, [hashtable]$Stats, $ExcludeSourceKey = "", [bool]$IncludeSinglePeer = $false)
  $script:memberPrerequisiteEvents += "name:$DisplayName"
}
function Upsert-ExchangeMailContact {
  param($Contact, [hashtable]$Stats, [bool]$SkipNoOpWrites = $false, $ExistingHint = $null, [bool]$UseExistingHint = $false, $ExistingProfileHint = $null)
  Assert-True $SkipNoOpWrites "A group-member prerequisite must avoid rewriting an already exact contact"
  $script:memberPrerequisiteEvents += "upsert:$($Contact.SourceKey)"
}
function Get-ManagedExchangeMailContactBySourceKey {
  param($SourceKey, $Email, $Label, [int]$MaxAttempts = 1)
  Assert-Equal "FCUNO_CONTACT:c-external-member" $SourceKey "Group-member lookup must use the canonical FCUNO source key"
  Assert-Equal "external-member@example.com" $Email "Group-member lookup must use the normalized canonical email"
  Assert-Equal 4 $MaxAttempts "Group-member lookup must allow bounded Exchange propagation"
  $script:memberPrerequisiteEvents += "resolve:$SourceKey"
  return [pscustomobject]@{ Guid = "12345678-1234-4234-8234-123456789abc" }
}
try {
  $resolvedMemberIdentity = Resolve-ExchangeGroupMemberCommandIdentity `
    ([pscustomobject]@{ MemberEmail = "external-member@example.com"; SourceContactId = "c-external-member" }) `
    @{}
  Assert-Equal "12345678-1234-4234-8234-123456789abc" $resolvedMemberIdentity "An external group member must use its immutable Exchange GUID"
  Assert-Equal `
    "alias:external-member,name:External Member,upsert:FCUNO_CONTACT:c-external-member,resolve:FCUNO_CONTACT:c-external-member" `
    ($script:memberPrerequisiteEvents -join ",") `
    "Incremental membership must settle and resolve the external contact before mutation"

  $groupMembershipFunctionText = (Get-Item Function:Sync-ExchangeGroupMembers).ScriptBlock.ToString()
  $fullMissingMemberBranchIndex = $groupMembershipFunctionText.IndexOf('if ($SkipNoOpWrites)')
  $fullMissingMemberResolveIndex = $groupMembershipFunctionText.IndexOf('Resolve-ExchangeGroupMemberCommandIdentity $desiredMemberRows[$email] $Stats')
  $memberAddIndex = $groupMembershipFunctionText.IndexOf('Add-DistributionGroupMember -Identity $groupIdentity -Member $memberIdentity')
  Assert-True ($fullMissingMemberResolveIndex -gt $fullMissingMemberBranchIndex) "Full reconciliation must resolve a missing external member after its initial no-op comparison"
  Assert-True ($fullMissingMemberResolveIndex -lt $memberAddIndex) "Full reconciliation must address a missing external member by settled immutable identity"
} finally {
  Set-Item Function:Get-ContactExchangeRowFromSource -Value $savedGetContactExchangeRowFromSource
  Set-Item Function:Sync-ExchangeAliasPeers -Value $savedSyncExchangeAliasPeers
  Set-Item Function:Sync-ExchangeDirectoryNamePeers -Value $savedSyncExchangeDirectoryNamePeers
  Set-Item Function:Upsert-ExchangeMailContact -Value $savedUpsertExchangeMailContact
  Set-Item Function:Get-ManagedExchangeMailContactBySourceKey -Value $savedGetManagedExchangeMailContactBySourceKey
}
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
$script:memberAddFailures = @()
$script:temporaryMemberReadFailuresRemaining = 0
function Get-DistributionGroupMember {
  [CmdletBinding()]
  param($Identity, $ResultSize)
  $script:getDistributionGroupMemberCalls += 1
  $script:memberReadGroupIdentities += (Clean-Text $Identity)
  if ($script:temporaryMemberReadFailuresRemaining -gt 0) {
    $script:temporaryMemberReadFailuresRemaining -= 1
    throw $temporaryExchangeMessage
  }
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
  if ($script:memberAddFailures -contains $email) { throw "Recipient '$email' could not be resolved in Exchange." }
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
  "missing@example.com" = $true
}
$script:getDistributionGroupMemberCalls = 0
$script:memberReadGroupIdentities = @()
$script:temporaryMemberReadFailuresRemaining = 1
Set-Item Function:Start-Sleep -Value { param($Seconds) }
try {
  Sync-ExchangeGroupMembers $desiredNoOpGroup $desiredNoOpGroupMembers @{} $true $script:noOpDistributionGroup $true $script:noOpGroupProfile
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
  $script:temporaryMemberReadFailuresRemaining = 0
}
Assert-Equal 2 $script:getDistributionGroupMemberCalls "A temporary membership read must recover inside the same reconciliation"
Assert-True (@($script:memberReadGroupIdentities | Where-Object { $_ -ne $script:noOpDistributionGroup.Guid }).Count -eq 0) "A retried membership read must retain the immutable Exchange group identity"

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

$independentFailureMembers = @(
  [pscustomobject]@{ MemberEmail = "thuy@cosulich.com.hk" },
  [pscustomobject]@{ MemberEmail = "bunker@cosulich.com.sg" }
)
$script:memberState = @{}
$script:memberAddFailures = @("bunker@cosulich.com.sg")
$script:attemptedMemberAdds = @()
$script:removedMemberEmails = @()
$script:getDistributionGroupMemberCalls = 0
$script:memberReadGroupIdentities = @()
$script:memberMutationGroupIdentities = @()
$independentFailureStats = @{ changeDetails = @() }
$independentFailureMessage = ""
Set-Item Function:Start-Sleep -Value { param($Seconds) }
try {
  try {
    Sync-ExchangeGroupMembers $desiredNoOpGroup $independentFailureMembers $independentFailureStats $true $script:noOpDistributionGroup $true $script:noOpGroupProfile
  } catch {
    $independentFailureMessage = Clean-Text $_.Exception.Message
  }
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
  $script:memberAddFailures = @()
}
Assert-Equal "bunker@cosulich.com.sg,thuy@cosulich.com.hk" ($script:attemptedMemberAdds -join ",") "Missing desired members must be attempted in deterministic email order"
Assert-True (Has-MapKey $script:memberState "thuy@cosulich.com.hk") "A failed first recipient must not block a later valid member add"
Assert-Equal 1 $independentFailureStats.addedMembers "Only the independently successful member add must be counted"
Assert-True (@($script:memberMutationGroupIdentities | Where-Object { $_ -ne $script:noOpDistributionGroup.Guid }).Count -eq 0) "Every independent member attempt must use the immutable group identity"
Assert-True (@($script:memberReadGroupIdentities | Where-Object { $_ -ne $script:noOpDistributionGroup.Guid }).Count -eq 0) "Initial and bounded final membership reads must use the immutable group identity"
Assert-True ($independentFailureMessage -match "mutation errors: add bunker@cosulich.com.sg failed: Recipient 'bunker@cosulich.com.sg' could not be resolved in Exchange") "The aggregate must retain the exact per-recipient mutation error"
Assert-True ($independentFailureMessage -match "missing after verification retries: bunker@cosulich.com.sg") "Final certification must still fail closed for the unresolved desired member"
$independentPartialRows = @($independentFailureStats.changeDetails | Where-Object { $_.actionLabel -eq "Add group member" })
Assert-Equal 1 $independentPartialRows.Count "The independently successful member add must retain one partial mutation detail"
Assert-Equal "failed" $independentPartialRows[0].status "A successful member mutation in an uncertified group must be published as failed/partial"
Assert-True (@($independentPartialRows[0].fieldChanges) -contains "Member: (absent) -> thuy@cosulich.com.hk") "The partial detail must identify the exact successful member mutation"

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
Set-Item Function:Start-Sleep -Value { param($Seconds) }
try {
  Sync-ExchangeGroupMembers $desiredNoOpGroup @() @{} $true $script:noOpDistributionGroup $true $script:noOpGroupProfile
} catch {
  $unprovableMemberRemovalFailedClosed = $_.Exception.Message -match "immutable or unique SMTP identity could not be proven"
} finally {
  Remove-Item Function:Start-Sleep -ErrorAction SilentlyContinue
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
$savedResolveExchangeGroupMemberCommandIdentity = (Get-Item Function:Resolve-ExchangeGroupMemberCommandIdentity).ScriptBlock
$script:resolvedIncrementalMemberEmails = @()
function Resolve-ExchangeGroupMemberCommandIdentity {
  param($Member, [hashtable]$Stats)
  $email = Normalize-Email $Member.MemberEmail
  $script:resolvedIncrementalMemberEmails += $email
  return $email
}
try {
  Sync-ExchangeGroupMembers $desiredNoOpGroup $desiredNoOpGroupMembers $incrementalMemberStats
} finally {
  Set-Item Function:Resolve-ExchangeGroupMemberCommandIdentity -Value $savedResolveExchangeGroupMemberCommandIdentity
}
Assert-Equal 2 $script:getDistributionGroupMemberCalls "Incremental membership processing must retain its live cleanup and verification reads"
Assert-Equal 2 @($script:attemptedMemberAdds).Count "Incremental membership processing must retain its current add-attempt behavior"
Assert-Equal "existing@example.com,missing@example.com" ($script:resolvedIncrementalMemberEmails -join ",") "Incremental membership must resolve every desired recipient through the hardened command-identity path"
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
