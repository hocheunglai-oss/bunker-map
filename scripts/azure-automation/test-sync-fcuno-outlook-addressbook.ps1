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
function Get-MailContact {
  [CmdletBinding()]
  param($Filter, $ResultSize, $Identity)
  $script:getMailContactCalls += 1
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_CONTACT:c-unchanged'" -or $Filter -like "ExternalEmailAddress -eq 'unchanged@example.com'") {
    return $script:noOpMailContact
  }
  return $null
}
function Get-Contact {
  [CmdletBinding()]
  param($Identity)
  if ($Identity -eq "unchanged-contact") { return $script:noOpContactProfile }
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

$incrementalContactStats = @{}
Upsert-ExchangeMailContact $desiredNoOpContact $incrementalContactStats
Assert-Equal 3 $script:getMailContactCalls "Incremental contact processing must check both immutable ownership candidates and verify the result"
Assert-Equal 1 $script:setMailContactCalls "Incremental contact processing must retain its existing upsert behavior"
Assert-Equal 1 $script:setContactCalls "Incremental contact processing must retain its existing profile update behavior"
Assert-Equal 1 $incrementalContactStats.updatedContacts "Incremental contact processing must still report its update"

$desiredNoOpGroup = [pscustomobject]@{
  SourceGroupId = "g-unchanged"
  GroupName = "Unchanged Group"
  Alias = "unchanged-group"
  Description = "Current description"
  SourceKey = "FCUNO_GROUP:g-unchanged"
}
$script:noOpDistributionGroup = [pscustomobject]@{
  Identity = "unchanged-group"
  Name = "Unchanged Group"
  DisplayName = "Unchanged Group"
  Alias = "unchanged-group"
  Notes = "Current description"
  CustomAttribute1 = $ManagedMarker
  CustomAttribute2 = "FCUNO_GROUP:g-unchanged"
  HiddenFromAddressListsEnabled = $false
}
$script:getDistributionGroupCalls = 0
$script:setDistributionGroupCalls = 0
$script:setGroupCalls = 0
$script:newDistributionGroupCalls = 0
$script:newDistributionGroup = $null
function Get-DistributionGroup {
  [CmdletBinding()]
  param($Filter, $ResultSize, $Identity)
  $script:getDistributionGroupCalls += 1
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_GROUP:g-unchanged'" -or $Identity -eq "unchanged-group") {
    return $script:noOpDistributionGroup
  }
  if ($Filter -like "CustomAttribute2 -eq 'FCUNO_GROUP:g-new'" -and $script:newDistributionGroup) {
    return $script:newDistributionGroup
  }
  return $null
}
function Set-DistributionGroup {
  [CmdletBinding()]
  param($Identity, $Alias, $Name, $DisplayName, $Notes, $CustomAttribute1, $CustomAttribute2, $HiddenFromAddressListsEnabled)
  $script:setDistributionGroupCalls += 1
  if ($Identity -eq "new-group") {
    $script:newDistributionGroup.CustomAttribute1 = $CustomAttribute1
    $script:newDistributionGroup.CustomAttribute2 = $CustomAttribute2
    $script:newDistributionGroup.HiddenFromAddressListsEnabled = [bool]$HiddenFromAddressListsEnabled
  }
}
function Set-Group {
  [CmdletBinding()]
  param($Identity, $Notes)
  $script:setGroupCalls += 1
  if ($Identity -eq "new-group") { $script:newDistributionGroup.Notes = $Notes }
}
function New-DistributionGroup {
  [CmdletBinding()]
  param($Name, $Alias)
  if ($Alias -eq "new-group") {
    $script:newDistributionGroupCalls += 1
    $script:newDistributionGroup = [pscustomobject]@{
      Identity = "new-group"
      Name = $Name
      DisplayName = $Name
      Alias = $Alias
      Notes = ""
      CustomAttribute1 = ""
      CustomAttribute2 = ""
      HiddenFromAddressListsEnabled = $false
    }
    return $script:newDistributionGroup
  }
  throw "New-DistributionGroup must not be called for an existing no-op group."
}

$fullNoOpGroupStats = @{}
Upsert-ExchangeDistributionGroup $desiredNoOpGroup $fullNoOpGroupStats $true $script:noOpDistributionGroup $true
Assert-Equal 0 $script:getDistributionGroupCalls "Full reconciliation must use its collision-checked group hint without a per-group read"
Assert-Equal 0 $script:setDistributionGroupCalls "Full reconciliation must not rewrite an unchanged distribution group"
Assert-Equal 0 $script:setGroupCalls "Full reconciliation must not rewrite unchanged group notes"
Assert-Equal 1 $fullNoOpGroupStats.verifiedQueueRows "A skipped no-op group must still complete exact verification"

$changedDescriptionGroup = [pscustomobject]@{
  GroupName = "Unchanged Group"
  Alias = "unchanged-group"
  Description = "Changed description"
  SourceKey = "FCUNO_GROUP:g-unchanged"
}
Assert-True (-not (Test-ExchangeDistributionGroupMatches $script:noOpDistributionGroup $changedDescriptionGroup)) "A changed group description must not be treated as a no-op"

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

$incrementalGroupStats = @{}
Upsert-ExchangeDistributionGroup $desiredNoOpGroup $incrementalGroupStats
Assert-Equal 2 $script:getDistributionGroupCalls "Incremental group processing must retain its live lookup and verification reads"
Assert-Equal 1 $script:setDistributionGroupCalls "Incremental group processing must retain its existing upsert behavior"
Assert-Equal 1 $script:setGroupCalls "Incremental group processing must update Notes through Set-Group"
Assert-Equal 1 $incrementalGroupStats.updatedGroups "Incremental group processing must still report its update"

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
Assert-Equal "New group notes" $script:newDistributionGroup.Notes "A new distribution group must receive Notes through Set-Group"
Assert-Equal 1 $newGroupStats.createdGroups "A new distribution group must be reported as created"

$finalProjectionRows = @{
  Contacts = @($desiredNoOpContact)
  Groups = @($desiredNoOpGroup)
  Members = @()
}
$exactFinalStats = @{ failedQueueRows = 0; changeDetails = @() }
Confirm-FinalExchangeProjection $finalProjectionRows @($script:noOpMailContact) @($script:noOpContactProfile) @($script:noOpDistributionGroup) $exactFinalStats
Assert-Equal 0 $exactFinalStats.failedQueueRows "Fresh final certification must accept exact contact, profile, and group metadata"

$script:noOpContactProfile.FirstName = "Stale First Name"
$driftedFinalStats = @{ failedQueueRows = 0; changeDetails = @() }
Confirm-FinalExchangeProjection $finalProjectionRows @($script:noOpMailContact) @($script:noOpContactProfile) @($script:noOpDistributionGroup) $driftedFinalStats
Assert-True ([int]$driftedFinalStats.failedQueueRows -gt 0) "Fresh final certification must reject a drifted authoritative contact profile"
Assert-True ((@($driftedFinalStats.changeDetails | ForEach-Object { $_.result }) -join " ") -match "first name") "Fresh final certification must identify the drifted profile field"
$script:noOpContactProfile.FirstName = "Unchanged"

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
$script:getDistributionGroupMemberCalls = 0
function Get-DistributionGroupMember {
  [CmdletBinding()]
  param($Identity, $ResultSize)
  $script:getDistributionGroupMemberCalls += 1
  return @($script:memberState.Keys | Sort-Object | ForEach-Object {
    [pscustomobject]@{ Identity = $_; ExternalEmailAddress = $_ }
  })
}
function Add-DistributionGroupMember {
  [CmdletBinding()]
  param($Identity, $Member)
  $email = Normalize-Email $Member
  $script:attemptedMemberAdds += $email
  if (Has-MapKey $script:memberState $email) { throw "$email is already a member" }
  $script:memberState[$email] = $true
}
function Remove-DistributionGroupMember {
  [CmdletBinding(SupportsShouldProcess)]
  param($Identity, $Member)
  $email = Normalize-Email $Member
  $script:removedMemberEmails += $email
  $script:memberState.Remove($email)
}

$script:memberState = @{
  "existing@example.com" = $true
  "missing@example.com" = $true
}
$fullExactMemberStats = @{}
Sync-ExchangeGroupMembers $desiredNoOpGroup $desiredNoOpGroupMembers $fullExactMemberStats $true $script:noOpDistributionGroup $true
Assert-Equal 1 $script:getDistributionGroupMemberCalls "An exact full-sync membership snapshot must be accepted without a second read"
Assert-Equal 0 @($script:attemptedMemberAdds).Count "An exact full-sync membership snapshot must not attempt any member add"
Assert-Equal 0 @($script:removedMemberEmails).Count "An exact full-sync membership snapshot must not attempt any member removal"

$script:memberState = @{
  "existing@example.com" = $true
  "unexpected@example.com" = $true
}
$script:attemptedMemberAdds = @()
$script:removedMemberEmails = @()
$script:getDistributionGroupMemberCalls = 0
$fullMemberStats = @{}
Sync-ExchangeGroupMembers $desiredNoOpGroup $desiredNoOpGroupMembers $fullMemberStats $true $script:noOpDistributionGroup $true
Assert-Equal 2 $script:getDistributionGroupMemberCalls "A changed full-sync membership must be read initially and verified after mutation"
Assert-Equal 1 @($script:attemptedMemberAdds).Count "Full reconciliation must add only missing group members"
Assert-Equal "missing@example.com" $script:attemptedMemberAdds[0] "Full reconciliation must not re-add an existing member"
Assert-Equal 1 $fullMemberStats.addedMembers "Only the missing member must be counted as added"
Assert-Equal "unexpected@example.com" $script:removedMemberEmails[0] "Unexpected members must still be removed"

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

Write-Output "Exchange address book runbook tests passed."
