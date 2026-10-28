param([string]$CheckerPath = (Join-Path $PSScriptRoot 'check-fcuno-outlook-addressbook.ps1'))

# Offline, invented fixtures only. The Node entrypoint also guards all external
# commands before this file is loaded. Never substitute production exports.
$ErrorActionPreference = 'Stop'
. $CheckerPath -LibraryOnly
$script:ProductionCurrentHelpers=@{}
Get-ChildItem Function: | Where-Object { $_.Name -like '*Current*' } | ForEach-Object { $script:ProductionCurrentHelpers[$_.Name]=$_.ScriptBlock }
$script:CaseResults = [System.Collections.Generic.List[object]]::new()
$script:AssertionCount = 0
function Assert-True([bool]$Condition, [string]$Message) {
  $script:AssertionCount++
  if (-not $Condition) { throw "FAILED: $Message" }
}
function Assert-Equal($Expected, $Actual, [string]$Message) {
  Assert-True ([string]$Expected -ceq [string]$Actual) "$Message (expected '$Expected'; got '$Actual')"
}
function Assert-Throws([scriptblock]$Action, [string]$Message) {
  $didThrow = $false
  try { & $Action | Out-Null } catch { $didThrow = $true }
  Assert-True $didThrow $Message
}
function Test-Case([string]$Name, [scriptblock]$Action) {
  try { & $Action } catch { throw "Synthetic case '$Name' failed: $($_.Exception.Message)" }
  $script:CaseResults.Add([pscustomobject]@{ name=$Name; passed=$true })
}
function Copy-Fixture($Value) {
  return ($Value | ConvertTo-Json -Depth 30 -Compress | ConvertFrom-Json -AsHashtable -Depth 30)
}

# Project through the genuine selected worker helper: this fixture deliberately
# includes a duplicate source email and an empty source group. Their projection
# (one canonical external recipient; no empty Exchange group) must be retained.
$script:ExchangeAddressBookDomain = 'cosulich1.onmicrosoft.com'
$script:SyntheticContacts = @(
  [pscustomobject]@{ id='synthetic-a'; source_book='SYNTHETIC'; primary_email='ada@example.invalid'; display_name='Synthetic Ada'; nickname='SYNTHETIC ADA'; first_name='Ada'; last_name='Example'; updated_at='2026-10-28T00:00:00Z' },
  [pscustomobject]@{ id='synthetic-b'; source_book='SYNTHETIC'; primary_email='bert@example.invalid'; display_name='Synthetic Bert'; nickname='SYNTHETIC BERT'; first_name='Bert'; last_name='Example'; updated_at='2026-10-28T00:00:00Z' },
  [pscustomobject]@{ id='synthetic-a-older'; source_book='SYNTHETIC'; primary_email='ada@example.invalid'; display_name='Old Synthetic Ada'; nickname='OLD ADA'; first_name='Old'; last_name='Example'; updated_at='2026-10-27T00:00:00Z' },
  [pscustomobject]@{ id='synthetic-shadow'; source_book='SYNTHETIC'; primary_email='Synthetic Group'; display_name='Synthetic Group'; nickname='SYNTHETIC GROUP'; first_name=''; last_name=''; updated_at='2026-10-28T00:00:00Z' }
)
$script:SyntheticGroups = @(
  [pscustomobject]@{ id='synthetic-g'; source_book='SYNTHETIC'; name='Synthetic Group'; nickname='SYNTHETIC GROUP'; description='Invented members'; source_uid='synthetic-g' },
  [pscustomobject]@{ id='synthetic-empty'; source_book='SYNTHETIC'; name='Synthetic Empty'; nickname='SYNTHETIC EMPTY'; description='No members'; source_uid='synthetic-empty' }
)
$script:SyntheticMembers = @(
  [pscustomobject]@{ group_id='synthetic-g'; contact_id='synthetic-a-older'; source_book='SYNTHETIC' },
  [pscustomobject]@{ group_id='synthetic-g'; contact_id='synthetic-b'; source_book='SYNTHETIC' }
)
$script:Desired = Build-ExchangeRows $script:SyntheticContacts $script:SyntheticGroups $script:SyntheticMembers
Assert-Equal 2 @($script:Desired.Contacts).Count 'Fixture must exercise real duplicate-email projection'
Assert-Equal 1 @($script:Desired.Groups).Count 'Fixture must exercise real nonempty-group projection'
Assert-Equal 1 @($script:Desired.SkippedInvalidContacts).Count 'Retained-shadow negative must use a genuine worker-excluded raw source row'

function Reset-Fixture {
  $script:Scenario = 'match'
  $script:SourceReads=0; $script:OperationalReads=0; $script:InventoryCalls=@(); $script:MembershipCalls=0
  $script:MailContacts=@(); $script:ContactProfiles=@(); $script:DistributionGroups=@(); $script:GroupProfiles=@(); $script:LiveMembers=@()
  $position=0
  foreach ($contact in @($script:Desired.Contacts)) {
    $position++
    $guid=('{0:00000000}-0000-4000-8000-000000000000' -f $position)
    $mail=[pscustomobject]@{
      Guid=$guid; ExternalDirectoryObjectId="synthetic-directory-$position"; Identity=$guid; DistinguishedName="CN=Synthetic$position,DC=example,DC=invalid"
      Name=$contact.DirectoryName; DisplayName=$contact.DisplayName; Alias=$contact.Alias
      ExternalEmailAddress=$contact.ExternalEmailAddress; PrimarySmtpAddress=$contact.ExternalEmailAddress
      CustomAttribute1='FCUNO_SHARED_ADDRESSBOOK'; CustomAttribute2=$contact.SourceKey
      HiddenFromAddressListsEnabled=$false; RecipientTypeDetails='MailContact'
    }
    $script:MailContacts+=@($mail)
    $script:ContactProfiles+=@([pscustomobject]@{
      Guid=$guid; ExternalDirectoryObjectId=$mail.ExternalDirectoryObjectId; Identity=$guid; DistinguishedName=$mail.DistinguishedName
      Name=$contact.DirectoryName; DisplayName=$contact.DisplayName; FirstName=$contact.FirstName; LastName=$contact.LastName
    })
    $script:LiveMembers+=@((Copy-Fixture $mail))
  }
  foreach ($group in @($script:Desired.Groups)) {
    $guid='10000000-0000-4000-8000-000000000000'
    $script:DistributionGroups+=@([pscustomobject]@{
      Guid=$guid; ExternalDirectoryObjectId='synthetic-group-directory'; Identity=$guid; DistinguishedName='CN=SyntheticGroup,DC=example,DC=invalid'
      Name=$group.DirectoryName; DisplayName=$group.GroupName; Alias=$group.Alias; PrimarySmtpAddress=$group.SmtpAddress
      CustomAttribute1='FCUNO_SHARED_ADDRESSBOOK'; CustomAttribute2=$group.SourceKey; HiddenFromAddressListsEnabled=$false
    })
    $script:GroupProfiles+=@([pscustomobject]@{
      Guid=$guid; ExternalDirectoryObjectId='synthetic-group-directory'; Identity=$guid; DistinguishedName='CN=SyntheticGroup,DC=example,DC=invalid'; Notes=$group.Description
    })
  }
}
function Get-CurrentSourceSnapshot {
  $script:SourceReads++
  if ($script:Scenario -eq 'source-error') { throw 'PRIVATE-ERROR-SENTINEL provider-secret synthetic-person@example.invalid 99999999-0000-4000-8000-000000000000' }
  return @{
    Rows=$script:Desired; Fingerprint=$(if ($script:Scenario -eq 'projection-drift' -and $script:SourceReads -gt 1) {'b'*64} else {'a'*64})
    RawFingerprint=$(if ($script:Scenario -eq 'raw-drift' -and $script:SourceReads -gt 1) {'d'*64} else {'c'*64})
    Counts=@{contacts=4;groups=2;members=2}; Complete=($script:Scenario -ne 'source-incomplete')
    SourceValidationIssues=$(if($script:Scenario -eq 'source-validation-issue') {@('orphan_source_membership')} else {@()})
  }
}
function Get-CurrentOperationalState {
  $script:OperationalReads++
  if ($script:Scenario -eq 'queue-error') { throw 'Synthetic queue read failure' }
  return @{
    QueueWatermark=$(if ($script:Scenario -eq 'queue-drift' -and $script:OperationalReads -gt 1) {'43@2026-10-28T00:01:00Z'} else {'42@2026-10-28T00:00:00Z'})
    UnsettledCount=$(if ($script:Scenario -eq 'unsettled') {[long]1} else {[long]0})
    ActiveSync=($script:Scenario -eq 'active-sync'); Complete=($script:Scenario -ne 'queue-incomplete')
    LedgerHead=$(if ($script:Scenario -eq 'ledger-aba' -and $script:OperationalReads -gt 1) {'101@'+('b'*64)} else {'100@'+('a'*64)})
    LeaseFingerprint=$(if ($script:Scenario -eq 'lease-drift' -and $script:OperationalReads -gt 1) {'d'*64} else {'c'*64})
  }
}
function Get-CurrentExchangeInventory($Kind) {
  $script:InventoryCalls+=@($Kind)
  if ($script:Scenario -eq 'inventory-error') { Write-Output $script:MailContacts[0]; throw 'Synthetic failure after partial output' }
  if ($script:Scenario -eq 'deadline') { throw 'Current comparison deadline exceeded (synthetic)' }
  if ($script:Scenario -eq 'exchange-repeat-drift' -and @($script:InventoryCalls | Where-Object { $_ -eq 'MailContacts' }).Count -gt 1 -and $Kind -eq 'MailContacts') { $script:MailContacts[0].DisplayName='Changed during observation' }
  switch ($Kind) {
    MailContacts { return $script:MailContacts }
    ContactProfiles { return $script:ContactProfiles }
    DistributionGroups { return $script:DistributionGroups }
    GroupProfiles { return $script:GroupProfiles }
    default { throw "Unexpected inventory kind $Kind" }
  }
}
function Get-CurrentExchangeMembers($Group) {
  $script:MembershipCalls++
  if ($script:Scenario -eq 'member-error') { Write-Output $script:LiveMembers[0]; throw 'Synthetic membership page failure after partial output' }
  return $script:LiveMembers
}
function Assert-Receipt($Receipt, [string]$Status) {
  Assert-Equal $Status $Receipt.status 'Comparison result must be exact and fail closed'
  Assert-True ($Receipt.readOnly -is [bool] -and $Receipt.readOnly) 'Every receipt must explicitly remain read-only'
  Assert-True ($Receipt.certified -is [bool] -and -not $Receipt.certified) 'Comparison must never claim certification'
  Assert-True ($Receipt.observationOnly -is [bool] -and $Receipt.observationOnly) 'Comparison must explicitly be observation-only'
  Assert-True ($Receipt.certificationWritten -is [bool] -and -not $Receipt.certificationWritten) 'Comparison cannot write a certification'
}
function Run-Fixture([string]$Status) {
  $receipt=Invoke-CurrentAddressBookCheck
  Assert-Receipt $receipt $Status
  return $receipt
}

Test-Case 'Complete stable exact comparison matches the real worker projection' {
  Reset-Fixture
  $receipt=Run-Fixture 'OBSERVED_MATCH'
  Assert-True $receipt.sourceStable 'MATCH must include stable source evidence'
  Assert-True $receipt.queueStable 'MATCH must include stable queue evidence'
  Assert-Equal 2 $script:SourceReads 'MATCH must reread source, not use one snapshot'
  Assert-Equal 2 $script:OperationalReads 'MATCH must reread operational state'
  Assert-Equal 8 @($script:InventoryCalls).Count 'MATCH must independently reread all recipient and immutable-profile inventories'
  Assert-Equal 2 $script:MembershipCalls 'MATCH must independently reread each projected group membership'
  Assert-True ($receipt.scope -match 'Not an atomic snapshot' -and $receipt.scope -match 'history' -and $receipt.scope -match 'client') 'Observation must state non-atomic, non-history and non-client-delivery scope limits'
}
foreach ($mutation in @('missing-contact','extra-contact','duplicate-contact','retained-group-shadow','swapped-emails','wrong-source-key','contact-hidden','contact-profile-name','contact-profile-immutable-mismatch','contact-profile-contradictory-guid','duplicate-contact-profile','missing-contact-profile','missing-group','extra-group','duplicate-group','group-smtp','group-hidden','group-description','group-profile-immutable-mismatch','group-profile-contradictory-guid','duplicate-group-profile','missing-member','unexpected-member','duplicate-member','unresolved-member','swapped-member-identity')) {
  Test-Case "Count-independent mismatch: $mutation" {
    Reset-Fixture
    switch ($mutation) {
      missing-contact { $script:MailContacts=@($script:MailContacts[0]) }
      extra-contact { $extra=Copy-Fixture $script:MailContacts[0]; $extra.Guid='20000000-0000-4000-8000-000000000000'; $extra.Identity=$extra.Guid; $extra.CustomAttribute2='FCUNO_CONTACT:synthetic-extra'; $extra.ExternalEmailAddress='extra@example.invalid'; $script:MailContacts+=@($extra) }
      duplicate-contact { $script:MailContacts+=@((Copy-Fixture $script:MailContacts[0])) }
      retained-group-shadow { $extra=Copy-Fixture $script:MailContacts[0]; $extra.Guid='20000000-0000-4000-8000-000000000000'; $extra.Identity=$extra.Guid; $extra.CustomAttribute2='FCUNO_CONTACT:synthetic-shadow'; $extra.ExternalEmailAddress='old-shadow@example.invalid'; $script:MailContacts+=@($extra) }
      swapped-emails { $email=$script:MailContacts[0].ExternalEmailAddress; $script:MailContacts[0].ExternalEmailAddress=$script:MailContacts[1].ExternalEmailAddress; $script:MailContacts[1].ExternalEmailAddress=$email }
      wrong-source-key { $script:MailContacts[0].CustomAttribute2='FCUNO_CONTACT:synthetic-wrong-owner' }
      contact-hidden { $script:MailContacts[0].HiddenFromAddressListsEnabled=$true }
      contact-profile-name { $script:ContactProfiles[0].FirstName='Incorrect' }
      contact-profile-immutable-mismatch { $script:ContactProfiles[0].Guid='20000000-0000-4000-8000-000000000000'; $script:ContactProfiles[0].ExternalDirectoryObjectId='wrong'; $script:ContactProfiles[0].DistinguishedName='CN=Wrong,DC=example,DC=invalid'; $script:ContactProfiles[0].Identity=$script:MailContacts[0].DisplayName }
      contact-profile-contradictory-guid { $script:ContactProfiles[0].Guid='20000000-0000-4000-8000-000000000000' }
      duplicate-contact-profile { $script:ContactProfiles+=@((Copy-Fixture $script:ContactProfiles[0])) }
      missing-contact-profile { $script:ContactProfiles=@($script:ContactProfiles[1]) }
      missing-group { $script:DistributionGroups=@() }
      extra-group { $extra=Copy-Fixture $script:DistributionGroups[0]; $extra.Guid='20000000-0000-4000-8000-000000000000'; $extra.CustomAttribute2='FCUNO_GROUP:synthetic-extra'; $script:DistributionGroups+=@($extra) }
      duplicate-group { $script:DistributionGroups+=@((Copy-Fixture $script:DistributionGroups[0])) }
      group-smtp { $script:DistributionGroups[0].PrimarySmtpAddress='wrong@cosulich1.onmicrosoft.com' }
      group-hidden { $script:DistributionGroups[0].HiddenFromAddressListsEnabled=$true }
      group-description { $script:GroupProfiles[0].Notes='Incorrect' }
      group-profile-immutable-mismatch { $script:GroupProfiles[0].Guid='20000000-0000-4000-8000-000000000000'; $script:GroupProfiles[0].ExternalDirectoryObjectId='wrong'; $script:GroupProfiles[0].DistinguishedName='CN=Wrong,DC=example,DC=invalid'; $script:GroupProfiles[0].Identity='Synthetic Group' }
      group-profile-contradictory-guid { $script:GroupProfiles[0].Guid='20000000-0000-4000-8000-000000000000' }
      duplicate-group-profile { $script:GroupProfiles+=@((Copy-Fixture $script:GroupProfiles[0])) }
      missing-member { $script:LiveMembers=@($script:LiveMembers[0]) }
      unexpected-member { $extra=Copy-Fixture $script:LiveMembers[0]; $extra.ExternalEmailAddress='unexpected@example.invalid'; $extra.PrimarySmtpAddress=$extra.ExternalEmailAddress; $extra.Guid='20000000-0000-4000-8000-000000000000'; $script:LiveMembers+=@($extra) }
      duplicate-member { $script:LiveMembers+=@((Copy-Fixture $script:LiveMembers[0])) }
      unresolved-member { $script:LiveMembers+=@(@{Guid='20000000-0000-4000-8000-000000000000';Identity='Unresolved synthetic member';DisplayName='Unresolved synthetic member'}) }
      swapped-member-identity { $script:LiveMembers[0].Guid=$script:LiveMembers[1].Guid; $script:LiveMembers[0].Identity=$script:LiveMembers[1].Identity }
    }
    $receipt=Invoke-CurrentAddressBookCheck
    # Ambiguous immutable mapping may be an inconclusive read or a demonstrated
    # difference, but never a match. All unambiguous field differences must be DIFFERENT.
    if ($mutation -in @('duplicate-contact-profile','duplicate-group-profile','unresolved-member','swapped-member-identity')) {
      Assert-True ($receipt.status -in @('MISMATCH','INCONCLUSIVE')) "$mutation must never produce MATCH"
      Assert-Receipt $receipt $receipt.status
    } else { Assert-Receipt $receipt 'MISMATCH' }
  }
}
foreach ($failureScenario in @('projection-drift','raw-drift','queue-drift','ledger-aba','lease-drift','exchange-repeat-drift','unsettled','active-sync','source-error','queue-error','source-incomplete','source-validation-issue','queue-incomplete','inventory-error','member-error','deadline')) {
  Test-Case "Incomplete or unstable evidence: $failureScenario" {
    Reset-Fixture; $script:Scenario=$failureScenario
    $receipt=Run-Fixture 'INCONCLUSIVE'
    $serialized=$receipt | ConvertTo-Json -Depth 30 -Compress
    Assert-True ($serialized -notmatch 'PRIVATE-ERROR-SENTINEL|provider-secret|synthetic-person@example|99999999-0000') 'Provider failures must not expose raw private text in receipts'
  }
}
Test-Case 'Actual comparison bounds output details without hiding total mismatches or dumping private source fields' {
  Reset-Fixture
  for($i=0;$i -lt 40;$i++) {
    $extra=Copy-Fixture $script:MailContacts[0]
    $extra.Guid=('{0:00000000}-0000-4000-8000-000000000000' -f ($i+100));$extra.Identity=$extra.Guid
    $extra.CustomAttribute2="FCUNO_CONTACT:synthetic-extra-$i";$extra.ExternalEmailAddress="synthetic-private-extra-$i@example.invalid"
    $extra.DisplayName="Private synthetic business name $i";$script:MailContacts+=@($extra)
  }
  $receipt=Run-Fixture 'MISMATCH'
  Assert-True ($receipt.mismatchCount -ge 40) 'Output bounds may not reduce the total demonstrated difference count'
  Assert-Equal $MaxDetails @($receipt.details).Count 'Difference details must be capped at configured maximum'
  Assert-True $receipt.detailsTruncated 'Truncated details require an explicit flag'
  $json=$receipt | ConvertTo-Json -Depth 30 -Compress
  Assert-True ($json -notmatch 'synthetic-private-extra|Private synthetic business name') 'Only counts, fixed reason codes and safe source IDs may leave comparison memory'
}

$script:CurrentCheckClock=$null
Test-Case 'Actual monotonic budget helper rejects elapsed operation deadline' {
  $script:CurrentCheckClock=[pscustomobject]@{Elapsed=[TimeSpan]::FromSeconds($MaxDurationSeconds)}
  try {Assert-Throws {Assert-CurrentCheckBudget} 'Elapsed total deadline must fail closed'} finally {$script:CurrentCheckClock=$null}
}
Test-Case 'Actual settings helper accepts only the complete exact canonical target tuple' {
  Assert-CurrentSettings $CurrentCheckSupabaseOrigin $CurrentCheckExpectedAppId $CurrentCheckTenantId $CanonicalExchangeAddressBookDomain $CanonicalExchangeAddressBookDomain
  Assert-True $true 'Canonical tuple must pass'
  foreach($position in 0..4) {
    $settings=@($CurrentCheckSupabaseOrigin,$CurrentCheckExpectedAppId,$CurrentCheckTenantId,$CanonicalExchangeAddressBookDomain,$CanonicalExchangeAddressBookDomain)
    $settings[$position]='unrelated-synthetic-target'
    Assert-Throws {Assert-CurrentSettings @settings} 'Any changed target component must fail closed'
  }
}

function Get-MailContact {
  [CmdletBinding()]
  param($ResultSize,$Filter)
  Assert-Equal 'Unlimited' $ResultSize 'Actual inventory read may not silently cap records'
  Assert-True (-not $PSBoundParameters.ContainsKey('Filter')) 'Actual inventory must inspect the full inventory, not hide unexpected managed recipients with a source filter'
  if($script:ActualProviderMode -eq 'warning') {Write-Warning 'PRIVATE-PROVIDER-WARNING synthetic-private-warning@example.invalid'}
  if($script:ActualProviderMode -eq 'partial-error') {Write-Output $script:MailContacts[0];throw 'PRIVATE-PARTIAL-ERROR synthetic-private-warning@example.invalid'}
  if($script:ActualProviderMode -eq 'duplicate') {return @($script:MailContacts[0],$script:MailContacts[0])}
  if($script:ActualProviderMode -eq 'missing-identity') {return @([pscustomobject]@{DisplayName='Unsafe display-name-only identity'})}
  return $script:MailContacts
}
function Get-DistributionGroupMember {
  [CmdletBinding()]
  param($Identity,$ResultSize)
  Assert-Equal 'Unlimited' $ResultSize 'Actual group membership read may not silently cap records'
  Assert-Equal $script:DistributionGroups[0].Guid $Identity 'Membership read must use immutable resolved identity'
  if($script:ActualProviderMode -eq 'warning') {Write-Warning 'PRIVATE-PROVIDER-WARNING synthetic-private-warning@example.invalid'}
  if($script:ActualProviderMode -eq 'partial-error') {Write-Output $script:LiveMembers[0];throw 'PRIVATE-PARTIAL-ERROR synthetic-private-warning@example.invalid'}
  return $script:LiveMembers
}
Test-Case 'Actual provider inventory and member helpers require full Unlimited immutable reads' {
  Reset-Fixture;$script:ActualProviderMode='complete'
  $inventory=& $script:ProductionCurrentHelpers['Get-CurrentExchangeInventory'] 'MailContacts'
  $members=& $script:ProductionCurrentHelpers['Get-CurrentExchangeMembers'] $script:DistributionGroups[0]
  Assert-Equal 2 $inventory.Count 'Actual provider wrapper must retain all full-inventory rows'
  Assert-Equal 2 $members.Count 'Actual member wrapper must retain all complete members'
}
foreach($providerFailure in @('warning','partial-error','duplicate','missing-identity')) {
  Test-Case "Actual provider inventory fails closed for $providerFailure" {
    Reset-Fixture;$script:ActualProviderMode=$providerFailure
    Assert-Throws {& $script:ProductionCurrentHelpers['Get-CurrentExchangeInventory'] 'MailContacts'} 'Partial, warning-bearing or ambiguous inventory may not become complete evidence'
  }
}
foreach($providerFailure in @('warning','partial-error')) {
  Test-Case "Actual member read fails closed for $providerFailure" {
    Reset-Fixture;$script:ActualProviderMode=$providerFailure
    Assert-Throws {& $script:ProductionCurrentHelpers['Get-CurrentExchangeMembers'] $script:DistributionGroups[0]} 'Partial or warning-bearing membership may not become complete evidence'
  }
}
function Disconnect-ExchangeOnline {
  [CmdletBinding()]
  param($ConnectionId,$Confirm)
  $script:DisconnectCalls.Add(@{ConnectionId=$ConnectionId;Confirm=$Confirm})
  if($script:DisconnectMustFail) {throw 'Synthetic cleanup failure'}
}
foreach($cleanupMode in @('partial-no-id','established-id','cleanup-error')) {
  Test-Case "Actual connection cleanup clears in-memory state for $cleanupMode" {
    $script:DisconnectCalls=[Collections.Generic.List[object]]::new();$script:DisconnectMustFail=$cleanupMode -eq 'cleanup-error'
    $script:CurrentCheckConnectionAttempted=$true;$script:CurrentCheckConnected=$cleanupMode -ne 'partial-no-id'
    $script:CurrentCheckConnectionId=if($cleanupMode -eq 'partial-no-id') {$null} else {'synthetic-owned-connection'}
    $script:CurrentCheckServiceKey='synthetic-private-state-not-real';$script:CurrentCheckCertificate=$null
    if($script:DisconnectMustFail) {Assert-Throws {Close-CurrentCheckConnection} 'Cleanup transport failure must be visible'} else {Close-CurrentCheckConnection}
    Assert-Equal 1 $script:DisconnectCalls.Count 'Every attempted owned connection, including partial setup, requires cleanup'
    Assert-True (-not $script:CurrentCheckConnected -and -not $script:CurrentCheckConnectionAttempted) 'Cleanup must reset connection state even after an error'
    Assert-True ($null -eq $script:CurrentCheckServiceKey -and $null -eq $script:CurrentCheckConnectionId) 'Cleanup must clear credential and session state even after an error'
    Assert-True (-not $script:DisconnectCalls[0].Confirm) 'Cleanup must not prompt unattended jobs'
    if($cleanupMode -eq 'established-id') {Assert-Equal 'synthetic-owned-connection' $script:DisconnectCalls[0].ConnectionId 'Established connection cleanup must target only the owned session'}
  }
}
Set-Item Function:Invoke-CurrentSupabasePage -Value $script:ProductionCurrentHelpers['Invoke-CurrentSupabasePage']
function Get-CurrentSetting([string]$Name) {
  if ($Name -eq 'NEXT_PUBLIC_SUPABASE_URL') { return $script:TransportOrigin }
  throw 'TEST GUARD: no other provider setting may be read'
}
function Invoke-WebRequest {
  [CmdletBinding()]
  param($Method,$Uri,$Headers,$MaximumRedirection,$ConnectionTimeoutSeconds,$OperationTimeoutSeconds,$Body)
  $script:WebRequests.Add(@{Method=[string]$Method;Uri=[string]$Uri;Headers=$Headers;Redirects=$MaximumRedirection;ConnectionTimeout=$ConnectionTimeoutSeconds;OperationTimeout=$OperationTimeoutSeconds;HasBody=$PSBoundParameters.ContainsKey('Body')})
  if ($script:WebThrow) { throw 'PRIVATE-ERROR-SENTINEL synthetic-provider-credential' }
  return $script:WebResponse
}
function New-SyntheticServiceJwt([string]$Role='service_role',[string]$Ref=([Uri]$CurrentCheckSupabaseOrigin).Host.Split('.')[0]) {
  $header=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}')).TrimEnd('=').Replace('+','-').Replace('/','_')
  $claims=@{role=$Role;ref=$Ref} | ConvertTo-Json -Compress
  $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($claims)).TrimEnd('=').Replace('+','-').Replace('/','_')
  return "$header.$payload.synthetic_signature_not_real"
}
function Reset-Transport {
  $script:TransportOrigin=$CurrentCheckSupabaseOrigin
  $script:CurrentCheckServiceKey=New-SyntheticServiceJwt
  $script:WebRequests=[Collections.Generic.List[object]]::new()
  $script:WebThrow=$false
  $script:WebResponse=@{StatusCode=206;Headers=@{'Content-Range'=@('0-1/2')};Content='[{"id":"a"},{"id":"b"}]'}
}
Test-Case 'Actual transport confines synthetic private legacy credentials to header-only GET on pinned target' {
  Reset-Transport
  $page=Invoke-CurrentSupabasePage 'shared_addressbook_contacts' 'select=*&order=id.asc' 0 100
  Assert-Equal 2 $page.Rows.Count 'Actual transport must decode complete JSON arrays'
  Assert-Equal 1 $script:WebRequests.Count 'Transport must not retry, redirect or invent requests'
  $request=$script:WebRequests[0]
  Assert-Equal 'Get' $request.Method 'Transport must literally use GET'
  Assert-Equal "$CurrentCheckSupabaseOrigin/rest/v1/shared_addressbook_contacts?select=*&order=id.asc&offset=0&limit=100" $request.Uri 'Only pinned origin, known read table and allowlisted query may be requested'
  Assert-True (-not $request.Uri.Contains($script:CurrentCheckServiceKey)) 'Private credential must never appear in URL'
  Assert-Equal $script:CurrentCheckServiceKey $request.Headers.apikey 'Private API key belongs only in header'
  Assert-Equal "Bearer $($script:CurrentCheckServiceKey)" $request.Headers.Authorization 'Legacy key bearer compatibility must remain header-only'
  Assert-Equal 'count=exact' $request.Headers.Prefer 'Complete reads require exact server count'
  Assert-Equal 0 $request.Redirects 'Authenticated redirects must be disabled'
  Assert-True (-not $request.HasBody) 'Read-only transport must not send a body'
  Assert-True ($request.ConnectionTimeout -ge 1 -and $request.ConnectionTimeout -le 60) 'Connection timeout must remain bounded'
  Assert-True ($request.OperationTimeout -ge 1 -and $request.OperationTimeout -le 60) 'Operation timeout must remain bounded'
}
Test-Case 'Actual transport does not incorrectly send new-format secret keys as bearer tokens' {
  Reset-Transport; $script:CurrentCheckServiceKey='sb_secret_synthetic_private_test_key'
  $null=Invoke-CurrentSupabasePage 'shared_addressbook_contacts' 'select=*&order=id.asc' 0 100
  Assert-True (-not $script:WebRequests[0].Headers.ContainsKey('Authorization')) 'New-format secret key must not be inserted as a bearer token'
  Assert-Equal $script:CurrentCheckServiceKey $script:WebRequests[0].Headers.apikey 'New-format secret still stays in API-key header'
}
foreach($keyKind in @('publishable','anon','authenticated','wrong-project','malformed')) {
  Test-Case "Actual transport rejects $keyKind credential before request" {
    Reset-Transport
    $script:CurrentCheckServiceKey=switch($keyKind) {
      'publishable' {'sb_publishable_synthetic_not_private'}
      'anon' {New-SyntheticServiceJwt 'anon'}
      'authenticated' {New-SyntheticServiceJwt 'authenticated'}
      'wrong-project' {New-SyntheticServiceJwt 'service_role' 'unrelated-project'}
      'malformed' {'synthetic-not-a-valid-key'}
    }
    Assert-Throws {Invoke-CurrentSupabasePage 'shared_addressbook_contacts' 'select=*&order=id.asc' 0 100} 'Only configured service-role credentials may attempt complete source reads'
    Assert-Equal 0 $script:WebRequests.Count 'Non-service credential must not send an authenticated request'
  }
}
foreach($bad in @(
  @{Name='unknown table';Table='synthetic_other';Query='select=*&order=id.asc';Offset=0;Limit=100},
  @{Name='RPC';Table='rpc/certify_exchange';Query='select=*&order=id.asc';Offset=0;Limit=100},
  @{Name='origin injection';Table='https://unrelated.invalid/rest/v1/shared_addressbook_contacts';Query='select=*&order=id.asc';Offset=0;Limit=100},
  @{Name='table query injection';Table='shared_addressbook_contacts?select=*';Query='select=*&order=id.asc';Offset=0;Limit=100},
  @{Name='unknown query';Table='shared_addressbook_contacts';Query='select=*&order=id.asc&or=(id.not.is.null)';Offset=0;Limit=100},
  @{Name='negative offset';Table='shared_addressbook_contacts';Query='select=*&order=id.asc';Offset=-1;Limit=100},
  @{Name='zero limit';Table='shared_addressbook_contacts';Query='select=*&order=id.asc';Offset=0;Limit=0},
  @{Name='excess limit';Table='shared_addressbook_contacts';Query='select=*&order=id.asc';Offset=0;Limit=1001}
)) {
  Test-Case "Actual transport rejects $($bad.Name) before request" {
    Reset-Transport
    Assert-Throws { Invoke-CurrentSupabasePage $bad.Table $bad.Query $bad.Offset $bad.Limit } 'Unapproved request must fail closed'
    Assert-Equal 0 $script:WebRequests.Count 'Unapproved request must not send even one authenticated request'
  }
}
Test-Case 'Actual transport rejects settings target drift before private credential transmission' {
  Reset-Transport; $script:TransportOrigin='https://unrelated.invalid'
  Assert-Throws { Invoke-CurrentSupabasePage 'shared_addressbook_contacts' 'select=*&order=id.asc' 0 100 } 'Wrong target must fail closed'
  Assert-Equal 0 $script:WebRequests.Count 'Target mismatch must not send an authenticated request'
}
foreach($bad in @(
  @{Name='redirect';Status=302;Range='0-1/2';Content='[{"id":"a"},{"id":"b"}]'},
  @{Name='HTTP error';Status=500;Range='0-1/2';Content='[{"id":"a"},{"id":"b"}]'},
  @{Name='object instead of array';Status=200;Range='0-0/1';Content='{"id":"a"}'},
  @{Name='null page';Status=200;Range='*/0';Content='null'},
  @{Name='malformed JSON';Status=200;Range='0-0/1';Content='[{"id":'},
  @{Name='unknown total';Status=206;Range='0-1/*';Content='[{"id":"a"},{"id":"b"}]'},
  @{Name='missing Content-Range';Status=206;Range='';Content='[{"id":"a"},{"id":"b"}]'},
  @{Name='wrong start';Status=206;Range='1-2/3';Content='[{"id":"a"},{"id":"b"}]'},
  @{Name='wrong end';Status=206;Range='0-0/2';Content='[{"id":"a"},{"id":"b"}]'},
  @{Name='truncated page';Status=206;Range='0-1/2';Content='[{"id":"a"}]'},
  @{Name='empty early page';Status=206;Range='*/2';Content='[]'},
  @{Name='extra row';Status=206;Range='0-0/1';Content='[{"id":"a"},{"id":"b"}]'},
  @{Name='large total with missing page rows';Status=206;Range='0-1/100001';Content='[{"id":"a"},{"id":"b"}]'}
)) {
  Test-Case "Actual HTTP/page validation rejects $($bad.Name)" {
    Reset-Transport; $script:WebResponse=@{StatusCode=$bad.Status;Headers=@{'Content-Range'=@($bad.Range)};Content=$bad.Content}
    Assert-Throws { Invoke-CurrentSupabasePage 'shared_addressbook_contacts' 'select=*&order=id.asc' 0 100 } 'Incomplete or invalid provider response cannot become complete evidence'
    Assert-Equal 1 $script:WebRequests.Count 'A rejected HTTP read must not silently retry another request'
  }
}
Test-Case 'Actual transport accepts a proven empty exact-count array' {
  Reset-Transport; $script:WebResponse=@{StatusCode=200;Headers=@{'Content-Range'=@('*/0')};Content='[]'}
  $page=Invoke-CurrentSupabasePage 'shared_addressbook_contacts' 'select=*&order=id.asc' 0 100
  Assert-Equal 0 $page.Rows.Count 'Empty exact-count response must stay an empty array'
  Assert-Equal 0 $page.Total 'Proven empty response must have native zero total'
}

$script:PagerMode='complete';$script:PagerCalls=@();$script:PageSize=100
function Invoke-CurrentSupabasePage($Table,$Query,$Offset,$Limit) {
  $script:PagerCalls+=@([int]$Offset)
  $rows=@();$total=[long]101
  if($Offset -eq 0) { for($i=0;$i -lt 100;$i++) {$rows+=@(@{id=('synthetic-{0:000}' -f $i)})} }
  else {$rows=@(@{id='synthetic-100'})}
  switch($script:PagerMode) {
    'duplicate' {if($Offset -gt 0) {$rows=@(@{id='synthetic-099'})}}
    'unordered' {if($Offset -eq 0) {$temporary=$rows[0];$rows[0]=$rows[1];$rows[1]=$temporary}}
    'count-drift' {if($Offset -gt 0) {$total=[long]102}}
    'early-short' {if($Offset -eq 0) {$rows=@($rows[0])}}
    'nonarray' {$rows=@{id='synthetic-object'}}
    'nonrow' {$rows=@('not-a-row')}
    'missing-id' {if($Offset -gt 0) {$rows=@(@{other='missing-id'})}}
    'embedded-null-id' {if($Offset -gt 0) {$rows=@(@{id="synthetic`0injected"})}}
    'page-error' {if($Offset -gt 0) {Write-Output @{Rows=@(@{id='synthetic-100'});Total=[long]101;From=100;To=100};throw 'Synthetic second page failure'}}
    'wrong-range' {return @{Rows=$rows;Total=$total;From=1;To=100}}
    'invalid-count-type' {$total='101'}
    'excess-source-count' {$total=[long]100001}
  }
  return @{Rows=$rows;Total=$total;From=[long]$Offset;To=[long]($Offset+$rows.Count-1)}
}
Test-Case 'Actual pager proves complete ordered rows across multiple pages' {
  $script:PagerMode='complete';$script:PagerCalls=@()
  $rows=Get-CurrentRows 'shared_addressbook_contacts' 'select=*&order=id.asc' @('id')
  Assert-Equal 101 $rows.Count 'Actual pager must collect complete rows including last short page'
  Assert-Equal '0,100' ($script:PagerCalls -join ',') 'Actual pager must use exact deterministic offsets'
  Assert-Equal 'synthetic-100' $rows[100].id 'Actual pager must retain final row'
}
foreach($mode in @('duplicate','unordered','count-drift','early-short','nonarray','nonrow','missing-id','embedded-null-id','page-error','wrong-range','invalid-count-type','excess-source-count')) {
  Test-Case "Actual pager rejects $mode" {
    $script:PagerMode=$mode;$script:PagerCalls=@()
    Assert-Throws {Get-CurrentRows 'shared_addressbook_contacts' 'select=*&order=id.asc' @('id')} 'No partial page set may be treated as complete source'
    Assert-True ($script:PagerCalls.Count -le 2) 'Invalid paging must settle in bounded calls'
  }
}

function Get-CurrentRows($Table,$Query,$Keys) {
  switch($Table) {
    'shared_addressbook_contacts' {return ,$script:SourceContactsForTest}
    'shared_addressbook_groups' {return ,$script:SourceGroupsForTest}
    'shared_addressbook_group_members' {return ,$script:SourceMembersForTest}
    default {throw 'TEST GUARD: unexpected source table'}
  }
}
Test-Case 'Actual snapshot raw digest detects excluded duplicate-source changes with unchanged worker projection' {
  $script:SourceContactsForTest=Copy-Fixture $script:SyntheticContacts
  $script:SourceGroupsForTest=Copy-Fixture $script:SyntheticGroups
  $script:SourceMembersForTest=Copy-Fixture $script:SyntheticMembers
  $first=& $script:ProductionCurrentHelpers['Get-CurrentSourceSnapshot']
  $script:SourceContactsForTest[2].first_name='Changed excluded duplicate'
  $second=& $script:ProductionCurrentHelpers['Get-CurrentSourceSnapshot']
  Assert-Equal $first.Fingerprint $second.Fingerprint 'Duplicate-source metadata must be genuinely excluded from canonical projection in this fixture'
  Assert-True ($first.RawFingerprint -cne $second.RawFingerprint) 'Raw source drift must not be hidden by an unchanged canonical projection'
  Assert-Equal 4 $second.Counts.contacts 'Raw counts must include source rows excluded from Exchange projection'
  Assert-True ($second.Complete -is [bool] -and $second.Complete) 'Successful snapshot must carry typed completeness'
  Assert-Equal 0 @($second.SourceValidationIssues).Count 'Control source must not accidentally contain invalid relationships'
}
foreach($sourceFault in @('unnamed-group','orphan-member','wrong-group-counter')) {
  Test-Case "Actual raw snapshot flags $sourceFault rather than silently projecting it away" {
    $script:SourceContactsForTest=Copy-Fixture $script:SyntheticContacts
    $script:SourceGroupsForTest=Copy-Fixture $script:SyntheticGroups
    $script:SourceMembersForTest=Copy-Fixture $script:SyntheticMembers
    switch($sourceFault) {
      'unnamed-group' {$script:SourceGroupsForTest[1].name='';$script:SourceGroupsForTest[1].nickname='';$script:SourceGroupsForTest[1].source_uid=''}
      'orphan-member' {$script:SourceMembersForTest+=@(@{group_id='synthetic-g';contact_id='synthetic-missing';source_book='SYNTHETIC'})}
      'wrong-group-counter' {$script:SourceGroupsForTest[0].member_count=[long]99}
    }
    $snapshot=& $script:ProductionCurrentHelpers['Get-CurrentSourceSnapshot']
    Assert-True (@($snapshot.SourceValidationIssues).Count -gt 0) 'Malformed raw source cannot be hidden by projection helpers'
  }
}

function Get-CurrentRows($Table,$Query,$Keys) {
  if($Table -cne 'outlook_exchange_sync_lock' -or $Query -cne 'select=lock_name,run_id,sync_mode,acquired_at,heartbeat_at,expires_at&order=lock_name.asc') {throw 'TEST GUARD: unexpected operational table/query'}
  return ,$script:OperationalLeases
}
function Invoke-CurrentSupabasePage($Table,$Query,$Offset,$Limit) {
  Assert-True ($Offset -eq 0 -and $Limit -eq 1) 'Operational fences must use bounded one-row reads, never page historical queues/ledger'
  if($Table -ceq 'outlook_exchange_truth_ledger') {
    Assert-Equal 'select=ledger_sequence,entry_sha256&order=ledger_sequence.desc' $Query 'Only the latest ledger head may be inspected'
    if($script:OperationalMode -eq 'missing-ledger') {return @{Rows=@();Total=[long]0;From=-1;To=-1}}
    $hash=if($script:OperationalMode -eq 'bad-ledger-hash') {'not-a-hash'} else {'a'*64}
    $sequence=if($script:OperationalMode -eq 'bad-ledger-type') {'1000001'} else {[long]1000001}
    return @{Rows=@(@{ledger_sequence=$sequence;entry_sha256=$hash});Total=[long]2000000;From=0;To=0}
  }
  if($Table -ceq 'outlook_exchange_sync_queue' -and $Query -ceq 'select=queue_sequence,updated_at&order=updated_at.desc,queue_sequence.desc') {
    $updated=if($script:OperationalMode -eq 'bad-queue-date') {'not-a-date'} else {'2026-10-28T00:00:00Z'}
    return @{Rows=@(@{queue_sequence=[long]1000001;updated_at=$updated});Total=[long]2000000;From=0;To=0}
  }
  if($Table -ceq 'outlook_exchange_sync_queue' -and $Query -ceq 'select=id,queue_sequence,updated_at,status,next_attempt_at&status=in.(pending,processing,failed)&order=queue_sequence.asc') {
    if($script:OperationalMode -eq 'unsettled') {return @{Rows=@(@{id='synthetic-unsettled';queue_sequence=[long]1000001;updated_at='2026-10-28T00:00:00Z';status='failed'});Total=[long]1;From=0;To=0}}
    return @{Rows=@();Total=[long]0;From=-1;To=-1}
  }
  throw 'TEST GUARD: unexpected operational read'
}
function Reset-OperationalFixture {
  $script:OperationalMode='complete';$script:OperationalLeases=@()
}
Test-Case 'Actual operational fence permits large history counters without scanning historical rows' {
  Reset-OperationalFixture
  $state=& $script:ProductionCurrentHelpers['Get-CurrentOperationalState']
  Assert-Equal '1000001@2026-10-28T00:00:00Z' $state.QueueWatermark 'Queue sequence must not be confused with bounded source-row limit'
  Assert-Equal ('1000001@'+('a'*64)) $state.LedgerHead 'Ledger sequence must not be confused with bounded source-row limit'
  Assert-Equal 0 $state.UnsettledCount 'Complete control has no unsettled operations'
  Assert-True ($state.Complete -is [bool] -and $state.Complete -and -not $state.ActiveSync) 'Complete control must retain typed inactive fence state'
}
Test-Case 'Actual operational fence includes pending processing and failed unsettled rows' {
  Reset-OperationalFixture;$script:OperationalMode='unsettled'
  $state=& $script:ProductionCurrentHelpers['Get-CurrentOperationalState']
  Assert-Equal 1 $state.UnsettledCount 'Failed rows must not be silently excluded from unsettled evidence'
}
foreach($leaseState in @('active','expired')) {
  Test-Case "Actual operational fence recognizes $leaseState lease" {
    Reset-OperationalFixture
    $expires=if($leaseState -eq 'active') {[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')} else {[DateTimeOffset]::UtcNow.AddMinutes(-5).ToString('o')}
    $script:OperationalLeases=@(@{lock_name='synthetic-addressbook-lock';run_id='30000000-0000-4000-8000-000000000000';sync_mode='full';acquired_at='2026-10-28T00:00:00Z';heartbeat_at='2026-10-28T00:00:00Z';expires_at=$expires})
    $state=& $script:ProductionCurrentHelpers['Get-CurrentOperationalState']
    Assert-Equal ($leaseState -eq 'active') $state.ActiveSync 'Lease activity must follow native expiry evidence'
    Assert-True ($state.LeaseFingerprint -cmatch '^[0-9a-f]{64}$') 'Complete lease observations require stable fingerprint evidence'
  }
}
foreach($badFence in @('missing-ledger','bad-ledger-hash','bad-ledger-type','bad-queue-date','bad-lease-id','bad-lease-date')) {
  Test-Case "Actual operational fence rejects $badFence" {
    Reset-OperationalFixture;$script:OperationalMode=$badFence
    if($badFence -like 'bad-lease-*') {
      $script:OperationalLeases=@(@{lock_name='synthetic-addressbook-lock';run_id='30000000-0000-4000-8000-000000000000';expires_at=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')})
      if($badFence -eq 'bad-lease-id') {$script:OperationalLeases[0].run_id='not-a-guid'} else {$script:OperationalLeases[0].expires_at='not-a-date'}
    }
    Assert-Throws {& $script:ProductionCurrentHelpers['Get-CurrentOperationalState']} 'Missing or malformed operational evidence may not support a match'
  }
}

[pscustomobject]@{ schema='fcuno.current-addressbook.synthetic-tests/v1'; passed=$true; caseCount=$script:CaseResults.Count; assertionCount=$script:AssertionCount; cases=@($script:CaseResults) } | ConvertTo-Json -Depth 10 -Compress
