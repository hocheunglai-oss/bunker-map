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
function Get-MailContact {
  [CmdletBinding()]
  param($Filter, $ResultSize, $Identity)
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

Write-Output "Exchange address book runbook tests passed."
