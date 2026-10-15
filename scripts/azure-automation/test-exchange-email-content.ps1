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

# Every external boundary is replaced locally; this file cannot send live mail.
function Invoke-RestMethod { throw "TEST GUARD: unexpected network request" }
function Invoke-WebRequest { throw "TEST GUARD: unexpected network request" }
function Invoke-SupabaseRest { throw "TEST GUARD: unexpected database access" }
$script:Settings = @{}
function Get-AutomationVariable {
  [CmdletBinding()]
  param([string]$Name)
  return $script:Settings[$Name]
}
$script:SentMail = New-Object System.Collections.ArrayList
$script:ThrowSmtp = $false
function Send-ExchangeSmtpMail($From, $To, $Subject, $Html) {
  [void]$script:SentMail.Add([pscustomobject]@{ From = $From; To = @($To); Subject = $Subject; Html = $Html })
  if ($script:ThrowSmtp) { throw "Mock transport error: retained only in the delivery receipt." }
  return $true
}

$testUrl = "https://mail-test.invalid/admin/outlookaddressbook"
$technicalMarker = "DO_NOT_EMAIL_INTERNAL_DETAILS"
$technicalId = "11111111-1111-4111-8111-111111111111"
$technicalHash = "a" * 64
$webhook = @{
  requestedBy = $technicalMarker
  requestedByEmail = "requester@example.com"
  requestedAt = "2026-10-07T02:31:00Z"
}
$details = @{
  notificationIssueKind = "contact_correction"
  notificationAddressBookUrl = $testUrl
  syncMode = "incremental"
  queuedRows = 17
  processedQueueRows = 15
  completedQueueRows = 12
  failedQueueRows = 3
  backlogRows = 3
  skippedQueueRows = 2
  runId = $technicalId
  truthLedgerHeadSequence = 7520
  truthLedgerHeadHash = $technicalHash
  truthLedgerCheckpointVerified = $true
  currentProjectionCertified = $true
  latestCertificationRunId = $technicalId
  sourceSnapshotHash = $technicalHash
  notificationError = $technicalMarker
  changeDetails = @(
    @{ status = "failed"; entityType = "contact"; displayName = 'ACME <script>alert("x")</script> & Partners'; queueRowId = $technicalId; result = $technicalMarker; errorHistory = @($technicalMarker); fieldChanges = @($technicalMarker) }
    @{ status = "failed"; entityType = "group"; displayName = "Asia Group"; identifier = $technicalMarker }
    @{ status = "completed"; entityType = "contact"; displayName = "Already Updated" }
    @{ status = "superseded"; entityType = "contact"; displayName = "Resolved Old Save" }
    @{ status = "skipped"; entityType = "contact"; displayName = "Another Resolved Save"; supersededByFullRunId = $technicalId }
  )
}

$content = Get-ExchangeSyncEmailContent "failed" $technicalMarker $details $webhook
Assert-Equal "FC Uno address book - needs attention" $content.Subject "The subject must describe an actionable situation without alarmist counters"
Assert-True ($content.Html -match "Some contact or group details could not be updated in Outlook") "Contact issues must be described in ordinary language"
Assert-True ($content.Html -match "Please review the affected entries") "The email must say what to do"
Assert-True ($content.Html -match 'ACME &lt;script&gt;alert\(&quot;x&quot;\)&lt;/script&gt; &amp; Partners') "Contact names must be escaped as text"
Assert-True ($content.Html -notmatch "<script>") "Contact names must never become executable markup"
Assert-True ($content.Html -match "Asia Group") "Real affected groups must be named"
Assert-True ($content.Html -notmatch "Already Updated|Resolved Old Save|Another Resolved Save") "Resolved changes must not be listed as affected"
Assert-Equal 1 ([regex]::Matches($content.Html, "<a ").Count) "The email must contain exactly one link"
Assert-True ($content.Html.Contains('href="' + $testUrl + '"')) "The single action must link to the supplied verified address-book URL"
Assert-True ($content.Html -notmatch "<table|<th|<td") "No technical table or counter tiles may remain"
Assert-True ($content.Html.Length -lt 2200) "A short alert must remain compact"
foreach ($forbidden in @(
  $technicalMarker, $technicalId, $technicalHash, "7520", "Requested by",
  "Requested at", "SHA-256", "checkpoint", "ledger", "Immutable", "runId",
  "processed", "backlog", "Connect-ExchangeOnline", "failed", "deleted",
  "recreate", "templates are unaffected", "data is safe"
)) {
  Assert-True (-not ($content.Subject + $content.Html + $content.Text).Contains($forbidden)) "Technical or unsupported content must remain out of the email: $forbidden"
}

# A large list cannot become a long email, and duplicate names are collapsed.
$manyDetails = @{
  notificationIssueKind = "sync_delayed"
  notificationAddressBookUrl = $testUrl
  notificationAffectedNames = @("First entry", "FIRST ENTRY", ("Second " + ("z" * 250)), "Third entry", "Fourth entry") + @(1..100 | ForEach-Object { "Extra $_" })
}
$compact = Get-ExchangeSyncEmailContent "failed" $technicalMarker $manyDetails $webhook
Assert-Equal 3 ([regex]::Matches($compact.Html, "<li ").Count) "Only three affected entries may be shown"
Assert-True ($compact.Html -notmatch "Fourth entry|Extra 1") "Further names belong on the linked page"
Assert-True ($compact.Html -match "remaining entries") "A shortened list must not pretend to be complete"
Assert-True ($compact.Html -notmatch ("z" * 81)) "Long names must be bounded"
Assert-True ($compact.Html -match "\.\.\.") "Truncated names must be visibly shortened"
Assert-Equal 1 ([regex]::Matches($compact.Html, "First entry").Count) "Case-insensitive duplicates must be collapsed"
Assert-True ($compact.Html.Length -lt 2400) "Even a hundred affected entries must produce a short email"

# The notification policy may deliberately pass an empty names list rather than
# expose unrelated rows from the full run.
$explicitEmpty = @{
  notificationAddressBookUrl = $testUrl
  notificationIssueKind = "service_access"
  notificationAffectedNames = @()
  changeDetails = $details.changeDetails
}
$emptyContent = Get-ExchangeSyncEmailContent "failed" $technicalMarker $explicitEmpty $webhook
Assert-True ($emptyContent.Html -notmatch "Affected entries|Asia Group") "An explicitly empty eligible list must override fallback run details"

$invalidNames = @{
  notificationAddressBookUrl = $testUrl
  notificationIssueKind = "sync_issue"
  notificationAffectedNames = @($null, "", "Unknown item", $technicalId, $technicalHash, "FCUNO_CONTACT:opaque", @{ not = "a name" }, "Actual contact")
}
$namesContent = Get-ExchangeSyncEmailContent "failed" $technicalMarker $invalidNames $webhook
Assert-Equal 1 ([regex]::Matches($namesContent.Html, "<li ").Count) "Identifiers and placeholders must not replace real names"
Assert-True ($namesContent.Html -match "Actual contact") "Valid names must survive identifier filtering"

$categoryCases = @(
  @{ Kind = "contact_correction"; Summary = "Some contact or group details could not be updated in Outlook."; Action = "Please review the affected entries"; Subject = "needs attention" }
  @{ Kind = "sync_delayed"; Summary = "Address book updates are taking longer than expected."; Action = "check the delay"; Subject = "updates delayed" }
  @{ Kind = "service_access"; Summary = "FC Uno cannot currently connect to Outlook"; Action = "restore the connection"; Subject = "needs attention" }
  @{ Kind = "verification"; Summary = "FC Uno could not complete its address book check."; Action = "review the latest sync"; Subject = "needs attention" }
  @{ Kind = "sync_issue"; Summary = "FC Uno could not complete the address book update."; Action = "check the sync"; Subject = "needs attention" }
  @{ Kind = "unrecognised_category"; Summary = "FC Uno could not complete the address book update."; Action = "check the sync"; Subject = "needs attention" }
)
foreach ($case in $categoryCases) {
  $rendered = Get-ExchangeSyncEmailContent "failed" $technicalMarker @{
    notificationAddressBookUrl = $testUrl
    notificationIssueKind = $case.Kind
  } $webhook
  Assert-True ($rendered.Html.Contains($case.Summary)) "Every category must have clear plain-language summary: $($case.Kind)"
  Assert-True ($rendered.Html.Contains($case.Action)) "Every category must state the next action: $($case.Kind)"
  Assert-True ($rendered.Subject.Contains($case.Subject)) "Category subject must be calm and informative: $($case.Kind)"
}

$recoveryDetails = @{ notificationAddressBookUrl = $testUrl; notificationIssueKind = "recovery"; changeDetails = $details.changeDetails }
$recovered = Get-ExchangeSyncEmailContent "completed" $technicalMarker $recoveryDetails $webhook
Assert-True ($recovered.Subject -match "working again") "A confirmed recovery must use a recovery subject"
Assert-True ($recovered.Html -match "No action is needed") "Recovery notices must not ask the team to investigate"
Assert-True ($recovered.Html -notmatch "Affected entries|Asia Group|data is safe|templates") "A recovery notice must not recycle stale names or promise unrelated safety"

$notRecovered = Get-ExchangeSyncEmailContent "failed" $technicalMarker $recoveryDetails $webhook
Assert-True ($notRecovered.Html -notmatch "No action is needed|working again|sync restored") "An unsuccessful run cannot be rendered as recovered"
$recoveryDetails.failedQueueRows = 1
$stillOutstanding = Get-ExchangeSyncEmailContent "completed" $technicalMarker $recoveryDetails $webhook
Assert-True ($stillOutstanding.Html -notmatch "No action is needed|working again|sync restored") "Outstanding failures cannot be rendered as recovered"

foreach ($badUrl in @("", "http://mail-test.invalid/admin/outlookaddressbook", "javascript:alert(1)", "https://mail-test.invalid/other", "https://user:pass@mail-test.invalid/admin/outlookaddressbook", "https://mail-test.invalid/admin/outlookaddressbook?error=secret")) {
  $caught = $false
  try {
    Get-ExchangeSyncEmailContent "failed" "" @{ notificationAddressBookUrl = $badUrl } @{} | Out-Null
  } catch { $caught = $true }
  Assert-True $caught "A missing or unsafe action URL must fail before preparing an email"
}

# Existing recipient selection and delivery receipts are preserved.
$script:Settings = @{
  EXCHANGE_SYNC_NOTIFY_EMAILS = "team@example.com; TEAM@example.com, second@example.com invalid"
  EMAIL_NOTICE_FROM = "FC Uno Notices <notice@example.com>"
}
$delivery = Send-ExchangeSyncNotification "failed" $technicalMarker $details $webhook
Assert-Equal "delivered" $delivery.Status "Successful transport must still produce a delivered receipt"
Assert-True ($delivery.Attempted -and $delivery.Delivered) "Successful transport must retain both true delivery flags"
Assert-Equal 3 $delivery.RecipientCount "Configured and requester recipients must still be deduplicated"
Assert-True ([bool]$delivery.DeliveredAt) "Successful transport must preserve its UTC receipt timestamp"
Assert-Equal "" $delivery.Error "Successful delivery must not claim an error"
Assert-Equal 1 $script:SentMail.Count "Exactly one SMTP call must be made"
Assert-Equal "FC Uno Notices <notice@example.com>" $script:SentMail[0].From "Sender selection must remain unchanged"
Assert-Equal "team@example.com,second@example.com,requester@example.com" ($script:SentMail[0].To -join ",") "Recipient selection must remain unchanged"
Assert-Equal $content.Subject $script:SentMail[0].Subject "The transport must use the minimal subject"
Assert-Equal $content.Html $script:SentMail[0].Html "The transport must use the minimal body"

$script:ThrowSmtp = $true
$failure = Send-ExchangeSyncNotification "failed" $technicalMarker $details $webhook 3> $null
Assert-Equal "failed" $failure.Status "Transport failures must still produce failed delivery receipts"
Assert-True ($failure.Attempted -and -not $failure.Delivered) "Transport failure must not be labelled delivered"
Assert-Equal 3 $failure.RecipientCount "Transport failure must retain intended recipient count"
Assert-Equal "" $failure.DeliveredAt "Transport failure must not invent a delivery timestamp"
Assert-True ($failure.Error -match "Mock transport error") "Transport diagnostics must remain in the internal receipt"

$script:Settings = @{}
$countBeforeNoRecipients = $script:SentMail.Count
$noRecipients = Send-ExchangeSyncNotification "failed" $technicalMarker @{} @{}
Assert-Equal "no_recipients" $noRecipients.Status "Absent recipients must remain an explicit receipt"
Assert-True (-not $noRecipients.Attempted -and -not $noRecipients.Delivered) "No-recipient notices must not call SMTP"
Assert-Equal 0 $noRecipients.RecipientCount "No-recipient receipt must retain zero recipients"
Assert-Equal $countBeforeNoRecipients $script:SentMail.Count "No recipients must avoid preparing or sending an email"

Write-Output "Exchange minimal email content tests passed."
