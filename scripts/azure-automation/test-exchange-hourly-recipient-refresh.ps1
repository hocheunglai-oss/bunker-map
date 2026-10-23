param([string]$WorkerPath = (Join-Path $PSScriptRoot 'sync-fcuno-outlook-addressbook.ps1'))
$ErrorActionPreference = 'Stop'
. $WorkerPath -LibraryOnly
function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw "FAILED: $Message" } }
function Assert-Throws([scriptblock]$Action, [string]$Message) { $failed = $false; try { & $Action | Out-Null } catch { $failed = $true }; Assert-True $failed $Message }
$rpcNames=@([regex]::Matches((Get-Content -LiteralPath $WorkerPath -Raw),'rpc/([a-z][a-z0-9_]+)') | ForEach-Object {$_.Groups[1].Value} | Sort-Object -Unique)
Assert-True ($rpcNames.Count -gt 10) 'Actual worker RPC source paths must be inspected, not an empty contract fixture'
foreach ($name in $rpcNames) { Assert-True ([Text.Encoding]::UTF8.GetByteCount($name) -le 63) "Actual HTTP RPC name $name exceeds PostgreSQL63-byte identifier limit" }
$script:CurrentQueueRunId = '11111111-1111-4111-8111-111111111111'
$script:CurrentSyncMode = 'incremental'
$script:ExistingCertId = '22222222-2222-4222-8222-222222222222'
$script:ExchangeAddressBookDomain = $CanonicalExchangeAddressBookDomain
function New-AtomicActivationReceipt($Fingerprint = ('a' * 64), [bool]$ReadOnlyVerification = $true) {
  $certifiedAt = [DateTimeOffset]::UtcNow.AddMinutes(-1).ToString('o')
  return @{
    certified=$true;atomicTemplateActivation=$true;verificationScope='full';executionMode=$(if ($ReadOnlyVerification) {'incremental'} else {'full'});readOnlyVerification=$ReadOnlyVerification
    runId=$script:CurrentQueueRunId;sourceFingerprint=$Fingerprint;certifiedAt=$certifiedAt
    templateReconciliation=@{
      reconciled=$true;idempotent=$false;runId=$script:CurrentQueueRunId;sourceFingerprint=$Fingerprint
      certifiedAt=$certifiedAt;updatedTemplates=[long]2
      verification=@{
        schema='fcuno.outlook-template-recipient-truth/v2';valid=$true;sourceTruthValid=$true
        certificationRunId=$script:CurrentQueueRunId;sourceFingerprint=$Fingerprint;certifiedAt=$certifiedAt
        templates=@{total=[long]2;unresolved=[long]0;stale=[long]0;invalidShape=[long]0;withMissingRecipients=[long]0;withAmbiguousRecipients=[long]0;sendable=[long]2}
      }
    }
  }
}
$atomicReceipt = New-AtomicActivationReceipt
Assert-True (-not (Get-AtomicExchangeTemplateActivationContractError $atomicReceipt $script:CurrentQueueRunId ('a'*64))) 'Exact atomic activation receipt must be accepted'
$dailyAtomicReceipt = New-AtomicActivationReceipt ('a'*64) $false
Assert-True (-not (Get-AtomicExchangeTemplateActivationContractError $dailyAtomicReceipt $script:CurrentQueueRunId ('a'*64) $false)) 'Daily full atomic receipt must retain full execution mode and native readOnlyVerification false'
Assert-True ([bool](Get-AtomicExchangeTemplateActivationContractError $dailyAtomicReceipt $script:CurrentQueueRunId ('a'*64))) 'Daily full receipt must never be accepted as read-only incremental proof'
Assert-True ([bool](Get-AtomicExchangeTemplateActivationContractError $atomicReceipt $script:CurrentQueueRunId ('a'*64) $false)) 'Incremental read-only receipt must never be accepted as daily full proof'
foreach ($field in @('atomicTemplateActivation','templateReconciliation','verificationScope','executionMode','readOnlyVerification')) {
  $bad=New-AtomicActivationReceipt; $bad.Remove($field)
  Assert-True ([bool](Get-AtomicExchangeTemplateActivationContractError $bad $script:CurrentQueueRunId ('a'*64))) "Missing atomic $field must fail closed"
}
foreach ($change in @(
  @{path='atomicTemplateActivation';value='true'}, @{path='readOnlyVerification';value='true'},
  @{path='verificationScope';value='delta'}, @{path='executionMode';value='full'},
  @{path='templateReconciliation.reconciled';value='true'}, @{path='templateReconciliation.idempotent';value='false'},
  @{path='templateReconciliation.runId';value=$script:ExistingCertId}, @{path='templateReconciliation.sourceFingerprint';value=('b'*64)},
  @{path='templateReconciliation.certifiedAt';value='2026-10-21T00:00:00Z'},
  @{path='templateReconciliation.updatedTemplates';value='2'}, @{path='templateReconciliation.updatedTemplates';value=[double]::NaN},
  @{path='templateReconciliation.updatedTemplates';value=[long]3},
  @{path='templateReconciliation.verification.schema';value='other/v2'},
  @{path='templateReconciliation.verification.valid';value='true'}, @{path='templateReconciliation.verification.sourceTruthValid';value=$false},
  @{path='templateReconciliation.verification.certificationRunId';value=$script:ExistingCertId},
  @{path='templateReconciliation.verification.sourceFingerprint';value=('b'*64)},
  @{path='templateReconciliation.verification.certifiedAt';value='2026-10-21T00:00:00Z'}
)) {
  $bad=New-AtomicActivationReceipt; $parts=$change.path.Split('.'); $target=$bad
  for ($i=0;$i -lt $parts.Count-1;$i++) { $target=$target[$parts[$i]] }
  $target[$parts[-1]]=$change.value
  Assert-True ([bool](Get-AtomicExchangeTemplateActivationContractError $bad $script:CurrentQueueRunId ('a'*64))) "Malformed atomic $($change.path) must fail closed"
}
foreach ($field in @('total','unresolved','stale','invalidShape','withMissingRecipients','withAmbiguousRecipients','sendable')) {
  foreach ($value in @($null,'0',-1,[double]::PositiveInfinity)) {
    $bad=New-AtomicActivationReceipt; $bad.templateReconciliation.verification.templates[$field]=$value
    Assert-True ([bool](Get-AtomicExchangeTemplateActivationContractError $bad $script:CurrentQueueRunId ('a'*64))) "Non-native $field must fail closed"
  }
}
foreach ($field in @('unresolved','stale','invalidShape')) {
  $bad=New-AtomicActivationReceipt; $bad.templateReconciliation.verification.templates[$field]=[long]1
  Assert-True ([bool](Get-AtomicExchangeTemplateActivationContractError $bad $script:CurrentQueueRunId ('a'*64))) "Nonzero $field cannot be activated"
}
foreach ($field in @('reconciled','idempotent','runId','sourceFingerprint','certifiedAt','updatedTemplates','verification')) {
  $bad=New-AtomicActivationReceipt; $bad.templateReconciliation.Remove($field)
  Assert-True ([bool](Get-AtomicExchangeTemplateActivationContractError $bad $script:CurrentQueueRunId ('a'*64))) "Missing nested activation $field must fail closed"
}
foreach ($field in @('schema','valid','sourceTruthValid','certificationRunId','sourceFingerprint','certifiedAt','templates')) {
  $bad=New-AtomicActivationReceipt; $bad.templateReconciliation.verification.Remove($field)
  Assert-True ([bool](Get-AtomicExchangeTemplateActivationContractError $bad $script:CurrentQueueRunId ('a'*64))) "Missing nested verification $field must fail closed"
}
$replay=New-AtomicActivationReceipt; $replay.idempotent=$true
Assert-True (-not (Get-AtomicExchangeTemplateActivationContractError $replay $script:CurrentQueueRunId ('a'*64))) 'Exact replay may retain original nested non-idempotent activation receipt'
$knownMissing=New-AtomicActivationReceipt; $knownMissing.templateReconciliation.verification.templates.withMissingRecipients=[long]1
$knownMissing.templateReconciliation.verification.templates.sendable=[long]1
Assert-True (-not (Get-AtomicExchangeTemplateActivationContractError $knownMissing $script:CurrentQueueRunId ('a'*64))) 'Known missing recipients are not fabricated into sendable templates or treated as stale evidence'
function New-RefreshState($Mode = 'none') {
  return @{
    schema = 'fcuno.outlook-template-recipient-refresh-state/v1'; runId = $script:CurrentQueueRunId
    executionMode = 'incremental'; verificationScope = 'full'; mode = $Mode; queueSettled = $true
    reasons = @(); certificationRunId = $script:ExistingCertId; sourceFingerprint = ('a' * 64)
    certifiedAt = [DateTimeOffset]::UtcNow.AddMinutes(-5).ToString('o')
  }
}
$script:RefreshState = New-RefreshState
$script:RestCalls = @()
function Invoke-SupabaseRest($Method, $Path, $Body) {
  $script:RestCalls += @{ Method = $Method; Path = $Path; Body = $Body }
  if ($Method -ne 'GET' -or $Path -cne "rpc/get_outlook_template_recipient_refresh_state?p_run_id=$script:CurrentQueueRunId") { throw 'Unexpected refresh-state transport' }
  return $script:RefreshState
}
$state = Get-OutlookTemplateRecipientRefreshState
Assert-True ($state.mode -ceq 'none' -and $state.queueSettled -is [bool]) 'The genuine typed state response must be accepted'
$script:RefreshState = New-RefreshState 'full'
$script:RefreshState.reasons = @('certification-refresh-due')
$state = Get-OutlookTemplateRecipientRefreshState
Assert-True ($state.mode -ceq 'full' -and $state.reasons.Count -eq 1 -and $state.reasons[0] -ceq 'certification-refresh-due') 'Proactive renewal reason must be accepted by the actual bounded state contract'
foreach ($field in @('schema','runId','executionMode','verificationScope','mode','queueSettled','reasons','certificationRunId','sourceFingerprint','certifiedAt')) {
  $script:RefreshState = New-RefreshState 'reconcile'; $script:RefreshState.Remove($field)
  Assert-Throws { Get-OutlookTemplateRecipientRefreshState } "Missing $field must fail closed"
}
foreach ($change in @(
  @{ field='queueSettled'; value='true' }, @{ field='mode'; value='delta' },
  @{ field='executionMode'; value='full' }, @{ field='runId'; value=$script:ExistingCertId },
  @{ field='certificationRunId'; value='not-a-uuid' }, @{ field='sourceFingerprint'; value=('A' * 64) },
  @{ field='certifiedAt'; value=[DateTimeOffset]::UtcNow.AddHours(-37).ToString('o') },
  @{ field='reasons'; value='source-pending' }
)) {
  $script:RefreshState = New-RefreshState 'reconcile'; $script:RefreshState[$change.field] = $change.value
  Assert-Throws { Get-OutlookTemplateRecipientRefreshState } "Malformed $($change.field) must not authorize refresh"
}
$script:RefreshState = New-RefreshState 'full'; $script:RefreshState.queueSettled = $false
Assert-Throws { Get-OutlookTemplateRecipientRefreshState } 'Unsettled state must never authorize full verification'

$originalFull = (Get-Item Function:Invoke-ReadOnlyFullExchangeVerification).ScriptBlock
$originalReconcile = (Get-Item Function:Commit-OutlookTemplateRecipientReconciliation).ScriptBlock
$script:FullCalls = 0; $script:ReconcileCalls = 0; $script:StatusWrites = 0
function Save-SyncStatus { $script:StatusWrites++; throw 'Refresh must not publish final status' }
function Add-ExchangeTruthLedgerEvidence([hashtable]$Stats) {
  foreach ($name in @('Pending','Processing','Failed','TerminalFailed')) { $Stats["truthCheckpoint$($name)QueueRows"] = [long]0 }
}
Set-Item Function:Invoke-ReadOnlyFullExchangeVerification -Value { $script:FullCalls++; if ($script:FullMustFail) { throw 'Synthetic full verification failure' }; return @{ fullCertificationCommitted=$true; templateRecipientTruthReconciled=$true } }
Set-Item Function:Commit-OutlookTemplateRecipientReconciliation -Value {
  param($CertificationResult,$SourceFingerprint)
  $script:ReconcileCalls++
  Assert-True ($CertificationResult.runId -ceq $script:ExistingCertId -and $SourceFingerprint -ceq ('a' * 64)) 'Derived-only retry must retain the existing certification identity'
  return @{ reconciled=$true }
}
function New-DeliveryStats { return @{ queuedRows=0; completedQueueRows=0; failedQueueRows=0; backlogRows=0; skippedQueueRows=0; supersededQueueRows=0; resolvedTerminalQueueRows=0 } }
foreach ($mode in @('none','full','reconcile')) {
  $script:FullCalls=0; $script:ReconcileCalls=0; $script:RefreshState=New-RefreshState $mode
  if ($mode -ceq 'full') { $script:RefreshState.reasons=@('certification-refresh-due') }
  $stats=New-DeliveryStats
  Complete-IncrementalRecipientRefresh $stats
  Assert-True ($script:FullCalls -eq $(if ($mode -eq 'full') {1} else {0})) 'Zero-queue recovery must full-verify only when server requires it'
  Assert-True ($script:ReconcileCalls -eq $(if ($mode -eq 'reconcile') {1} else {0})) 'Derived-only recovery must not perform Exchange reads or create another certification'
}
$script:RefreshState=New-RefreshState 'full'; $script:FullCalls=0; $script:FullMustFail=$true
$stats=New-DeliveryStats
Assert-Throws { Complete-IncrementalRecipientRefresh $stats } 'Required full-verification failure must propagate, never become completed'
Assert-True ($stats.recipientRefreshStatus -ceq 'failed' -and $stats.failedQueueRows -eq 0) 'Verification failure must not mislabel already-delivered queue rows as failed'
Assert-True ($script:StatusWrites -eq 0) 'No completed status may be published before certification and reconciliation'
$script:FullMustFail=$false
Set-Item Function:Invoke-ReadOnlyFullExchangeVerification -Value $originalFull
Set-Item Function:Commit-OutlookTemplateRecipientReconciliation -Value $originalReconcile

function Renew-ExchangeSyncLockIfDue { }
function Get-ExchangeMonotonicMilliseconds { return [double]$script:Clock }
function Start-Sleep([int]$Seconds) { $script:Clock += $Seconds * 1000 }
foreach ($name in @('New-MailContact','Set-MailContact','Remove-MailContact','Set-Contact','New-DistributionGroup','Set-DistributionGroup','Remove-DistributionGroup','Set-Group','Add-DistributionGroupMember','Remove-DistributionGroupMember')) {
  Set-Item "Function:$name" -Value { throw 'TEST GUARD: full read-only verification attempted a provider write' }
}
$script:SourceContacts=@(
  [pscustomobject]@{id='c1';display_name='Peer';primary_email='one@example.invalid';nickname='peer';first_name='One';last_name='A';source_book='TEST';updated_at='2026-10-22T00:01:00Z'},
  [pscustomobject]@{id='duplicate';display_name='Old duplicate';primary_email='one@example.invalid';nickname='old';first_name='Old';last_name='A';source_book='TEST';updated_at='2026-10-21T00:00:00Z'},
  [pscustomobject]@{id='c2';display_name='Peer';primary_email='two@example.invalid';nickname='peer';first_name='Two';last_name='B';source_book='TEST';updated_at='2026-10-22T00:00:00Z'}
)
$script:SourceGroups=@(
  [pscustomobject]@{id='g1';name='Peer';nickname='peer';description='First';source_book='TEST'},
  [pscustomobject]@{id='g2';name='Peer';nickname='peer';description='Second';source_book='TEST'}
)
$script:SourceMembers=@(
  [pscustomobject]@{group_id='g1';contact_id='c1'}, [pscustomobject]@{group_id='g1';contact_id='duplicate'},
  [pscustomobject]@{group_id='g1';contact_id='c2'}, [pscustomobject]@{group_id='g2';contact_id='c2'}
)
function Reset-FullTest($Scenario) {
  $script:Scenario=$Scenario; $script:Clock=0; $script:ReadCalls=@(); $script:SourceReads=0; $script:FenceReads=0; $script:CertCalls=0
  $script:Rows=Build-ExchangeRows $script:SourceContacts $script:SourceGroups $script:SourceMembers
  $script:Mails=@(); $script:Profiles=@(); $script:Groups=@(); $script:GroupProfiles=@()
  $position=0
  foreach ($c in $script:Rows.Contacts) {
    $position++; $guid="a1111111-1111-4111-8111-11111111111$position"
    $script:Mails += [pscustomobject]@{Guid=$guid;Identity=$guid;Name=$c.DirectoryName;DisplayName=$c.DisplayName;Alias=$c.Alias;ExternalEmailAddress=$c.ExternalEmailAddress;CustomAttribute1=$ManagedMarker;CustomAttribute2=$c.SourceKey;HiddenFromAddressListsEnabled=$false}
    $script:Profiles += [pscustomobject]@{Guid=$guid;FirstName=$c.FirstName;LastName=$c.LastName}
  }
  $position=0
  foreach ($g in $script:Rows.Groups) {
    $position++; $guid="b1111111-1111-4111-8111-11111111111$position"
    $script:Groups += [pscustomobject]@{Guid=$guid;Identity=$guid;Name=$g.DirectoryName;DisplayName=$g.GroupName;Alias=$g.Alias;PrimarySmtpAddress=$g.SmtpAddress;CustomAttribute1=$ManagedMarker;CustomAttribute2=$g.SourceKey;HiddenFromAddressListsEnabled=$false}
    $script:GroupProfiles += [pscustomobject]@{Guid=$guid;Notes=$g.Description}
  }
  if ($Scenario -eq 'profile-mismatch') { $script:Profiles[0].FirstName='Wrong' }
}
function Read-Step($Name) {
  $script:ReadCalls += $Name
  if ($script:Scenario -eq 'budget') { $script:Clock += 400001 }
  if ($script:Scenario -eq 'temporary-bulk') { throw [System.TimeoutException]::new('Synthetic bulk read interruption') }
  if ($script:Scenario -eq 'temporary-http') { throw [System.Net.Http.HttpRequestException]::new('Synthetic provider unavailable',$null,[System.Net.HttpStatusCode]::ServiceUnavailable) }
  if ($script:Scenario -eq 'permanent-auth') { throw [System.Net.Http.HttpRequestException]::new('Access denied',$null,[System.Net.HttpStatusCode]::Unauthorized) }
  if ($script:Scenario -eq 'temporary-remote') { throw 'A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support.' }
}
function Get-CanonicalExchangeRows {
  $script:SourceReads++
  if ($script:Scenario -eq 'source-drift' -and $script:SourceReads -gt 1) {
    $copy=$script:SourceContacts | ForEach-Object { $_ | Select-Object * }; $copy[0].first_name='Changed'
    return Build-ExchangeRows $copy $script:SourceGroups $script:SourceMembers
  }
  return $script:Rows
}
function Get-ExchangeQueueHighWater { $script:FenceReads++; if ($script:Scenario -eq 'queue-drift' -and $script:FenceReads -gt 1) { return '43@2026-10-22T00:01:00Z' }; return '42@2026-10-22T00:00:00Z' }
function Get-MailContact($ResultSize,$Filter) { Assert-True (-not $Filter -and $ResultSize -eq 'Unlimited') 'Full contact inventory must be unfiltered and untruncated'; Read-Step 'mail'; return $script:Mails }
function Get-Contact($ResultSize,$Filter) { Assert-True (-not $Filter -and $ResultSize -eq 'Unlimited') 'Full contact profiles must be unfiltered and untruncated'; Read-Step 'contact-profile'; return $script:Profiles }
function Get-Group($ResultSize) { Assert-True ($ResultSize -eq 'Unlimited') 'Full group profiles must be untruncated'; Read-Step 'group-profile'; return $script:GroupProfiles }
function Get-DistributionGroup($ResultSize,$Filter) {
  Assert-True ($ResultSize -eq 'Unlimited') 'Full groups must be untruncated'
  Read-Step $(if ($Filter) {'group-identity'} else {'groups'})
  if (-not $Filter) { return $script:Groups }
  return @($script:Groups | Where-Object { $Filter -ceq "CustomAttribute2 -eq '$($_.CustomAttribute2)'" })
}
function Get-DistributionGroupMember($Identity,$ResultSize) {
  Assert-True ($ResultSize -eq 'Unlimited') 'Every group membership must be untruncated'; Read-Step 'members'
  if ($script:Scenario -eq 'temporary-membership') { throw [System.TimeoutException]::new('Synthetic membership read interruption') }
  $group=@($script:Groups | Where-Object Guid -eq $Identity)[0]
  $id=$group.CustomAttribute2.Substring('FCUNO_GROUP:'.Length)
  $members=@($script:Rows.Members | Where-Object SourceGroupId -eq $id | ForEach-Object { [pscustomobject]@{PrimarySmtpAddress=$_.MemberEmail} })
  if ($script:Scenario -eq 'membership-mismatch') { $members += [pscustomobject]@{PrimarySmtpAddress='unexpected@example.invalid'} }
  return $members
}
$originalCommitFull = (Get-Item Function:Commit-FullExchangeQueueCertification).ScriptBlock
function Commit-FullExchangeQueueCertification($Fence,$Fingerprint,$Json,$Counts,$Summary,[bool]$ReadOnlyVerification=$false) {
  $script:CertCalls++
  if ($script:Scenario -eq 'staging-lock-timeout') { throw 'canceling statement due to lock timeout' }
  if ($script:Scenario -in @('staging-sql-lock','staging-source-race','staging-proof-invalid')) {
    $sqlError=if ($script:Scenario -eq 'staging-sql-lock') {@{code='55P03';message='canceling statement due to lock timeout'}} elseif ($script:Scenario -eq 'staging-source-race') {@{code='P0001';message='OUTLOOK_REFRESH_QUEUE_NOT_SETTLED: queued edit arrived during verification'}} else {@{code='P0001';message='Immutable projection proof does not match'}}
    $record=[System.Management.Automation.ErrorRecord]::new([System.InvalidOperationException]::new('Response status code does not indicate success:400 (Bad Request).'),'SyntheticPostgrest',[System.Management.Automation.ErrorCategory]::InvalidOperation,$null)
    $record.ErrorDetails=[System.Management.Automation.ErrorDetails]::new(($sqlError|ConvertTo-Json -Compress))
    throw $record
  }
  if ($script:Scenario -eq 'staging-fence-race') { throw 'Atomic full Exchange queue certification was not accepted: Queue high-water changed after full projection verification; no terminal rows were superseded.' }
  Assert-True $ReadOnlyVerification 'Hourly verification must use the dedicated read-only certification contract'
  Assert-True ($Summary.verificationScope -ceq 'full' -and $Summary.executionMode -ceq 'incremental' -and $Summary.readOnlyVerification -is [bool] -and $Summary.readOnlyVerification) 'Full proof must identify its read-only incremental execution honestly'
  Assert-True ($Counts.contacts -eq 2 -and $Counts.groups -eq 2 -and $Counts.members -eq 3 -and $Counts.duplicateContacts -eq 1) 'Full proof must include canonical dedupe and all dependent groups'
  Assert-True ($Summary.verifiedManagedContacts -eq 2 -and $Summary.verifiedManagedGroups -eq 2 -and $Summary.verifiedMembershipGroups -eq 2 -and $Summary.verifiedMemberships -eq 3) 'Full summary must use genuine full verification counts, not incremental counters'
  $result=New-AtomicActivationReceipt $Fingerprint
  if ($script:Scenario -eq 'atomic-receipt-missing') { $result.Remove('atomicTemplateActivation') }
  if ($script:Scenario -eq 'atomic-receipt-late') { $script:Clock=1200001 }
  return $result
}
function Commit-OutlookTemplateRecipientReconciliation($CertificationResult,$SourceFingerprint) {
  throw 'TEST GUARD: new hourly full certification must never activate templates with later batches'
}
Reset-FullTest 'success'
$verified=Invoke-ReadOnlyFullExchangeVerification
Assert-True ($verified.fullCertificationCommitted -and $verified.templateRecipientTruthReconciled) 'Genuine full read-only verification must certify and reconcile'
Assert-True ($script:ReadCalls.Count -eq 8 -and @($script:ReadCalls | Where-Object {$_ -eq 'members'}).Count -eq 2) 'Two groups require exactly4bulk+2G=8provider read cmdlets'
Assert-True ($script:SourceReads -eq 2 -and $script:FenceReads -eq 2 -and $script:CertCalls -eq 1) 'Source and queue fences must be independently reread before one certification'
Reset-FullTest 'atomic-receipt-missing'
Assert-Throws { Invoke-ReadOnlyFullExchangeVerification } 'Missing atomic activation cannot become a completed hourly verification or fall back to later batches'
Assert-True ($script:CertCalls -eq 1) 'Malformed activation response may not create another certificate through a different path'
Reset-FullTest 'atomic-receipt-late'
Assert-Throws { Invoke-ReadOnlyFullExchangeVerification } 'A response arriving after the shared full-verification budget may not be acknowledged as completed'
Assert-True ($script:CertCalls -eq 1) 'A late atomic response may not be retried through later activation batches'
foreach ($scenario in @('profile-mismatch','membership-mismatch','source-drift','queue-drift','budget')) {
  Reset-FullTest $scenario
  Assert-Throws { Invoke-ReadOnlyFullExchangeVerification } "$scenario must fail closed"
  Assert-True ($script:CertCalls -eq 0) "$scenario must never create certification"
  if ($scenario -eq 'budget') { Assert-True ($script:ReadCalls.Count -eq 3) 'No fourth provider read may start after20minute shared budget' }
}
Reset-FullTest 'success'
$projectionJson=Get-CanonicalExchangeProjectionJson $script:Rows
$projectionHash=Get-Sha256Hex $projectionJson
$projectionCounts=Get-CanonicalExchangeProjectionCounts $script:Rows
$script:AtomicCalls=@()
function Invoke-ExchangeAtomicRpcWithRetry($Path,$Body,$SuccessProperty,$RequiredSuccessObjectProperty,$OperationLabel,$AdditionalContractValidator) {
  $script:AtomicCalls += @{Path=$Path;Body=$Body}
  $receipt=@{
    staged=$true;certified=$true;idempotent=$false;reason='Synthetic proof';supersededCount=0;supersededRows=@()
    runId=$script:CurrentQueueRunId;sourceFingerprint=$projectionHash;projectionSnapshotHash=$projectionHash
    workerVersion=$ExchangeTruthWorkerVersion;projectionCounts=$projectionCounts
    rawSourceSnapshotHash=('b'*64);rawSourceCounts=@{contacts=3;groups=2;members=4}
    evidenceRecorded=$true;truthLedgerSequence=[long]42;truthLedgerHash=('c'*64);sourceSnapshotHash=$projectionHash
    certifiedAt=[DateTimeOffset]::UtcNow.ToString('o')
    queueFence=@{expectedSequence=[long]42;currentSequence=[long]42;expectedUpdatedAt='2026-10-22T00:00:00Z';currentUpdatedAt='2026-10-22T00:00:00Z'}
  }
  if ($Path -cin @('rpc/certify_staged_read_only_outlook_exchange_truth','rpc/certify_staged_full_outlook_truth_and_activate_templates')) {
    $atomic = New-AtomicActivationReceipt $projectionHash ($Path -ceq 'rpc/certify_staged_read_only_outlook_exchange_truth')
    foreach ($key in @('atomicTemplateActivation','verificationScope','executionMode','readOnlyVerification','templateReconciliation','certifiedAt')) { $receipt[$key]=$atomic[$key] }
  }
  Assert-True (-not (Get-ExchangeAtomicRpcContractError $receipt $SuccessProperty $RequiredSuccessObjectProperty)) 'Synthetic transport must satisfy unchanged native receipt guards'
  Assert-True (-not (& $AdditionalContractValidator $receipt)) 'Actual proof validator must accept exact source/run/fence/counts'
  return $receipt
}
$summary=@{status='match';mismatchCount=0;verifiedManagedContacts=2;verifiedManagedGroups=2;verifiedMembershipGroups=2;verifiedMemberships=3;sourceFenceStable=$true;queueFence='42@2026-10-22T00:00:00Z';sourceFingerprint=$projectionHash;verificationScope='full';executionMode='incremental';readOnlyVerification=$true}
& $originalCommitFull '42@2026-10-22T00:00:00Z' $projectionHash $projectionJson $projectionCounts $summary $true | Out-Null
Assert-True ($script:AtomicCalls.Count -eq 3 -and $script:AtomicCalls[2].Path -ceq 'rpc/certify_staged_read_only_outlook_exchange_truth') 'Actual hourly full-proof commit must use the dedicated same-nine-argument wrapper'
Assert-True ($script:AtomicCalls[2].Body.Count -eq 9 -and $script:AtomicCalls[2].Body.p_run_id -ceq $script:CurrentQueueRunId -and $script:AtomicCalls[2].Body.p_verification_summary.readOnlyVerification -is [bool]) 'Actual wrapper call must preserve exact proof identity and native read-only metadata'
$dailySummary=$summary.Clone(); $dailySummary.executionMode='full'; $dailySummary.readOnlyVerification=$false
& $originalCommitFull '42@2026-10-22T00:00:00Z' $projectionHash $projectionJson $projectionCounts $dailySummary $false | Out-Null
Assert-True ($script:AtomicCalls.Count -eq 6 -and $script:AtomicCalls[5].Path -ceq 'rpc/certify_staged_full_outlook_truth_and_activate_templates') 'Daily full proof must call its exact untruncated catalog/API atomic-activation sibling'
Assert-True ($script:AtomicCalls[5].Body.Count -eq 9 -and $script:AtomicCalls[5].Body.p_verification_summary.executionMode -ceq 'full' -and $script:AtomicCalls[5].Body.p_verification_summary.readOnlyVerification -is [bool] -and -not $script:AtomicCalls[5].Body.p_verification_summary.readOnlyVerification) 'Daily full wrapper must preserve all nine proof arguments without claiming read-only execution'

# Feed actual exceptions from the real read-only phase through the unchanged
# classifier AND notification policy, rather than testing invented error text.
$script:AlertCalls=@(); $script:AlertMail=@(); $script:AlertEligible=$false
function Get-AutomationVariable($Name) { if ($Name -eq 'EXCHANGE_SYNC_NOTIFY_EMAILS') { return 'synthetic-team@example.invalid' }; return $null }
function Send-ExchangeSmtpMail($From,$To,$Subject,$Html) { $script:AlertMail+=@{Subject=$Subject;Html=$Html}; return $true }
function Invoke-SupabaseRest($Method,$Path,$Body) {
  Assert-True ($Method -ceq 'POST') 'Alert fixture permits no provider or contact operations'
  $script:AlertCalls+=@{Path=$Path;Body=$Body}
  if ($Path -ceq 'rpc/observe_outlook_exchange_alert') {
    return @{shouldNotify=[bool]$script:AlertEligible;claimId=$(if ($script:AlertEligible) {'dddddddd-dddd-4ddd-8ddd-dddddddddddd'} else {$null});incidentKeys=@($Body.p_incidents | ForEach-Object {$_.key});reason=$(if ($script:AlertEligible) {'notification_claimed'} else {'waiting_for_persistence'})}
  }
  if ($Path -ceq 'rpc/complete_outlook_exchange_alert') { return @{accepted=$true;delivered=[bool]$Body.p_delivered} }
  throw 'TEST GUARD: unexpected alert RPC'
}
$stableDelayKey=$null
foreach ($scenario in @('source-drift','queue-drift','budget','temporary-bulk','temporary-http','temporary-remote','temporary-membership','staging-lock-timeout','staging-sql-lock','staging-source-race','staging-fence-race','profile-mismatch','membership-mismatch','atomic-receipt-missing','staging-proof-invalid','permanent-auth')) {
  Reset-FullTest $scenario; $actualFailure=$null
  try { Invoke-ReadOnlyFullExchangeVerification | Out-Null } catch { $actualFailure=$_ }
  Assert-True ($null -ne $actualFailure) "$scenario must remain a truthful failed verification"
  $details=New-DeliveryStats; $details.completedQueueRows=2; $details.syncMode='incremental'; $details.failureStage='verification'; $details.recipientRefreshStatus='failed'
  $incidents=@(Get-ExchangeAlertIncidents 'failed' $actualFailure.Exception.Message $details 'incremental')
  Assert-True ($incidents.Count -eq 1) "$scenario must be recorded as one stable service incident"
  $permanent=$scenario -in @('profile-mismatch','membership-mismatch','atomic-receipt-missing','staging-proof-invalid','permanent-auth')
  if ($permanent) {
    $expectedKind=if ($scenario -eq 'permanent-auth') {'service_access'} else {'verification'}
    Assert-True ($incidents[0].kind -ceq $expectedKind -and $incidents[0].immediate) "$scenario is genuine invalid evidence or access failure and must retain immediate attention"
  } else {
    Assert-True ($incidents[0].kind -ceq 'sync_delayed' -and -not $incidents[0].immediate) "$scenario is an expected retryable hourly delay, not an immediate failed email"
    if ($null -eq $stableDelayKey) { $stableDelayKey=$incidents[0].key } else { Assert-True ($incidents[0].key -ceq $stableDelayKey) 'Changing retry diagnostics must not create new incident identities' }
  }
  $script:ExchangeNotificationRunReceipts=@{}; $script:AlertMail=@(); $script:AlertCalls=@(); $script:AlertEligible=$permanent
  $delivery=Invoke-ExchangeSyncNotificationPolicy 'failed' $actualFailure.Exception.Message $details @{}
  Assert-True ($details.completedQueueRows -eq 2 -and $details.failedQueueRows -eq 0 -and $details.recipientRefreshStatus -ceq 'failed') 'Verification failure may not erase delivered rows or claim a completed verification'
  if ($permanent) { Assert-True ($delivery.Status -ceq 'delivered' -and $script:AlertMail.Count -eq 1) 'Genuine mismatch must still be deliverable immediately' }
  else {
    Assert-True ($delivery.Status -ceq 'not_required' -and $script:AlertMail.Count -eq 0) 'First expected hourly delay must be durably observed without email'
    Assert-True (-not $script:AlertCalls[0].Body.p_incidents[0].immediate -and -not $script:AlertCalls[0].Body.p_recovery_proven) 'A deferred failure must not clear prior incidents or bypass persistence'
    $script:ExchangeNotificationRunReceipts=@{}; $script:AlertEligible=$true
    $persistent=Invoke-ExchangeSyncNotificationPolicy 'failed' $actualFailure.Exception.Message $details @{}
    Assert-True ($persistent.Status -ceq 'delivered' -and $script:AlertMail.Count -eq 1) 'A genuinely persistent delay must still notify when durable history makes it eligible'
    Assert-True ($script:AlertMail[0].Html -notmatch 'OUTLOOK_FULL_READ|Synthetic|503|source-fence|checkpoint') 'Minimal team email must not expose internal retry diagnostics'
  }
}
Write-Output 'PASS: Hourly full proof and atomic activation stay fail-closed;16 actual failure scenarios use the unchanged incident/notification policy to defer expected races, budgets and temporary read/staging failures, while genuine mismatches, malformed proof and authentication failures remain immediate.'
