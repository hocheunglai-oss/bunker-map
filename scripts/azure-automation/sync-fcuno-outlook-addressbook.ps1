param(
  [object]$WebhookData,
  [switch]$LibraryOnly
)

$ErrorActionPreference = "Stop"
$ManagedMarker = "FCUNO_SHARED_ADDRESSBOOK"
$DefaultExchangeOnlineManagementVersion = "3.4.0"
$script:ExchangeOnlineConnected = $false
$script:CanonicalExchangeRows = $null
$script:CurrentQueueRunId = $null
$script:SyncLockAcquired = $false

function Get-AutomationSetting($Name) {
  $value = Get-AutomationVariable -Name $Name -ErrorAction SilentlyContinue
  if (-not $value) {
    throw "Missing Automation variable: $Name"
  }
  return $value
}

function Get-OptionalAutomationSetting($Name) {
  $value = Get-AutomationVariable -Name $Name -ErrorAction SilentlyContinue
  if ($value) { return $value }
  return $null
}

function Get-ExchangeOnlineManagementImportVersion {
  $configuredVersion = Clean-Text (Get-OptionalAutomationSetting "EXCHANGE_ONLINE_MANAGEMENT_VERSION")
  if ($configuredVersion) { return $configuredVersion }
  if ($PSVersionTable.PSVersion.Major -eq 7 -and $PSVersionTable.PSVersion -lt [version]"7.4.0") {
    return $DefaultExchangeOnlineManagementVersion
  }
  return ""
}

function Import-ExchangeOnlineManagementModule {
  $requiredVersion = Get-ExchangeOnlineManagementImportVersion
  try {
    if ($requiredVersion) {
      $required = [version]$requiredVersion
      $installed = @(Get-Module -ListAvailable -Name ExchangeOnlineManagement | Where-Object { $_.Version -eq $required })
      if (-not $installed) {
        throw "ExchangeOnlineManagement $requiredVersion is not imported into this Automation account runtime."
      }
      Import-Module -Name ExchangeOnlineManagement -RequiredVersion $requiredVersion -Force -ErrorAction Stop
      return
    }

    if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
      throw "ExchangeOnlineManagement is not imported into this Automation account runtime."
    }
    Import-Module -Name ExchangeOnlineManagement -Force -ErrorAction Stop
  } catch {
    if ($requiredVersion) {
      throw "Could not import ExchangeOnlineManagement. The runbook is using PowerShell $($PSVersionTable.PSVersion), so this script expects ExchangeOnlineManagement $requiredVersion. Import that exact module version into the Automation account for this runtime, or move the runbook to PowerShell 7.4 and import a current ExchangeOnlineManagement module. Also upload PowerShellGet and PackageManagement for ExchangeOnlineManagement 3.x in Azure Automation. Original error: $($_.Exception.Message)"
    }
    throw "Could not import ExchangeOnlineManagement. Import ExchangeOnlineManagement, PowerShellGet, and PackageManagement into the Automation account for this runtime. Original error: $($_.Exception.Message)"
  }
}

function Invoke-SupabaseRest($Method, $Path, $Body = $null) {
  $supabaseUrl = Get-NormalizedAutomationUrl "NEXT_PUBLIC_SUPABASE_URL"
  $serviceRoleKey = Get-AutomationSetting "SUPABASE_SERVICE_ROLE_KEY"
  $headers = @{
    apikey = $serviceRoleKey
    "User-Agent" = "fcuno-azure-automation-runbook/1.0"
  }
  if ($serviceRoleKey -notmatch "^sb_(secret|publishable)_") {
    $headers["Authorization"] = "Bearer $serviceRoleKey"
  }
  $uri = "$supabaseUrl/rest/v1/$Path"
  if ($Body) {
    $headers["Content-Type"] = "application/json"
    if ($Method -eq "POST") {
      $headers["Prefer"] = "resolution=merge-duplicates"
    } elseif ($Method -eq "PATCH") {
      $headers["Prefer"] = "return=representation"
    }
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body ($Body | ConvertTo-Json -Depth 20)
  }
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers
}

function Clean-Text($Value) {
  if ($null -eq $Value) { return "" }
  return ([string]$Value -replace "\s+", " ").Trim()
}

function Get-NormalizedAutomationUrl($Name) {
  $value = (Clean-Text (Get-AutomationSetting $Name))
  if ($value -match "^\s*$([regex]::Escape($Name))\s*=\s*(.+)\s*$") {
    $value = (Clean-Text $Matches[1])
  }
  $value = $value.Trim('"').Trim("'").TrimEnd("/")

  $uri = $null
  if (-not [System.Uri]::TryCreate($value, [System.UriKind]::Absolute, [ref]$uri) -or -not $uri.Host -or ($uri.Scheme -notin @("http", "https"))) {
    throw "Automation variable $Name must be a full URL like https://your-project.supabase.co. Store only the URL value, without $Name= and without quotes."
  }

  return $value
}

function Test-GuidText($Value) {
  $guid = [Guid]::Empty
  return [Guid]::TryParse((Clean-Text $Value), [ref]$guid)
}

function Assert-ExchangeSettings($AppId, $TenantId, $Organization) {
  if (-not (Test-GuidText $AppId)) {
    throw "Automation variable EXCHANGE_APP_ID must be the Entra application/client ID GUID."
  }
  if ($TenantId -and -not (Test-GuidText $TenantId)) {
    throw "Automation variable EXCHANGE_TENANT_ID must be the Entra directory/tenant ID GUID only, without .onmicrosoft.com."
  }
  if ((Clean-Text $Organization) -match "^[0-9a-fA-F-]{36}\.onmicrosoft\.com$") {
    throw "Automation variable EXCHANGE_ORGANIZATION is set to a GUID-based .onmicrosoft.com value. Use the tenant primary domain, for example fcuno.onmicrosoft.com, or the tenant ID GUID alone. Do not use the application/client ID here."
  }
}

function Normalize-Email($Value) {
  $text = (Clean-Text $Value).ToLowerInvariant()
  $text = $text -replace "^[Ss][Mm][Tt][Pp]:", ""
  return $text
}

function Test-ValidEmail($Value) {
  $email = Normalize-Email $Value
  if (-not $email -or $email.Length -gt 254) { return $false }
  $parts = @($email.Split("@"))
  if ($parts.Count -ne 2) { return $false }
  $localPart = $parts[0]
  $domainPart = $parts[1]
  if (-not $localPart -or $localPart.Length -gt 64 -or $localPart.StartsWith(".") -or $localPart.EndsWith(".") -or $localPart.Contains("..")) { return $false }
  if ($localPart -notmatch "^[a-z0-9!#$%&'*+/=?^_``{|}~.-]+$") { return $false }
  $labels = @($domainPart.Split("."))
  if ($labels.Count -lt 2) { return $false }
  foreach ($label in $labels) {
    if (-not $label -or $label.Length -gt 63 -or $label -notmatch "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$") { return $false }
  }
  try {
    $parsed = [System.Net.Mail.MailAddress]::new($email)
    return (Normalize-Email $parsed.Address) -eq $email
  } catch {
    return $false
  }
}

function Escape-ExchangeFilterValue($Value) {
  return (Clean-Text $Value).Replace("'", "''")
}

function Get-ContactSourceKey($SourceContactId) {
  $sourceId = Clean-Text $SourceContactId
  if (-not $sourceId) { return "" }
  return "FCUNO_CONTACT:$sourceId"
}

function Get-GroupSourceKey($SourceGroupId) {
  $sourceId = Clean-Text $SourceGroupId
  if (-not $sourceId) { return "" }
  return "FCUNO_GROUP:$sourceId"
}

function Has-MapKey($Map, [string]$Key) {
  if (-not $Map -or -not $Key) { return $false }
  if ($Map -is [hashtable] -or $Map -is [System.Collections.IDictionary]) {
    return $Map.ContainsKey($Key)
  }
  $property = $Map.PSObject.Properties[$Key]
  return $null -ne $property
}

function Get-MapValue($Map, [string]$Key) {
  if (-not (Has-MapKey $Map $Key)) { return $null }
  if ($Map -is [hashtable] -or $Map -is [System.Collections.IDictionary]) {
    return $Map[$Key]
  }
  return $Map.PSObject.Properties[$Key].Value
}

function Get-RecipientEmail($Recipient) {
  if ($null -eq $Recipient) { return "" }
  $candidates = @(
    $Recipient.ExternalEmailAddress,
    $Recipient.PrimarySmtpAddress,
    $Recipient.WindowsEmailAddress,
    $Recipient.UserPrincipalName
  )
  foreach ($candidate in $candidates) {
    $email = Normalize-Email $candidate
    if ($email -match "@") { return $email }
  }
  return ""
}

function Set-ExchangeContactProfile($Identity, $Contact) {
  $profile = @{
    Identity = $Identity
    Name = $Contact.DisplayName
    DisplayName = $Contact.DisplayName
    FirstName = $(if (Clean-Text $Contact.FirstName) { Clean-Text $Contact.FirstName } else { $null })
    LastName = $(if (Clean-Text $Contact.LastName) { Clean-Text $Contact.LastName } else { $null })
    ErrorAction = "Stop"
  }
  Set-Contact @profile
}

function Assert-ExchangeContactProfile($Identity, $Contact, $Label) {
  $expectedFirstName = Clean-Text $Contact.FirstName
  $expectedLastName = Clean-Text $Contact.LastName
  $actualFirstName = ""
  $actualLastName = ""
  for ($attempt = 1; $attempt -le 4; $attempt += 1) {
    if ($attempt -gt 1) { Start-Sleep -Seconds 2 }
    $profile = Get-Contact -Identity $Identity -ErrorAction SilentlyContinue
    if (-not $profile) { continue }
    $actualFirstName = Clean-Text $profile.FirstName
    $actualLastName = Clean-Text $profile.LastName
    if ($actualFirstName -eq $expectedFirstName -and $actualLastName -eq $expectedLastName) { return }
  }
  throw "$Label has the wrong contact profile after verification. Expected FirstName '$expectedFirstName' and LastName '$expectedLastName'; got FirstName '$actualFirstName' and LastName '$actualLastName'."
}

function Assert-ExchangeRecipientName($Recipient, $ExpectedName, $Label) {
  $expected = Clean-Text $ExpectedName
  $actualDisplayName = Clean-Text $Recipient.DisplayName
  $actualName = Clean-Text $Recipient.Name
  if ($actualDisplayName -ne $expected -or $actualName -ne $expected) {
    throw "$Label was updated but Exchange verification did not match. Expected Name/DisplayName '$expected'; got Name '$actualName' and DisplayName '$actualDisplayName'."
  }
}

function Format-HongKongTime($Value) {
  $date = [DateTimeOffset]::MinValue
  $text = Clean-Text $Value
  if ($text -and [DateTimeOffset]::TryParse($text, [ref]$date)) {
    return $date.ToUniversalTime().ToOffset([TimeSpan]::FromHours(8)).ToString("yyyy-MM-dd HH:mm:ss 'HKT'")
  }
  return (Get-Date).ToUniversalTime().AddHours(8).ToString("yyyy-MM-dd HH:mm:ss 'HKT'")
}

function Get-StatsObject($Details) {
  if (-not $Details) { return $null }
  if (Has-MapKey $Details "syncMode") { return $Details }
  foreach ($item in @($Details)) {
    if (Has-MapKey $item "syncMode") { return $item }
  }
  return $Details
}

function Get-ExchangeAlias($Value, $Fallback) {
  $base = (Clean-Text $(if ($Value) { $Value } else { $Fallback })).ToLowerInvariant()
  $base = $base -replace "&", " and "
  $base = $base -replace "[^a-z0-9._-]+", "-"
  $base = $base -replace "^[.-]+|[.-]+$", ""
  if ($base.Length -gt 58) { $base = $base.Substring(0, 58) }
  if ($base) { return $base }
  return $Fallback
}

function Get-UniqueAlias($BaseAlias, [hashtable]$SeenAliases, $StableKey = "") {
  $alias = $BaseAlias
  if (-not (Has-MapKey $SeenAliases $alias)) {
    $SeenAliases[$alias] = $true
    return $alias
  }

  $stableText = Clean-Text $StableKey
  if ($stableText) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($stableText)))).Replace("-", "").ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
    for ($hashLength = 6; $hashLength -le 20; $hashLength += 2) {
      $suffix = "-" + $hash.Substring(0, $hashLength)
      $maxLength = 64 - $suffix.Length
      $alias = $BaseAlias.Substring(0, [Math]::Min($BaseAlias.Length, $maxLength)) + $suffix
      if (-not (Has-MapKey $SeenAliases $alias)) {
        $SeenAliases[$alias] = $true
        return $alias
      }
    }
  }

  $index = 2
  while ((Has-MapKey $SeenAliases $alias)) {
    $suffix = "-$index"
    $maxLength = 64 - $suffix.Length
    $alias = $BaseAlias.Substring(0, [Math]::Min($BaseAlias.Length, $maxLength)) + $suffix
    $index += 1
  }
  $SeenAliases[$alias] = $true
  return $alias
}

function Is-InternalEmail($Email) {
  $internalDomains = @("cosulich.com.hk", "cosulich.com.sg")
  $domain = ((Clean-Text $Email).ToLowerInvariant().Split("@") | Select-Object -Last 1)
  return $internalDomains -contains $domain
}

function Load-AllRows($Table, $OrderColumn) {
  $rows = @()
  $pageSize = 1000
  $from = 0
  $orderExpression = Clean-Text $OrderColumn
  if ($orderExpression -notmatch "\.") { $orderExpression = "$orderExpression.asc" }
  while ($true) {
    $to = $from + $pageSize - 1
    $path = "$Table" + "?select=*&order=$orderExpression&offset=$from&limit=$pageSize"
    $batch = Invoke-SupabaseRest -Method "GET" -Path $path
    if ($null -eq $batch) { break }
    $rows += @($batch)
    if (@($batch).Count -lt $pageSize) { break }
    $from += $pageSize
  }
  return $rows
}

function Build-ExchangeRows($Contacts, $Groups, $Members) {
  $seenEmails = @{}
  $seenAliases = @{}
  $contactRows = @()
  $contactById = @{}
  $contactByEmail = @{}
  $contactIdsByEmail = @{}
  $invalidContacts = @()
  $duplicateContacts = @()

  $orderedContacts = @($Contacts | Sort-Object `
    @{ Expression = { Normalize-Email $_.primary_email }; Ascending = $true }, `
    @{ Expression = {
      $updated = [DateTimeOffset]::MinValue
      if ([DateTimeOffset]::TryParse((Clean-Text $_.updated_at), [ref]$updated)) { return $updated }
      return [DateTimeOffset]::MinValue
    }; Descending = $true }, `
    @{ Expression = { Clean-Text $_.id }; Ascending = $true })

  foreach ($contact in $orderedContacts) {
    $email = Normalize-Email $contact.primary_email
    if (-not (Test-ValidEmail $email)) {
      $invalidContacts += [pscustomobject]@{
        SourceContactId = Clean-Text $contact.id
        DisplayName = Clean-Text $contact.display_name
        Email = $email
        Reason = "Invalid external email address"
      }
      continue
    }

    if (Has-MapKey $seenEmails $email) {
      $canonical = $seenEmails[$email]
      $contactById[(Clean-Text $contact.id)] = $canonical
      $contactIdsByEmail[$email] = @($contactIdsByEmail[$email]) + (Clean-Text $contact.id)
      $duplicateContacts += [pscustomobject]@{
        SourceContactId = Clean-Text $contact.id
        CanonicalSourceContactId = Clean-Text $canonical.SourceContactId
        Email = $email
      }
      continue
    }

    $displayName = Clean-Text $(if ($contact.display_name) { $contact.display_name } else { $email })
    $aliasSeed = if ($contact.nickname) { $contact.nickname } else { $displayName }
    $baseAlias = Get-ExchangeAlias $aliasSeed "contact-$($contactRows.Count + 1)"
    $row = [pscustomobject]@{
      SourceBook = Clean-Text $contact.source_book
      SourceContactId = $contact.id
      DisplayName = $displayName
      FirstName = Clean-Text $contact.first_name
      LastName = Clean-Text $contact.last_name
      BaseAlias = $baseAlias
      Alias = Get-UniqueAlias $baseAlias $seenAliases ("contact:" + (Clean-Text $contact.id))
      ExternalEmailAddress = $email
      Nickname = Clean-Text $contact.nickname
      SourceKey = Get-ContactSourceKey $contact.id
    }

    if (-not (Is-InternalEmail $email)) { $contactRows += $row }
    $seenEmails[$email] = $row
    $contactByEmail[$email] = $row
    $contactIdsByEmail[$email] = @((Clean-Text $contact.id))
    $contactById[(Clean-Text $contact.id)] = $row
  }

  $groupRows = @()
  $orderedGroups = @($Groups | Sort-Object `
    @{ Expression = { (Clean-Text $(if ($_.nickname) { $_.nickname } else { $_.name })).ToLowerInvariant() }; Ascending = $true }, `
    @{ Expression = { Clean-Text $_.id }; Ascending = $true })
  foreach ($group in $orderedGroups) {
    $name = Clean-Text $(if ($group.name) { $group.name } elseif ($group.nickname) { $group.nickname } else { $group.source_uid })
    if (-not $name) { continue }
    $aliasSeed = if ($group.nickname) { $group.nickname } else { $name }
    $baseAlias = Get-ExchangeAlias $aliasSeed "group-$($groupRows.Count + 1)"
    $groupRows += [pscustomobject]@{
      SourceBook = Clean-Text $group.source_book
      SourceGroupId = $group.id
      GroupName = $name
      BaseAlias = $baseAlias
      Alias = Get-UniqueAlias $baseAlias $seenAliases ("group:" + (Clean-Text $group.id))
      Description = Clean-Text $group.description
      MemberCount = 0
      SourceKey = Get-GroupSourceKey $group.id
    }
  }

  $groupById = @{}
  foreach ($groupRow in $groupRows) { $groupById[$groupRow.SourceGroupId] = $groupRow }
  $seenMembers = @{}
  $memberRows = @()

  $orderedMembers = @($Members | Sort-Object `
    @{ Expression = { Clean-Text $_.group_id }; Ascending = $true }, `
    @{ Expression = { Clean-Text $_.contact_id }; Ascending = $true })
  foreach ($member in $orderedMembers) {
    $group = $groupById[$member.group_id]
    $contact = $contactById[$member.contact_id]
    if (-not $group -or -not $contact) { continue }
    $key = "$($group.Alias)`0$($contact.ExternalEmailAddress)"
    if ((Has-MapKey $seenMembers $key)) { continue }
    $seenMembers[$key] = $true
    $group.MemberCount = [int]$group.MemberCount + 1
    $memberRows += [pscustomobject]@{
      GroupName = $group.GroupName
      GroupAlias = $group.Alias
      MemberDisplayName = $contact.DisplayName
      MemberEmail = $contact.ExternalEmailAddress
      SourceGroupId = Clean-Text $member.group_id
      SourceContactId = Clean-Text $member.contact_id
    }
  }

  return @{
    Contacts = $contactRows
    Groups = @($groupRows | Where-Object { [int]$_.MemberCount -gt 0 })
    Members = $memberRows
    ContactById = $contactById
    ContactByEmail = $contactByEmail
    ContactIdsByEmail = $contactIdsByEmail
    GroupById = $groupById
    InvalidContacts = $invalidContacts
    DuplicateContacts = $duplicateContacts
  }
}

function Get-CanonicalExchangeRows {
  if ($script:CanonicalExchangeRows) { return $script:CanonicalExchangeRows }
  $contacts = Load-AllRows "shared_addressbook_contacts" "primary_email.asc,updated_at.desc,id.asc"
  $groups = Load-AllRows "shared_addressbook_groups" "name.asc,id.asc"
  $members = Load-AllRows "shared_addressbook_group_members" "group_id.asc,contact_id.asc"
  $script:CanonicalExchangeRows = Build-ExchangeRows $contacts $groups $members
  return $script:CanonicalExchangeRows
}

function Sync-ExchangeAliasPeers($BaseAlias, [hashtable]$Stats) {
  $base = Clean-Text $BaseAlias
  if (-not $base) { return }
  $rows = Get-CanonicalExchangeRows
  $peers = @()
  foreach ($contact in @($rows.Contacts | Where-Object { (Clean-Text $_.BaseAlias).Equals($base, [StringComparison]::OrdinalIgnoreCase) })) {
    $peers += [pscustomobject]@{ Kind = "contact"; Value = $contact }
  }
  foreach ($group in @($rows.Groups | Where-Object { (Clean-Text $_.BaseAlias).Equals($base, [StringComparison]::OrdinalIgnoreCase) })) {
    $peers += [pscustomobject]@{ Kind = "group"; Value = $group }
  }
  if ($peers.Count -le 1) { return }

  $orderedPeers = @($peers | Sort-Object `
    @{ Expression = { if ((Clean-Text $_.Value.Alias).Equals($base, [StringComparison]::OrdinalIgnoreCase)) { 1 } else { 0 } }; Ascending = $true }, `
    @{ Expression = { Clean-Text $_.Value.SourceKey }; Ascending = $true })
  foreach ($peer in $orderedPeers) {
    if ($peer.Kind -eq "contact") {
      Upsert-ExchangeMailContact $peer.Value $Stats
    } else {
      Upsert-ExchangeDistributionGroup $peer.Value $Stats
    }
  }
}

function Save-SyncStatus($Status, $Message, $Details = $null) {
  $payload = @{
    key = "outlook-addressbook-exchange-sync"
    payload = @{
      status = $Status
      message = $Message
      requestedAt = (Get-Date).ToUniversalTime().ToString("o")
      response = $Details
    }
    updated_at = (Get-Date).ToUniversalTime().ToString("o")
  }
  Invoke-SupabaseRest -Method "POST" -Path "office_calendar_store?on_conflict=key" -Body $payload | Out-Null
}

function Encode-QueryValue($Value) {
  return [System.Uri]::EscapeDataString([string](Clean-Text $Value))
}

function Increment-Stat([hashtable]$Stats, $Name, $By = 1) {
  if (-not (Has-MapKey $Stats $Name)) { $Stats[$Name] = 0 }
  $Stats[$Name] = [int]$Stats[$Name] + [int]$By
}

function Load-SingleRow($Table, $Column, $Value) {
  $cleanValue = Clean-Text $Value
  if (-not $cleanValue) { return $null }
  $encodedValue = Encode-QueryValue $cleanValue
  $path = "$Table" + "?select=*&$Column=eq.$encodedValue&limit=1"
  $rows = Invoke-SupabaseRest -Method "GET" -Path $path
  $items = @($rows)
  if ($items.Count -gt 0) { return $items[0] }
  return $null
}

function Load-RowsByColumn($Table, $Column, $Value, $OrderColumn = "updated_at") {
  $cleanValue = Clean-Text $Value
  if (-not $cleanValue) { return @() }
  $encodedValue = Encode-QueryValue $cleanValue
  $path = "$Table" + "?select=*&$Column=eq.$encodedValue&order=$OrderColumn.asc"
  $rows = Invoke-SupabaseRest -Method "GET" -Path $path
  return @($rows)
}

function Claim-ExchangeQueueRows($Limit = 200) {
  if (-not $script:CurrentQueueRunId) {
    $script:CurrentQueueRunId = [Guid]::NewGuid().ToString()
  }
  $rows = Invoke-SupabaseRest -Method "POST" -Path "rpc/claim_outlook_exchange_sync_queue" -Body @{
    p_run_id = $script:CurrentQueueRunId
    p_limit = [int]$Limit
  }
  return @($rows)
}

function Acquire-ExchangeSyncLock($SyncMode) {
  if (-not $script:CurrentQueueRunId) { $script:CurrentQueueRunId = [Guid]::NewGuid().ToString() }
  $result = Invoke-SupabaseRest -Method "POST" -Path "rpc/acquire_outlook_exchange_sync_lock" -Body @{
    p_run_id = $script:CurrentQueueRunId
    p_sync_mode = Clean-Text $SyncMode
    p_lease_minutes = 30
  }
  return [bool]$result
}

function Renew-ExchangeSyncLock {
  if (-not $script:CurrentQueueRunId) { throw "Cannot renew the Exchange sync lock without a run ID." }
  $result = Invoke-SupabaseRest -Method "POST" -Path "rpc/renew_outlook_exchange_sync_lock" -Body @{
    p_run_id = $script:CurrentQueueRunId
    p_lease_minutes = 30
  }
  if (-not [bool]$result) { throw "The Exchange sync job lost its global mutation lease." }
}

function Release-ExchangeSyncLock {
  if (-not $script:CurrentQueueRunId -or -not $script:SyncLockAcquired) { return }
  try {
    Invoke-SupabaseRest -Method "POST" -Path "rpc/release_outlook_exchange_sync_lock" -Body @{
      p_run_id = $script:CurrentQueueRunId
    } | Out-Null
  } finally {
    $script:SyncLockAcquired = $false
  }
}

function Get-ExchangeQueueBacklogCount {
  $rows = Invoke-SupabaseRest -Method "GET" -Path "outlook_exchange_sync_queue?select=id&or=(status.eq.pending,status.eq.processing,status.eq.failed)&limit=1000"
  return @($rows).Count
}

function Update-ExchangeQueueRow($RowId, [hashtable]$Fields) {
  if (-not $script:CurrentQueueRunId) { throw "Exchange queue row cannot be updated without an active run ID." }
  $Fields["updated_at"] = (Get-Date).ToUniversalTime().ToString("o")
  $encodedId = Encode-QueryValue $RowId
  $encodedRunId = Encode-QueryValue $script:CurrentQueueRunId
  $updated = @(Invoke-SupabaseRest -Method "PATCH" -Path "outlook_exchange_sync_queue?id=eq.$encodedId&run_id=eq.$encodedRunId&status=eq.processing&select=id" -Body $Fields)
  if ($updated.Count -ne 1) {
    throw "Exchange queue row $RowId lost its processing lease before status could be saved."
  }
}

function Get-ContactExchangeRowFromSource($SourceContactId) {
  $sourceId = Clean-Text $SourceContactId
  if (-not $sourceId) { return $null }
  $rows = Get-CanonicalExchangeRows
  if (-not (Has-MapKey $rows.ContactById $sourceId)) { return $null }
  $contact = $rows.ContactById[$sourceId]
  if ($contact -and -not (Is-InternalEmail $contact.ExternalEmailAddress)) { return $contact }
  return $null
}

function Get-GroupExchangeRowsFromSource($GroupId) {
  $sourceId = Clean-Text $GroupId
  if (-not $sourceId) { return $null }
  $rows = Get-CanonicalExchangeRows
  if (-not (Has-MapKey $rows.GroupById $sourceId)) { return $null }
  $group = $rows.GroupById[$sourceId]
  $members = @($rows.Members | Where-Object { (Clean-Text $_.SourceGroupId) -eq $sourceId })
  return @{
    Groups = $(if ([int]$group.MemberCount -gt 0) { @($group) } else { @() })
    Members = $members
  }
}

function Get-QueuePayloadValue($Row, $ObjectName, $PropertyName) {
  if (-not $Row -or -not $Row.payload) { return "" }
  $object = $Row.payload.$ObjectName
  if (-not $object) { return "" }
  return Clean-Text $object.$PropertyName
}

function Get-QueueChangeSummary($Row) {
  $action = Clean-Text $Row.action
  $name = Clean-Text $Row.display_name
  if (-not $name) { $name = Get-QueuePayloadValue $Row "contact" "DisplayName" }
  if (-not $name) { $name = Get-QueuePayloadValue $Row "group" "GroupName" }
  if (-not $name) { $name = Clean-Text $Row.entity_email }
  if (-not $name) { $name = Clean-Text $Row.entity_alias }
  if (-not $name) { $name = Clean-Text $Row.entity_id }
  if (-not $name) { $name = "Unknown item" }

  switch ($action) {
    "create_contact" { return "Created contact: $name" }
    "update_contact" { return "Updated contact: $name" }
    "delete_contact" { return "Deleted contact: $name" }
    "create_group" { return "Created group: $name" }
    "update_group" { return "Updated group: $name" }
    "delete_group" { return "Deleted group: $name" }
    "update_group_members" { return "Updated group members: $name" }
    default { return "Updated: $name" }
  }
}

function Get-QueueDisplayName($Row) {
  $name = Clean-Text $Row.display_name
  if (-not $name) { $name = Get-QueuePayloadValue $Row "contact" "DisplayName" }
  if (-not $name) { $name = Get-QueuePayloadValue $Row "group" "GroupName" }
  if (-not $name) { $name = Clean-Text $Row.entity_email }
  if (-not $name) { $name = Clean-Text $Row.entity_alias }
  if (-not $name) { $name = Clean-Text $Row.entity_id }
  if (-not $name) { $name = "Unknown item" }
  return $name
}

function Get-QueueActionLabel($Action) {
  switch (Clean-Text $Action) {
    "create_contact" { return "Create contact" }
    "update_contact" { return "Update contact" }
    "delete_contact" { return "Delete contact" }
    "create_group" { return "Create group" }
    "update_group" { return "Update group" }
    "delete_group" { return "Delete group" }
    "update_group_members" { return "Update group members" }
    default {
      $label = (Clean-Text $Action) -replace "_", " "
      if (-not $label) { return "Unknown action" }
      return $label
    }
  }
}

function Get-QueueEntityLabel($EntityType) {
  switch (Clean-Text $EntityType) {
    "contact" { return "Contact" }
    "group" { return "Group" }
    "group_members" { return "Group members" }
    "full_sync" { return "Full address book" }
    default {
      $label = (Clean-Text $EntityType) -replace "_", " "
      if (-not $label) { return "Item" }
      return $label
    }
  }
}

function Get-QueueIdentifier($Row) {
  $email = Normalize-Email $Row.entity_email
  if (-not $email) { $email = Normalize-Email (Get-QueuePayloadValue $Row "contact" "ExternalEmailAddress") }
  $alias = Clean-Text $Row.entity_alias
  if (-not $alias) { $alias = Get-QueuePayloadValue $Row "contact" "Alias" }
  if (-not $alias) { $alias = Get-QueuePayloadValue $Row "group" "Alias" }

  if ($email -and $alias) { return "$email / $alias" }
  if ($email) { return $email }
  if ($alias) { return $alias }
  return Clean-Text $Row.entity_id
}

function Get-PayloadProperty($Object, $PropertyName) {
  if (-not $Object) { return "" }
  $property = $Object.PSObject.Properties[$PropertyName]
  if (-not $property) { return "" }
  return Clean-Text $property.Value
}

function Get-QueueFieldChanges($Row) {
  if (-not $Row -or -not $Row.payload) { return @() }
  $before = $null
  $after = $null
  $labels = @{}
  switch (Clean-Text $Row.entity_type) {
    "contact" {
      $before = $Row.payload.beforeContact
      $after = $Row.payload.afterContact
      $labels = [ordered]@{
        display_name = "Display name"
        primary_email = "Email"
        nickname = "Nickname / alias seed"
        first_name = "First name"
        last_name = "Last name"
        source_book = "Source book"
      }
    }
    "group" {
      $before = $Row.payload.beforeGroup
      $after = $Row.payload.afterGroup
      $labels = [ordered]@{
        name = "Group name"
        nickname = "Nickname / alias seed"
        description = "Description"
        source_book = "Source book"
      }
    }
    "group_members" {
      $before = $Row.payload.beforeMember
      $after = $Row.payload.afterMember
      $contactName = Get-PayloadProperty $Row.payload.contact "display_name"
      $contactEmail = Normalize-Email (Get-PayloadProperty $Row.payload.contact "primary_email")
      $contactId = Get-PayloadProperty $(if ($after) { $after } else { $before }) "contact_id"
      $memberLabel = Clean-Text $(if ($contactName) { $contactName } else { $contactId })
      if ($contactEmail) { $memberLabel += " <$contactEmail>" }
      if (-not $before -and $after) { return @("Member: Added $memberLabel") }
      if ($before -and -not $after) { return @("Member: Removed $memberLabel") }
      $labels = [ordered]@{ contact_id = "Member contact ID"; group_id = "Group ID" }
    }
  }

  $changes = @()
  foreach ($field in $labels.Keys) {
    $oldValue = Get-PayloadProperty $before $field
    $newValue = Get-PayloadProperty $after $field
    if ($oldValue -eq $newValue) { continue }
    $oldLabel = if ($oldValue) { $oldValue } else { "(blank)" }
    $newLabel = if ($newValue) { $newValue } else { "(blank)" }
    $changes += "$($labels[$field]): $oldLabel -> $newLabel"
  }
  return $changes
}

function Add-SyncChangeDetail([hashtable]$Stats, $Row, $Status, $Result) {
  if (-not (Has-MapKey $Stats "changeDetails")) { $Stats["changeDetails"] = @() }
  $Stats["changeDetails"] = @($Stats["changeDetails"]) + [pscustomobject]@{
    status = (Clean-Text $Status).ToLowerInvariant()
    action = Clean-Text $Row.action
    actionLabel = Get-QueueActionLabel $Row.action
    entityType = Get-QueueEntityLabel $Row.entity_type
    displayName = Get-QueueDisplayName $Row
    identifier = Get-QueueIdentifier $Row
    result = Clean-Text $Result
    queueRowId = Clean-Text $Row.id
    eventId = Clean-Text $Row.event_id
    actorId = Clean-Text $Row.actor_id
    requestedBy = Clean-Text $Row.requested_by
    queuedAt = Format-HongKongTime $Row.created_at
    attempt = [Math]::Max(1, [int]$Row.attempts)
    fieldChanges = @(Get-QueueFieldChanges $Row)
    auditLogIds = @($Row.audit_log_ids | ForEach-Object { Clean-Text $_ } | Where-Object { $_ })
    changeSetIds = @($Row.change_set_ids | ForEach-Object { Clean-Text $_ } | Where-Object { $_ })
  }
}

function Add-SyncChange([hashtable]$Stats, $Row) {
  $summary = Get-QueueChangeSummary $Row
  if (-not $summary) { return }
  if (-not (Has-MapKey $Stats "changes")) { $Stats["changes"] = @() }
  $Stats["changes"] = @($Stats["changes"]) + $summary
}

function Get-QueueCounterSnapshot([hashtable]$Stats) {
  $snapshot = @{}
  foreach ($key in @("skippedQueueRows", "verifiedQueueRows", "createdContacts", "updatedContacts", "removedContacts", "createdGroups", "updatedGroups", "removedGroups", "addedMembers", "removedMembers")) {
    $value = 0
    if ((Has-MapKey $Stats $key)) { $value = [int](Get-MapValue $Stats $key) }
    $snapshot[$key] = $value
  }
  $addedMemberEmails = @()
  $removedMemberEmails = @()
  if ((Has-MapKey $Stats "addedMemberEmails")) { $addedMemberEmails = @(Get-MapValue $Stats "addedMemberEmails") }
  if ((Has-MapKey $Stats "removedMemberEmails")) { $removedMemberEmails = @(Get-MapValue $Stats "removedMemberEmails") }
  $snapshot["addedMemberEmailsCount"] = $addedMemberEmails.Count
  $snapshot["removedMemberEmailsCount"] = $removedMemberEmails.Count
  return $snapshot
}

function Get-QueueCounterDelta([hashtable]$Before, [hashtable]$After, $Name) {
  $beforeValue = 0
  $afterValue = 0
  if ((Has-MapKey $Before $Name)) { $beforeValue = [int](Get-MapValue $Before $Name) }
  if ((Has-MapKey $After $Name)) { $afterValue = [int](Get-MapValue $After $Name) }
  return $afterValue - $beforeValue
}

function Get-QueueNewValues([hashtable]$Before, [hashtable]$After, $Name) {
  $countKey = "$Name" + "Count"
  $startIndex = 0
  if ((Has-MapKey $Before $countKey)) { $startIndex = [int](Get-MapValue $Before $countKey) }
  $values = @()
  if ((Has-MapKey $After $Name)) { $values = @(Get-MapValue $After $Name) }
  if ($values.Count -le $startIndex) { return @() }

  $newValues = @()
  for ($index = $startIndex; $index -lt $values.Count; $index += 1) {
    $value = Clean-Text $values[$index]
    if ($value) { $newValues += $value }
  }
  return $newValues
}

function Get-QueueMemberChangeMessage([hashtable]$Before, [hashtable]$After) {
  $parts = @()
  $addedEmails = @(Get-QueueNewValues $Before $After "addedMemberEmails")
  $removedEmails = @(Get-QueueNewValues $Before $After "removedMemberEmails")
  if ($addedEmails.Count -gt 0) { $parts += "Added member(s): $($addedEmails -join ', ')" }
  if ($removedEmails.Count -gt 0) { $parts += "Removed member(s): $($removedEmails -join ', ')" }
  return ($parts -join ". ")
}

function Get-QueueResultMessage($Row, [hashtable]$Before, [hashtable]$After) {
  $action = Clean-Text $Row.action
  $createdContacts = Get-QueueCounterDelta $Before $After "createdContacts"
  $updatedContacts = Get-QueueCounterDelta $Before $After "updatedContacts"
  $removedContacts = Get-QueueCounterDelta $Before $After "removedContacts"
  $createdGroups = Get-QueueCounterDelta $Before $After "createdGroups"
  $updatedGroups = Get-QueueCounterDelta $Before $After "updatedGroups"
  $removedGroups = Get-QueueCounterDelta $Before $After "removedGroups"
  $verified = Get-QueueCounterDelta $Before $After "verifiedQueueRows"
  $memberChanges = Get-QueueMemberChangeMessage $Before $After

  switch ($action) {
    "create_contact" {
      if ($createdContacts -gt 0) { return "Created the contact in Exchange and verified it." }
      if ($updatedContacts -gt 0) { return "The contact already existed; updated it in Exchange and verified it." }
      if ($verified -gt 0) { return "Verified the contact in Exchange; no creation was required." }
    }
    "update_contact" {
      if ($createdContacts -gt 0) { return "The contact was missing; created it in Exchange and verified it." }
      if ($updatedContacts -gt 0) { return "Updated the contact in Exchange and verified it." }
      if ($verified -gt 0) { return "Verified the contact in Exchange; no profile update was required." }
    }
    "delete_contact" {
      if ($removedContacts -gt 0) { return "Deleted the managed contact from Exchange and verified its removal." }
      if ($verified -gt 0) { return "The contact was already absent from Exchange; verified that no deletion was required." }
    }
    "create_group" {
      $groupResult = ""
      if ($removedGroups -gt 0) { return "The source group was missing or had no eligible members; deleted the managed group from Exchange and verified its removal." }
      if ($createdGroups -gt 0) { $groupResult = "Created the group in Exchange and verified it." }
      elseif ($updatedGroups -gt 0) { $groupResult = "The group already existed; updated it in Exchange and verified it." }
      elseif ($verified -gt 0) { $groupResult = "The source group was missing or had no eligible members, and the Exchange group was already absent; verified that no deletion was required." }
      if ($memberChanges) { return "$groupResult $memberChanges." }
      if ($groupResult) { return $groupResult }
    }
    "update_group" {
      $groupResult = ""
      if ($removedGroups -gt 0) { return "The source group was missing or had no eligible members; deleted the managed group from Exchange and verified its removal." }
      if ($createdGroups -gt 0) { $groupResult = "The group was missing; created it in Exchange and verified it." }
      elseif ($updatedGroups -gt 0) { $groupResult = "Updated the group in Exchange and verified it." }
      elseif ($verified -gt 0) { $groupResult = "The source group was missing or had no eligible members, and the Exchange group was already absent; verified that no deletion was required." }
      if ($memberChanges) { return "$groupResult $memberChanges." }
      if ($groupResult) { return $groupResult }
    }
    "delete_group" {
      if ($removedGroups -gt 0) { return "Deleted the managed group from Exchange and verified its removal." }
      if ($verified -gt 0) { return "The group was already absent from Exchange; verified that no deletion was required." }
    }
    "update_group_members" {
      $parts = @()
      if ($removedGroups -gt 0) { return "The source group was missing or had no eligible members; deleted the managed group from Exchange and verified its removal." }
      if ($createdGroups -gt 0) { $parts += "created the group" }
      if ($updatedGroups -gt 0) { $parts += "updated the group" }
      $groupResult = ""
      if ($parts.Count -gt 0) {
        $groupText = $parts -join ", "
        $groupResult = $groupText.Substring(0, 1).ToUpperInvariant() + $groupText.Substring(1) + "."
      }
      if (-not $groupResult -and $verified -gt 0) { return "The source group was missing or had no eligible members, and the Exchange group was already absent; verified that no deletion was required." }
      if ($memberChanges) { return "$groupResult $memberChanges." }
      if ($groupResult) { return "$groupResult No membership change was required." }
    }
  }

  return "Exchange processing completed for this queue row."
}

function Get-QueuePartialProgressMessage([hashtable]$Before, [hashtable]$After) {
  if (-not $Before) { return "" }
  $parts = @()
  $counterLabels = @{
    createdContacts = "created contact(s)"
    updatedContacts = "updated contact(s)"
    removedContacts = "removed contact(s)"
    createdGroups = "created group(s)"
    updatedGroups = "updated group(s)"
    removedGroups = "removed group(s)"
  }
  foreach ($key in @("createdContacts", "updatedContacts", "removedContacts", "createdGroups", "updatedGroups", "removedGroups")) {
    $delta = Get-QueueCounterDelta $Before $After $key
    if ($delta -gt 0) { $parts += "$delta $($counterLabels[$key])" }
  }
  $memberChanges = Get-QueueMemberChangeMessage $Before $After
  if ($memberChanges) { $parts += $memberChanges }
  if ($parts.Count -le 0) { return "" }
  return "Before the failure, Exchange reported: $($parts -join '; ')."
}

function Get-QueueSkipReason($Row) {
  switch (Clean-Text $Row.action) {
    "create_contact" { return "Skipped because the source contact was missing, internal-only, or had no eligible external email address." }
    "update_contact" { return "Skipped because the source contact was missing, internal-only, or had no eligible external email address." }
    "create_group" { return "Skipped because the source group had no usable Exchange alias." }
    "update_group" { return "Skipped because the source group had no usable Exchange alias." }
    "update_group_members" { return "Skipped because the source group had no usable Exchange alias or eligible membership state." }
    "delete_group" { return "Skipped because the queued group deletion had no usable Exchange alias." }
    default { return "Skipped because the queue row did not contain enough eligible data for an Exchange change." }
  }
}

function Upsert-ExchangeMailContact($Contact, [hashtable]$Stats) {
  if (-not $Contact) {
    Increment-Stat $Stats "skippedQueueRows"
    return
  }

  $email = Normalize-Email $Contact.ExternalEmailAddress
  if (-not (Test-ValidEmail $email)) { throw "Invalid Exchange email address '$email' for $($Contact.DisplayName)." }
  $sourceKey = Clean-Text $Contact.SourceKey
  $escapedSourceKey = Escape-ExchangeFilterValue $sourceKey
  $escapedEmail = Escape-ExchangeFilterValue $email
  $sourceMatches = @()
  if ($sourceKey) {
    $sourceMatches = @(Get-MailContact -Filter "CustomAttribute2 -eq '$escapedSourceKey'" -ResultSize Unlimited -ErrorAction SilentlyContinue)
    if ($sourceMatches.Count -gt 1) { throw "More than one Exchange contact is tagged with source key $sourceKey." }
  }
  $existing = if ($sourceMatches.Count -eq 1) { $sourceMatches[0] } else { $null }
  if (-not $existing) {
    $emailMatches = @(Get-MailContact -Filter "ExternalEmailAddress -eq '$escapedEmail'" -ResultSize Unlimited -ErrorAction SilentlyContinue)
    if ($emailMatches.Count -gt 1) { throw "More than one Exchange contact uses $email." }
    if ($emailMatches.Count -eq 1) { $existing = $emailMatches[0] }
  }

  if ($existing) {
    $identity = $existing.Identity
    try {
      Set-MailContact -Identity $identity -ExternalEmailAddress $email -Alias $Contact.Alias -CustomAttribute1 $ManagedMarker -CustomAttribute2 $sourceKey -HiddenFromAddressListsEnabled $false -ErrorAction Stop
      Set-ExchangeContactProfile $identity $Contact
    } catch {
      if ((Clean-Text $existing.CustomAttribute1) -eq $ManagedMarker) {
        Write-Warning ("Existing Exchange contact {0} could not be updated by identity {1}; recreating it. Original error: {2}" -f $email, $identity, $_.Exception.Message)
        Remove-MailContact -Identity $identity -Confirm:$false -ErrorAction SilentlyContinue
        $newContact = New-MailContact -Name $Contact.DisplayName -DisplayName $Contact.DisplayName -ExternalEmailAddress $email -Alias $Contact.Alias -ErrorAction Stop
        $identity = $newContact.Identity
        if (-not $identity) { $identity = $email }
        Set-MailContact -Identity $identity -CustomAttribute1 $ManagedMarker -CustomAttribute2 $sourceKey -HiddenFromAddressListsEnabled $false -ErrorAction Stop
        Set-ExchangeContactProfile $identity $Contact
      } else {
        throw
      }
    }
    Increment-Stat $Stats "updatedContacts"
  } else {
    $newContact = New-MailContact -Name $Contact.DisplayName -DisplayName $Contact.DisplayName -ExternalEmailAddress $email -Alias $Contact.Alias -ErrorAction Stop
    $contactIdentity = $newContact.Identity
    if (-not $contactIdentity) { $contactIdentity = $email }
    Set-ExchangeContactProfile $contactIdentity $Contact
    Set-MailContact -Identity $contactIdentity -CustomAttribute1 $ManagedMarker -CustomAttribute2 $sourceKey -HiddenFromAddressListsEnabled $false -ErrorAction Stop
    Increment-Stat $Stats "createdContacts"
  }

  $verified = Get-MailContact -Filter "CustomAttribute2 -eq '$escapedSourceKey'" -ErrorAction SilentlyContinue
  if (-not $verified) { throw "Could not verify Exchange contact $email after upsert." }
  Assert-ExchangeRecipientName $verified $Contact.DisplayName "Exchange contact $email"
  if ((Normalize-Email (Get-RecipientEmail $verified)) -ne $email) { throw "Exchange contact $email has the wrong external email after verification." }
  if ((Clean-Text $verified.Alias).ToLowerInvariant() -ne (Clean-Text $Contact.Alias).ToLowerInvariant()) { throw "Exchange contact $email has alias '$($verified.Alias)' instead of '$($Contact.Alias)'." }
  if ((Clean-Text $verified.CustomAttribute1) -ne $ManagedMarker -or (Clean-Text $verified.CustomAttribute2) -ne $sourceKey) { throw "Exchange contact $email is missing its FCUNO management markers." }
  if ([bool]$verified.HiddenFromAddressListsEnabled) { throw "Exchange contact $email is still hidden from address lists." }
  Assert-ExchangeContactProfile $verified.Identity $Contact "Exchange contact $email"
  Increment-Stat $Stats "verifiedQueueRows"
}

function Remove-ManagedExchangeMailContact($Email, $Alias, [hashtable]$Stats, $SourceContactId = "", $ExpectedDisplayName = "", [bool]$AllowUntaggedExactDelete = $false) {
  $email = Normalize-Email $Email
  $aliasText = Clean-Text $Alias
  $existing = $null
  $sourceKey = Get-ContactSourceKey $SourceContactId
  if ($sourceKey) {
    $escapedSourceKey = Escape-ExchangeFilterValue $sourceKey
    $matches = @(Get-MailContact -Filter "CustomAttribute2 -eq '$escapedSourceKey'" -ResultSize Unlimited -ErrorAction SilentlyContinue)
    if ($matches.Count -gt 1) { throw "More than one Exchange contact is tagged with source key $sourceKey." }
    if ($matches.Count -eq 1) { $existing = $matches[0] }
  }
  if ($email) {
    $escapedEmail = Escape-ExchangeFilterValue $email
    $emailMatches = @(Get-MailContact -Filter "ExternalEmailAddress -eq '$escapedEmail'" -ResultSize Unlimited -ErrorAction SilentlyContinue)
    if ($emailMatches.Count -gt 1) { throw "More than one Exchange contact uses $email." }
    if (-not $existing -and $emailMatches.Count -eq 1) { $existing = $emailMatches[0] }
  }
  if (-not $existing -and $aliasText) {
    $existing = Get-MailContact -Identity $aliasText -ErrorAction SilentlyContinue
  }
  if (-not $existing) {
    Increment-Stat $Stats "verifiedQueueRows"
    return
  }
  $existingOwnerKey = Clean-Text $existing.CustomAttribute2
  if ((Clean-Text $existing.CustomAttribute1) -eq $ManagedMarker -and $sourceKey -and $existingOwnerKey -and $existingOwnerKey -ne $sourceKey) {
    throw "Exchange contact $($existing.DisplayName) is owned by source key $existingOwnerKey, not $sourceKey, so it was not deleted."
  }
  if ((Clean-Text $existing.CustomAttribute1) -ne $ManagedMarker) {
    $actualName = Clean-Text $existing.DisplayName
    $expectedName = Clean-Text $ExpectedDisplayName
    $actualEmail = Normalize-Email (Get-RecipientEmail $existing)
    $exactMatch = $AllowUntaggedExactDelete -and $email -and $actualEmail -eq $email -and $expectedName -and $actualName -eq $expectedName
    if (-not $exactMatch) {
      throw "Exchange contact $($existing.DisplayName) was not deleted because it is not tagged with $ManagedMarker and the queue does not authorize an exact legacy deletion."
    }
  }

  Remove-MailContact -Identity $existing.Identity -Confirm:$false -ErrorAction Stop
  $verifiedBySource = $null
  if ($sourceKey) {
    $verifiedBySource = Get-MailContact -Filter "CustomAttribute2 -eq '$(Escape-ExchangeFilterValue $sourceKey)'" -ErrorAction SilentlyContinue
  }
  $verifiedByEmail = $null
  if ($email) {
    $verifiedByEmail = Get-MailContact -Filter "ExternalEmailAddress -eq '$(Escape-ExchangeFilterValue $email)'" -ErrorAction SilentlyContinue
  }
  if ($verifiedBySource) { throw "Could not verify deletion of Exchange contact source key $sourceKey." }
  if ($verifiedByEmail -and (Clean-Text $verifiedByEmail.CustomAttribute2) -eq $sourceKey) { throw "Could not verify deletion of Exchange contact $email." }
  if ($verifiedByEmail -and -not $sourceKey) { throw "Could not verify deletion of Exchange contact $email." }
  Increment-Stat $Stats "removedContacts"
  Increment-Stat $Stats "verifiedQueueRows"
}

function Upsert-ExchangeDistributionGroup($Group, [hashtable]$Stats) {
  $alias = Clean-Text $Group.Alias
  if (-not $alias) {
    Increment-Stat $Stats "skippedQueueRows"
    return
  }

  $sourceKey = Clean-Text $Group.SourceKey
  $escapedSourceKey = Escape-ExchangeFilterValue $sourceKey
  $sourceMatches = @()
  if ($sourceKey) {
    $sourceMatches = @(Get-DistributionGroup -Filter "CustomAttribute2 -eq '$escapedSourceKey'" -ResultSize Unlimited -ErrorAction SilentlyContinue)
    if ($sourceMatches.Count -gt 1) { throw "More than one Exchange group is tagged with source key $sourceKey." }
  }
  $existing = if ($sourceMatches.Count -eq 1) { $sourceMatches[0] } else { $null }
  if (-not $existing) {
    $existing = Get-DistributionGroup -Identity $alias -ErrorAction SilentlyContinue
    if ($existing) {
      $existingOwnerKey = Clean-Text $existing.CustomAttribute2
      if ($existingOwnerKey -and $existingOwnerKey -ne $sourceKey) {
        throw "Exchange alias $alias belongs to source key $existingOwnerKey, not $sourceKey."
      }
      if ((Clean-Text $existing.DisplayName) -ne (Clean-Text $Group.GroupName)) {
        throw "Exchange alias $alias belongs to group '$($existing.DisplayName)', not '$($Group.GroupName)'."
      }
    }
  }
  if (-not $existing) {
    $escapedDisplayName = Escape-ExchangeFilterValue $Group.GroupName
    $nameMatches = @(Get-DistributionGroup -Filter "DisplayName -eq '$escapedDisplayName'" -ResultSize Unlimited -ErrorAction SilentlyContinue)
    if ($nameMatches.Count -gt 1) { throw "More than one Exchange group is named '$($Group.GroupName)', so legacy ownership could not be determined safely." }
    if ($nameMatches.Count -eq 1) {
      $candidateOwnerKey = Clean-Text $nameMatches[0].CustomAttribute2
      if ($candidateOwnerKey -and $candidateOwnerKey -ne $sourceKey) {
        throw "Exchange group '$($Group.GroupName)' is owned by source key $candidateOwnerKey, not $sourceKey."
      }
      $existing = $nameMatches[0]
    }
  }
  if ($existing) {
    Set-DistributionGroup -Identity $existing.Identity -Alias $alias -Name $Group.GroupName -DisplayName $Group.GroupName -Notes $Group.Description -CustomAttribute1 $ManagedMarker -CustomAttribute2 $sourceKey -HiddenFromAddressListsEnabled $false -ErrorAction Stop
    Increment-Stat $Stats "updatedGroups"
  } else {
    New-DistributionGroup -Name $Group.GroupName -Alias $alias -ErrorAction Stop | Out-Null
    Set-DistributionGroup -Identity $alias -Notes $Group.Description -CustomAttribute1 $ManagedMarker -CustomAttribute2 $sourceKey -HiddenFromAddressListsEnabled $false -ErrorAction Stop
    Increment-Stat $Stats "createdGroups"
  }

  $verified = Get-DistributionGroup -Filter "CustomAttribute2 -eq '$escapedSourceKey'" -ErrorAction SilentlyContinue
  if (-not $verified) { throw "Could not verify Exchange group $alias after upsert." }
  Assert-ExchangeRecipientName $verified $Group.GroupName "Exchange group $alias"
  if ((Clean-Text $verified.Alias).ToLowerInvariant() -ne $alias.ToLowerInvariant()) { throw "Exchange group $($Group.GroupName) has alias '$($verified.Alias)' instead of '$alias'." }
  if ((Clean-Text $verified.Notes) -ne (Clean-Text $Group.Description)) { throw "Exchange group $($Group.GroupName) has a different description after verification." }
  if ((Clean-Text $verified.CustomAttribute1) -ne $ManagedMarker -or (Clean-Text $verified.CustomAttribute2) -ne $sourceKey) { throw "Exchange group $($Group.GroupName) is missing its FCUNO management markers." }
  if ([bool]$verified.HiddenFromAddressListsEnabled) { throw "Exchange group $($Group.GroupName) is still hidden from address lists." }
  Increment-Stat $Stats "verifiedQueueRows"
}

function Remove-ManagedExchangeDistributionGroup($Alias, [hashtable]$Stats, $SourceGroupId = "", $ExpectedDisplayName = "", [bool]$AllowUntaggedExactDelete = $false) {
  $aliasText = Clean-Text $Alias
  $sourceKey = Get-GroupSourceKey $SourceGroupId
  if (-not $aliasText -and -not $sourceKey) {
    Increment-Stat $Stats "skippedQueueRows"
    return
  }

  $existing = $null
  if ($sourceKey) {
    $matches = @(Get-DistributionGroup -Filter "CustomAttribute2 -eq '$(Escape-ExchangeFilterValue $sourceKey)'" -ResultSize Unlimited -ErrorAction SilentlyContinue)
    if ($matches.Count -gt 1) { throw "More than one Exchange group is tagged with source key $sourceKey." }
    if ($matches.Count -eq 1) { $existing = $matches[0] }
  }
  if (-not $existing -and $aliasText) {
    $existing = Get-DistributionGroup -Identity $aliasText -ErrorAction SilentlyContinue
  }
  if (-not $existing) {
    Increment-Stat $Stats "verifiedQueueRows"
    return
  }
  $existingOwnerKey = Clean-Text $existing.CustomAttribute2
  if ((Clean-Text $existing.CustomAttribute1) -eq $ManagedMarker -and $sourceKey -and $existingOwnerKey -and $existingOwnerKey -ne $sourceKey) {
    throw "Exchange group $($existing.DisplayName) is owned by source key $existingOwnerKey, not $sourceKey, so it was not deleted."
  }
  if ((Clean-Text $existing.CustomAttribute1) -ne $ManagedMarker) {
    $exactMatch = $AllowUntaggedExactDelete -and $aliasText -and (Clean-Text $existing.Alias).ToLowerInvariant() -eq $aliasText.ToLowerInvariant() -and (Clean-Text $ExpectedDisplayName) -and (Clean-Text $existing.DisplayName) -eq (Clean-Text $ExpectedDisplayName)
    if (-not $exactMatch) {
      throw "Exchange group $($existing.DisplayName) was not deleted because it is not tagged with $ManagedMarker and the queue does not authorize an exact legacy deletion."
    }
  }

  Remove-DistributionGroup -Identity $existing.Identity -Confirm:$false -ErrorAction Stop
  $verified = if ($sourceKey) {
    Get-DistributionGroup -Filter "CustomAttribute2 -eq '$(Escape-ExchangeFilterValue $sourceKey)'" -ErrorAction SilentlyContinue
  } elseif ($aliasText) {
    Get-DistributionGroup -Identity $aliasText -ErrorAction SilentlyContinue
  } else {
    $null
  }
  if ($verified) { throw "Could not verify deletion of Exchange group $aliasText." }
  Increment-Stat $Stats "removedGroups"
  Increment-Stat $Stats "verifiedQueueRows"
}

function Sync-ExchangeGroupMembers($Group, $Members, [hashtable]$Stats) {
  Upsert-ExchangeDistributionGroup $Group $Stats

  $desiredMembers = @{}
  foreach ($member in @($Members)) {
    $email = Normalize-Email $member.MemberEmail
    if ($email) { $desiredMembers[$email] = $true }
  }

  foreach ($email in $desiredMembers.Keys) {
    try {
      Add-DistributionGroupMember -Identity $Group.Alias -Member $email -ErrorAction Stop
      Increment-Stat $Stats "addedMembers"
      $Stats["addedMemberEmails"] = @($Stats["addedMemberEmails"]) + $email
    } catch {
      if ($_.Exception.Message -notmatch "already a member") {
        throw ("Could not add {0} to {1}: {2}" -f $email, $Group.GroupName, $_.Exception.Message)
      }
    }
  }

  $currentMembers = @(Get-DistributionGroupMember -Identity $Group.Alias -ResultSize Unlimited -ErrorAction SilentlyContinue)
  foreach ($currentMember in $currentMembers) {
    $currentEmail = Get-RecipientEmail $currentMember
    if ($currentEmail -and -not (Has-MapKey $desiredMembers $currentEmail)) {
      Remove-DistributionGroupMember -Identity $Group.Alias -Member $currentMember.Identity -Confirm:$false -ErrorAction Stop
      Increment-Stat $Stats "removedMembers"
      $Stats["removedMemberEmails"] = @($Stats["removedMemberEmails"]) + $currentEmail
    }
  }

  $missingEmails = @()
  $unexpectedEmails = @()
  $membershipVerified = $false
  for ($verificationAttempt = 1; $verificationAttempt -le 4; $verificationAttempt += 1) {
    if ($verificationAttempt -gt 1) { Start-Sleep -Seconds 2 }
    $verifiedMembers = @(Get-DistributionGroupMember -Identity $Group.Alias -ResultSize Unlimited -ErrorAction Stop)
    $verifiedEmails = @{}
    foreach ($verifiedMember in $verifiedMembers) {
      $verifiedEmail = Get-RecipientEmail $verifiedMember
      if ($verifiedEmail) { $verifiedEmails[$verifiedEmail] = $true }
    }
    $missingEmails = @($desiredMembers.Keys | Where-Object { -not (Has-MapKey $verifiedEmails $_) } | Sort-Object)
    $unexpectedEmails = @($verifiedEmails.Keys | Where-Object { -not (Has-MapKey $desiredMembers $_) } | Sort-Object)
    if ($missingEmails.Count -le 0 -and $unexpectedEmails.Count -le 0) {
      $membershipVerified = $true
      break
    }
  }
  if (-not $membershipVerified) {
    $verificationParts = @()
    if ($missingEmails.Count -gt 0) { $verificationParts += "missing after verification retries: $($missingEmails -join ', ')" }
    if ($unexpectedEmails.Count -gt 0) { $verificationParts += "unexpected after verification retries: $($unexpectedEmails -join ', ')" }
    throw "Exchange group membership verification failed for $($Group.GroupName) ($($verificationParts -join '; '))."
  }
}

function Sync-ExchangeGroupState($GroupId, $FallbackAlias, [hashtable]$Stats, $FallbackDisplayName = "", [bool]$AllowUntaggedExactDelete = $false) {
  $exchangeRows = Get-GroupExchangeRowsFromSource $GroupId
  if (-not $exchangeRows) {
    Remove-ManagedExchangeDistributionGroup $FallbackAlias $Stats $GroupId $FallbackDisplayName $AllowUntaggedExactDelete
    return
  }

  $groups = @($exchangeRows.Groups)
  if ($groups.Count -le 0) {
    Remove-ManagedExchangeDistributionGroup $FallbackAlias $Stats $GroupId $FallbackDisplayName $AllowUntaggedExactDelete
    return
  }

  $group = $groups[0]
  $members = @($exchangeRows.Members | Where-Object { (Clean-Text $_.GroupAlias).ToLowerInvariant() -eq (Clean-Text $group.Alias).ToLowerInvariant() })
  Sync-ExchangeGroupMembers $group $members $Stats
}

function Sync-ExchangeGroupsForEmail($Email, [hashtable]$Stats) {
  $email = Normalize-Email $Email
  if (-not $email) { return }
  $rows = Get-CanonicalExchangeRows
  $groupIds = @($rows.Members |
    Where-Object { (Normalize-Email $_.MemberEmail) -eq $email } |
    Select-Object -ExpandProperty SourceGroupId -Unique)
  foreach ($groupId in $groupIds) {
    Sync-ExchangeGroupState $groupId "" $Stats
  }
}

function Get-QueueAuditAuthorized($Row) {
  if (-not (Get-QueueBoolean $Row "userAuthorized")) { return $false }
  if (Test-GuidText $Row.audit_log_id) { return $true }
  return @($Row.audit_log_ids).Count -gt 0
}

function Get-QueueContactBeforeEmail($Row) {
  $email = Get-QueuePayloadValue $Row "beforeContact" "primary_email"
  if (-not $email) { $email = Get-QueuePayloadValue $Row "contact" "ExternalEmailAddress" }
  if (-not $email) { $email = Clean-Text $Row.entity_email }
  return Normalize-Email $email
}

function Get-QueueContactBeforeBaseAlias($Row) {
  $seed = Get-QueuePayloadValue $Row "beforeContact" "nickname"
  if (-not $seed) { $seed = Get-QueuePayloadValue $Row "beforeContact" "display_name" }
  if (-not $seed) { return Clean-Text $Row.entity_alias }
  return Get-ExchangeAlias $seed ("contact-" + (Clean-Text $Row.entity_id))
}

function Reconcile-ExchangeContactEmail($Email, $Row, [hashtable]$Stats, [bool]$UseQueuedSourceKeyForDelete) {
  $email = Normalize-Email $Email
  if (-not $email) { return }
  $rows = Get-CanonicalExchangeRows
  $desiredContact = if (Has-MapKey $rows.ContactByEmail $email) { $rows.ContactByEmail[$email] } else { $null }
  if ($desiredContact -and -not (Is-InternalEmail $email)) {
    Upsert-ExchangeMailContact $desiredContact $Stats
    return
  }
  if ($desiredContact -and (Is-InternalEmail $email)) { return }

  $sourceId = if ($UseQueuedSourceKeyForDelete) { Clean-Text $Row.entity_id } else { "" }
  Remove-ManagedExchangeMailContact `
    $email `
    (Clean-Text $Row.entity_alias) `
    $Stats `
    $sourceId `
    (Get-QueueExpectedContactName $Row) `
    (Get-QueueAuditAuthorized $Row)
}

function Sync-ExchangeContactQueueState($Row, [hashtable]$Stats) {
  $sourceContact = Load-SingleRow "shared_addressbook_contacts" "id" $Row.entity_id
  if ($sourceContact -and -not (Test-ValidEmail $sourceContact.primary_email)) {
    throw "FCUNO contact $($sourceContact.display_name) has invalid email '$($sourceContact.primary_email)'. Correct the email before syncing."
  }

  $beforeEmail = Get-QueueContactBeforeEmail $Row
  $currentEmail = if ($sourceContact) { Normalize-Email $sourceContact.primary_email } else { "" }
  $beforeBaseAlias = Get-QueueContactBeforeBaseAlias $Row
  $currentRow = if ($sourceContact) { Get-ContactExchangeRowFromSource $Row.entity_id } else { $null }
  $currentBaseAlias = if ($currentRow) { Clean-Text $currentRow.BaseAlias } else { "" }
  $beforeEmailReconciled = $false

  if ($beforeEmail -and $beforeEmail -ne $currentEmail) {
    Reconcile-ExchangeContactEmail $beforeEmail $Row $Stats (-not $sourceContact)
    $beforeEmailReconciled = $true
  }
  if ($currentBaseAlias) { Sync-ExchangeAliasPeers $currentBaseAlias $Stats }
  if ($currentEmail) {
    Reconcile-ExchangeContactEmail $currentEmail $Row $Stats $false
  } elseif ($beforeEmail -and -not $beforeEmailReconciled) {
    Reconcile-ExchangeContactEmail $beforeEmail $Row $Stats $true
  }

  foreach ($email in @($beforeEmail, $currentEmail) | Where-Object { $_ } | Select-Object -Unique) {
    Sync-ExchangeGroupsForEmail $email $Stats
  }
  if ($beforeBaseAlias -and -not $beforeBaseAlias.Equals($currentBaseAlias, [StringComparison]::OrdinalIgnoreCase)) {
    Sync-ExchangeAliasPeers $beforeBaseAlias $Stats
  }
}

function Get-QueueGroupBeforeBaseAlias($Row) {
  $seed = Get-QueuePayloadValue $Row "beforeGroup" "nickname"
  if (-not $seed) { $seed = Get-QueuePayloadValue $Row "beforeGroup" "name" }
  if (-not $seed) { return Clean-Text $Row.entity_alias }
  return Get-ExchangeAlias $seed ("group-" + (Clean-Text $Row.entity_id))
}

function Sync-ExchangeGroupQueueState($Row, [hashtable]$Stats) {
  $sourceGroup = Load-SingleRow "shared_addressbook_groups" "id" $Row.entity_id
  $beforeBaseAlias = Get-QueueGroupBeforeBaseAlias $Row
  $currentRows = if ($sourceGroup) { Get-GroupExchangeRowsFromSource $Row.entity_id } else { $null }
  $currentGroup = if ($currentRows -and @($currentRows.Groups).Count -gt 0) { @($currentRows.Groups)[0] } else { $null }
  $currentBaseAlias = if ($currentGroup) { Clean-Text $currentGroup.BaseAlias } else { "" }

  if ($currentBaseAlias) { Sync-ExchangeAliasPeers $currentBaseAlias $Stats }
  Sync-ExchangeGroupState `
    $Row.entity_id `
    $Row.entity_alias `
    $Stats `
    (Get-QueueExpectedGroupName $Row) `
    $(if ($sourceGroup) { $false } else { Get-QueueAuditAuthorized $Row })
  if ($beforeBaseAlias -and -not $beforeBaseAlias.Equals($currentBaseAlias, [StringComparison]::OrdinalIgnoreCase)) {
    Sync-ExchangeAliasPeers $beforeBaseAlias $Stats
  }
}

function Get-QueueBoolean($Row, $PropertyName) {
  if (-not $Row -or -not $Row.payload) { return $false }
  $property = $Row.payload.PSObject.Properties[$PropertyName]
  if (-not $property) { return $false }
  if ($property.Value -is [bool]) { return $property.Value }
  if ($property.Value -is [string]) {
    return (Clean-Text $property.Value).Equals("true", [StringComparison]::OrdinalIgnoreCase)
  }
  return $false
}

function Get-QueueExpectedContactName($Row) {
  $name = Get-QueuePayloadValue $Row "beforeContact" "display_name"
  if (-not $name) { $name = Get-QueuePayloadValue $Row "contact" "DisplayName" }
  if (-not $name) { $name = Clean-Text $Row.display_name }
  return $name
}

function Get-QueueExpectedGroupName($Row) {
  $name = Get-QueuePayloadValue $Row "beforeGroup" "name"
  if (-not $name) { $name = Get-QueuePayloadValue $Row "group" "GroupName" }
  if (-not $name) { $name = Clean-Text $Row.display_name }
  return $name
}

function Process-ExchangeQueueRow($Row, [hashtable]$Stats) {
  $action = Clean-Text $Row.action
  switch ($action) {
    "create_contact" {
      Sync-ExchangeContactQueueState $Row $Stats
    }
    "update_contact" {
      Sync-ExchangeContactQueueState $Row $Stats
    }
    "delete_contact" {
      Sync-ExchangeContactQueueState $Row $Stats
    }
    "create_group" {
      Sync-ExchangeGroupQueueState $Row $Stats
    }
    "update_group" {
      Sync-ExchangeGroupQueueState $Row $Stats
    }
    "update_group_members" {
      Sync-ExchangeGroupQueueState $Row $Stats
    }
    "delete_group" {
      Sync-ExchangeGroupQueueState $Row $Stats
    }
    default {
      throw "Unknown Exchange queue action: $action"
    }
  }
}

function Invoke-IncrementalExchangeSync {
  $stats = @{
    syncMode = "incremental"
    queuedRows = 0
    processedQueueRows = 0
    completedQueueRows = 0
    failedQueueRows = 0
    skippedQueueRows = 0
    supersededQueueRows = 0
    verifiedQueueRows = 0
    changes = @()
    changeDetails = @()
    addedMemberEmails = @()
    removedMemberEmails = @()
    createdContacts = 0
    updatedContacts = 0
    removedContacts = 0
    createdGroups = 0
    updatedGroups = 0
    removedGroups = 0
    addedMembers = 0
    removedMembers = 0
  }

  if (-not $script:CurrentQueueRunId) { $script:CurrentQueueRunId = [Guid]::NewGuid().ToString() }
  while ($true) {
    Renew-ExchangeSyncLock
    $batchRows = Claim-ExchangeQueueRows 200
    if (@($batchRows).Count -le 0) { break }
    Increment-Stat $stats "queuedRows" @($batchRows).Count
    $script:CanonicalExchangeRows = $null

  foreach ($row in $batchRows) {
    $rowId = Clean-Text $row.id
    if (-not $rowId) { continue }
    $beforeCounters = $null
    try {
      Increment-Stat $stats "processedQueueRows"
      if ([int]$stats.processedQueueRows % 50 -eq 0) { Renew-ExchangeSyncLock }
      Write-Host ("Processing Exchange queue row {0}: {1} {2}" -f $rowId, (Clean-Text $row.action), (Clean-Text $row.display_name))
      $beforeCounters = Get-QueueCounterSnapshot $stats
      Process-ExchangeQueueRow $row $stats
      $skippedForRow = Get-QueueCounterDelta $beforeCounters $stats "skippedQueueRows"
      if ($skippedForRow -gt 0) {
        $skipReason = Get-QueueSkipReason $row
        Update-ExchangeQueueRow $rowId @{
          status = "skipped"
          completed_at = (Get-Date).ToUniversalTime().ToString("o")
          error_message = $skipReason
        }
        Add-SyncChangeDetail $stats $row "skipped" $skipReason
        Write-Warning ("Skipped Exchange queue row {0}: {1}" -f $rowId, $skipReason)
      } else {
        $resultMessage = Get-QueueResultMessage $row $beforeCounters $stats
        Update-ExchangeQueueRow $rowId @{
          status = "completed"
          exchange_verified_at = (Get-Date).ToUniversalTime().ToString("o")
          completed_at = (Get-Date).ToUniversalTime().ToString("o")
          error_message = $null
        }
        Increment-Stat $stats "completedQueueRows"
        Add-SyncChange $stats $row
        Add-SyncChangeDetail $stats $row "completed" $resultMessage
        Write-Host ("Completed Exchange queue row {0}" -f $rowId)
      }
    } catch {
      $rowError = Clean-Text $_.Exception.Message
      $failureResult = "Error: $rowError"
      if ($beforeCounters) {
        $skippedBeforeFailure = Get-QueueCounterDelta $beforeCounters $stats "skippedQueueRows"
        if ($skippedBeforeFailure -gt 0) {
          Increment-Stat $stats "skippedQueueRows" (-1 * $skippedBeforeFailure)
        }
        $partialProgress = Get-QueuePartialProgressMessage $beforeCounters $stats
        if ($partialProgress) { $failureResult = "$partialProgress Error: $rowError" }
      }
      try {
        Update-ExchangeQueueRow $rowId @{
          status = "failed"
          error_message = $rowError
          next_attempt_at = (Get-Date).ToUniversalTime().AddMinutes(15).ToString("o")
        }
      } catch {
        $statusError = Clean-Text $_.Exception.Message
        $failureResult += " Queue status persistence also failed: $statusError"
        Write-Warning ("Could not persist failed status for Exchange queue row {0}: {1}" -f $rowId, $statusError)
      }
      Increment-Stat $stats "failedQueueRows"
      Add-SyncChangeDetail $stats $row "failed" $failureResult
      Write-Warning ("Exchange queue row {0} failed: {1}" -f $rowId, $rowError)
    }
  }
  }

  $runId = Encode-QueryValue $script:CurrentQueueRunId
  $supersededRows = @(Invoke-SupabaseRest -Method "GET" -Path "outlook_exchange_sync_queue?select=id&run_id=eq.$runId&status=eq.skipped&limit=1000")
  $stats["supersededQueueRows"] = $supersededRows.Count
  $stats["skippedQueueRows"] = [int]$stats["skippedQueueRows"] + $supersededRows.Count

  return $stats
}

function Get-WebhookPayload($WebhookData) {
  if ($null -eq $WebhookData) { return @{} }
  $body = $WebhookData.RequestBody
  if (-not $body) { return @{} }
  try {
    return $body | ConvertFrom-Json
  } catch {
    return @{}
  }
}

function Escape-Html($Value) {
  if ($null -eq $Value) { return "" }
  return [System.Net.WebUtility]::HtmlEncode([string]$Value)
}

function Add-NotificationRecipient([hashtable]$Seen, [System.Collections.ArrayList]$Recipients, $Value) {
  $email = Normalize-Email $Value
  if ($email -and $email -match "^[^@\s]+@[^@\s]+\.[^@\s]+$" -and -not (Has-MapKey $Seen $email)) {
    $Seen[$email] = $true
    [void]$Recipients.Add($email)
  }
}

function Get-DetailValue($Details, [string]$Key) {
  if (-not $Details) { return $null }
  if ($Details -is [hashtable] -or $Details -is [System.Collections.IDictionary]) {
    if ((Has-MapKey $Details $Key)) { return (Get-MapValue $Details $Key) }
    return $null
  }
  $property = $Details.PSObject.Properties[$Key]
  if ($property) { return $property.Value }
  return $null
}

function Get-NotificationRecipients($WebhookPayload) {
  $seen = @{}
  $recipients = New-Object System.Collections.ArrayList
  $configuredRecipients = Get-OptionalAutomationSetting "EXCHANGE_SYNC_NOTIFY_EMAILS"
  if ($configuredRecipients) {
    foreach ($recipient in ([string]$configuredRecipients -split "[,;\r\n\t ]+")) {
      Add-NotificationRecipient $seen $recipients $recipient
    }
  }
  Add-NotificationRecipient $seen $recipients $WebhookPayload.requestedByEmail
  return @($recipients)
}

function Get-NoticeEmailFrom {
  $from = Clean-Text (Get-OptionalAutomationSetting "EMAIL_NOTICE_FROM")
  if (-not $from) { $from = "FC Uno <info@cosulich.com.hk>" }
  return $from
}

function Get-NoticeEmailAddress($Value) {
  $text = Clean-Text $Value
  if ($text -match '<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>') { return $Matches[1].ToLowerInvariant() }
  if ($text -match '^[^@\s]+@[^@\s]+\.[^@\s]+$') { return $text.ToLowerInvariant() }
  return ""
}

function Get-NoticeSmtpPort {
  $portText = Clean-Text (Get-OptionalAutomationSetting "EXCHANGE_SMTP_PORT")
  if (-not $portText) { return 587 }

  $port = 0
  if (-not [int]::TryParse($portText, [ref]$port) -or $port -le 0 -or $port -gt 65535) {
    throw "Automation variable EXCHANGE_SMTP_PORT must be a TCP port number."
  }
  return $port
}

function Send-ExchangeSmtpMail($From, $To, $Subject, $Html) {
  $hostName = Clean-Text (Get-OptionalAutomationSetting "EXCHANGE_SMTP_HOST")
  if (-not $hostName) { $hostName = "smtp.office365.com" }
  $port = Get-NoticeSmtpPort
  $user = Clean-Text (Get-OptionalAutomationSetting "EXCHANGE_SMTP_USER")
  if (-not $user) { $user = Get-NoticeEmailAddress $From }
  if (-not $user) { $user = "info@cosulich.com.hk" }
  $password = Get-OptionalAutomationSetting "EXCHANGE_SMTP_PASSWORD"

  if (-not $password) {
    Write-Warning "Exchange sync notification email was not sent because EXCHANGE_SMTP_PASSWORD is not configured in Azure Automation variables."
    return
  }

  $message = [System.Net.Mail.MailMessage]::new()
  try {
    $message.From = [System.Net.Mail.MailAddress]::new($From)
    foreach ($recipient in @($To)) {
      $recipientText = Clean-Text $recipient
      if ($recipientText) { [void]$message.To.Add($recipientText) }
    }
    if ($message.To.Count -le 0) { return }

    $message.Subject = $Subject
    $message.Body = $Html
    $message.IsBodyHtml = $true

    if ($password -is [System.Security.SecureString]) {
      $credential = [System.Net.NetworkCredential]::new($user, $password)
    } else {
      $credential = [System.Net.NetworkCredential]::new($user, [string]$password)
    }

    $client = [System.Net.Mail.SmtpClient]::new($hostName, $port)
    try {
      $client.EnableSsl = $true
      $client.Credentials = $credential
      $client.Send($message)
    } finally {
      $client.Dispose()
    }
  } finally {
    $message.Dispose()
  }
}

function Get-SyncSummaryLabel($Key) {
  switch ($Key) {
    "syncMode" { return "Sync mode" }
    "queuedRows" { return "Queued changes" }
    "processedQueueRows" { return "Processed changes" }
    "completedQueueRows" { return "Completed changes" }
    "failedQueueRows" { return "Failed changes" }
    "skippedQueueRows" { return "Skipped rows (including superseded)" }
    "supersededQueueRows" { return "Earlier saves superseded" }
    "verifiedQueueRows" { return "Verified operations" }
    "contacts" { return "Contacts processed" }
    "groups" { return "Groups processed" }
    "groupMembers" { return "Group members processed" }
    "createdContacts" { return "Contacts created" }
    "updatedContacts" { return "Contacts updated" }
    "removedContacts" { return "Contacts removed" }
    "createdGroups" { return "Groups created" }
    "updatedGroups" { return "Groups updated" }
    "removedGroups" { return "Groups removed" }
    "addedMembers" { return "Group members added" }
    "removedMembers" { return "Group members removed" }
    default { return Clean-Text $Key }
  }
}

function Send-ExchangeSyncNotification($Status, $Message, $Details, $WebhookPayload) {
  $Details = Get-StatsObject $Details
  $recipients = Get-NotificationRecipients $WebhookPayload
  if (-not $recipients -or @($recipients).Count -le 0) { return }

  $from = Get-NoticeEmailFrom

  $requestedBy = Clean-Text $WebhookPayload.requestedBy
  if (-not $requestedBy) { $requestedBy = "Admin" }
  $startedAt = Format-HongKongTime $WebhookPayload.requestedAt

  $queuedValue = Get-DetailValue $Details "queuedRows"
  $hasQueueStats = $null -ne $queuedValue
  $queuedRows = if ($hasQueueStats) { [int]$queuedValue } else { 0 }
  $completedRows = [int](Get-DetailValue $Details "completedQueueRows")
  $failedRows = [int](Get-DetailValue $Details "failedQueueRows")
  $skippedRows = [int](Get-DetailValue $Details "skippedQueueRows")
  $supersededRows = [int](Get-DetailValue $Details "supersededQueueRows")
  $actionableSkippedRows = [Math]::Max(0, $skippedRows - $supersededRows)
  $statusText = "Completed"
  $statusColor = "#166534"
  $statusBackground = "#dcfce7"
  $statusBorder = "#86efac"
  if ($Status -ne "completed" -or $failedRows -gt 0) {
    $statusText = "Failed"
    $statusColor = "#991b1b"
    $statusBackground = "#fee2e2"
    $statusBorder = "#fca5a5"
  } elseif ($actionableSkippedRows -gt 0) {
    $statusText = "Completed with skipped changes"
    $statusColor = "#854d0e"
    $statusBackground = "#fef9c3"
    $statusBorder = "#fde047"
  }

  $changeRows = ""
  $changeDetails = Get-DetailValue $Details "changeDetails"
  $changeIndex = 0
  $maxChangeRows = 200
  foreach ($change in @($changeDetails)) {
    if ($null -eq $change -or $changeIndex -ge $maxChangeRows) { continue }

    $changeStatus = (Clean-Text (Get-DetailValue $change "status")).ToLowerInvariant()
    $changeStatusText = "Completed"
    $changeStatusColor = "#166534"
    $changeStatusBackground = "#dcfce7"
    $rowBackground = "#ffffff"
    if ($changeStatus -eq "failed") {
      $changeStatusText = "Failed"
      $changeStatusColor = "#991b1b"
      $changeStatusBackground = "#fee2e2"
      $rowBackground = "#fff7f7"
    } elseif ($changeStatus -eq "skipped") {
      $changeStatusText = "Skipped"
      $changeStatusColor = "#854d0e"
      $changeStatusBackground = "#fef9c3"
      $rowBackground = "#fffdf2"
    }

    $actionLabel = Clean-Text (Get-DetailValue $change "actionLabel")
    if (-not $actionLabel) { $actionLabel = Get-QueueActionLabel (Get-DetailValue $change "action") }
    $entityType = Clean-Text (Get-DetailValue $change "entityType")
    $displayName = Clean-Text (Get-DetailValue $change "displayName")
    if (-not $displayName) { $displayName = "Unknown item" }
    $identifier = Clean-Text (Get-DetailValue $change "identifier")
    $result = Clean-Text (Get-DetailValue $change "result")
    if (-not $result) { $result = "No result detail was recorded." }
    $queueRowId = Clean-Text (Get-DetailValue $change "queueRowId")
    $eventId = Clean-Text (Get-DetailValue $change "eventId")
    $auditLogIds = @(Get-DetailValue $change "auditLogIds" | ForEach-Object { Clean-Text $_ } | Where-Object { $_ })
    $changeSetIds = @(Get-DetailValue $change "changeSetIds" | ForEach-Object { Clean-Text $_ } | Where-Object { $_ })
    $actorId = Clean-Text (Get-DetailValue $change "actorId")
    $rowRequestedBy = Clean-Text (Get-DetailValue $change "requestedBy")
    $rowQueuedAt = Clean-Text (Get-DetailValue $change "queuedAt")
    $rowAttempt = [int](Get-DetailValue $change "attempt")

    $identifierHtml = ""
    if ($identifier) {
      $identifierHtml = "<div style='margin-top:3px;color:#475569;font-size:12px;'>$(Escape-Html $identifier)</div>"
    }
    $fieldChangesHtml = ""
    $fieldChanges = @(Get-DetailValue $change "fieldChanges")
    if ($fieldChanges.Count -gt 0) {
      $fieldItems = @($fieldChanges | ForEach-Object { "<li style='margin:2px 0;'>$(Escape-Html $_)</li>" }) -join ""
      $fieldChangesHtml = "<div style='margin-top:7px;color:#334155;font-size:11px;font-weight:800;'>Exact FCUNO change</div><ul style='margin:3px 0 0 17px;padding:0;color:#475569;font-size:11px;'>$fieldItems</ul>"
    }
    $queueMetadata = @()
    if ($rowRequestedBy) { $queueMetadata += "Requested by $(Escape-Html $rowRequestedBy)" }
    if ($actorId -and $actorId -ne $rowRequestedBy) { $queueMetadata += "Actor $(Escape-Html $actorId)" }
    if ($rowQueuedAt) { $queueMetadata += "Queued $(Escape-Html $rowQueuedAt)" }
    if ($rowAttempt -gt 0) { $queueMetadata += "Attempt $(Escape-Html $rowAttempt)" }
    if ($eventId) { $queueMetadata += "Event $(Escape-Html $eventId)" }
    if ($auditLogIds.Count -gt 0) { $queueMetadata += "Audit log$(if ($auditLogIds.Count -gt 1) { 's' } else { '' }) $(Escape-Html (($auditLogIds | Select-Object -First 5) -join ', '))" }
    if ($changeSetIds.Count -gt 0) { $queueMetadata += "Change set$(if ($changeSetIds.Count -gt 1) { 's' } else { '' }) $(Escape-Html (($changeSetIds | Select-Object -First 5) -join ', '))" }
    if ($queueRowId) { $queueMetadata += "Queue row $(Escape-Html $queueRowId)" }
    $queueRowHtml = ""
    if ($queueMetadata.Count -gt 0) {
      $queueRowHtml = "<div style='margin-top:5px;color:#94a3b8;font-size:10px;'>$($queueMetadata -join ' &middot; ')</div>"
    }

    $changeRows += @"
<tr style="background:$rowBackground;">
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;white-space:nowrap;"><span style="display:inline-block;padding:3px 8px;border-radius:999px;background:$changeStatusBackground;color:$changeStatusColor;font-size:11px;font-weight:800;">$(Escape-Html $changeStatusText)</span></td>
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-weight:700;">$(Escape-Html $actionLabel)</td>
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;"><div style="font-weight:700;">$(Escape-Html $displayName)</div><div style="margin-top:2px;color:#64748b;font-size:11px;">$(Escape-Html $entityType)</div>$identifierHtml$fieldChangesHtml</td>
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;">$(Escape-Html $result)$queueRowHtml</td>
</tr>
"@
    $changeIndex += 1
  }

  $changeCount = @($changeDetails).Count
  if (-not $changeRows) {
    $fallbackAction = if ($hasQueueStats) { "Incremental sync" } else { "Full sync" }
    $fallbackItem = if ($hasQueueStats -and $queuedRows -le 0) { "No pending changes" } else { "Address book sync" }
    $fallbackStatus = if ($Status -eq "completed") { "Completed" } else { "Failed" }
    $fallbackStatusColor = if ($Status -eq "completed") { "#166534" } else { "#991b1b" }
    $fallbackStatusBackground = if ($Status -eq "completed") { "#dcfce7" } else { "#fee2e2" }
    $changeRows = @"
<tr>
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;"><span style="display:inline-block;padding:3px 8px;border-radius:999px;background:$fallbackStatusBackground;color:$fallbackStatusColor;font-size:11px;font-weight:800;">$(Escape-Html $fallbackStatus)</span></td>
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-weight:700;">$(Escape-Html $fallbackAction)</td>
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-weight:700;">$(Escape-Html $fallbackItem)</td>
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;">$(Escape-Html $Message)</td>
</tr>
"@
  } elseif ($changeCount -gt $changeIndex) {
    $remainingChanges = $changeCount - $changeIndex
    $changeRows += "<tr><td colspan='4' style='padding:10px 8px;color:#64748b;background:#f8fafc;'>$(Escape-Html "$remainingChanges additional queue result(s) were omitted from this email.")</td></tr>"
  }

  $detailsRows = ""
  if ($Details) {
    foreach ($key in @("syncMode", "queuedRows", "processedQueueRows", "completedQueueRows", "failedQueueRows", "skippedQueueRows", "supersededQueueRows", "verifiedQueueRows", "contacts", "groups", "groupMembers", "createdContacts", "updatedContacts", "removedContacts", "createdGroups", "updatedGroups", "removedGroups", "addedMembers", "removedMembers")) {
      $detailValue = Get-DetailValue $Details $key
      if ($null -ne $detailValue) {
        $detailsRows += "<tr><td style='padding:6px 12px 6px 0;color:#475569;border-bottom:1px solid #f1f5f9;'>$(Escape-Html (Get-SyncSummaryLabel $key))</td><td style='padding:6px 0;font-weight:700;border-bottom:1px solid #f1f5f9;text-align:right;'>$(Escape-Html $detailValue)</td></tr>"
      }
    }
  }
  if (-not $detailsRows) {
    $detailsRows = "<tr><td style='padding:4px 0;color:#475569;'>No count details available.</td></tr>"
  }

  $metricsHtml = ""
  if ($hasQueueStats) {
    $metricsHtml = @"
<table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px 0;margin:16px -8px 0;">
  <tr>
    <td style="width:25%;padding:10px;border:1px solid #bfdbfe;border-radius:10px;background:#eff6ff;"><div style="color:#1e40af;font-size:11px;font-weight:800;text-transform:uppercase;">Processed</div><div style="margin-top:3px;color:#1e3a8a;font-size:22px;font-weight:900;">$(Escape-Html ([int](Get-DetailValue $Details "processedQueueRows")))</div></td>
    <td style="width:25%;padding:10px;border:1px solid #86efac;border-radius:10px;background:#f0fdf4;"><div style="color:#166534;font-size:11px;font-weight:800;text-transform:uppercase;">Completed</div><div style="margin-top:3px;color:#14532d;font-size:22px;font-weight:900;">$(Escape-Html $completedRows)</div></td>
    <td style="width:25%;padding:10px;border:1px solid #fca5a5;border-radius:10px;background:#fff7f7;"><div style="color:#991b1b;font-size:11px;font-weight:800;text-transform:uppercase;">Failed</div><div style="margin-top:3px;color:#7f1d1d;font-size:22px;font-weight:900;">$(Escape-Html $failedRows)</div></td>
    <td style="width:25%;padding:10px;border:1px solid #fde047;border-radius:10px;background:#fffdf2;"><div style="color:#854d0e;font-size:11px;font-weight:800;text-transform:uppercase;">Skipped</div><div style="margin-top:3px;color:#713f12;font-size:22px;font-weight:900;">$(Escape-Html $actionableSkippedRows)</div></td>
  </tr>
</table>
"@
  }

  $followUpHtml = ""
  if ($failedRows -gt 0) {
    $followUpHtml = "<div style='margin:16px 0 0;padding:12px 14px;border:1px solid #fdba74;border-radius:10px;background:#fff7ed;color:#9a3412;'><strong>Action required:</strong> Review each error below. Transient failures remain retryable for the next sync; validation or collision errors require correction in FCUNO or Exchange.</div>"
  } elseif ($actionableSkippedRows -gt 0) {
    $followUpHtml = "<div style='margin:16px 0 0;padding:12px 14px;border:1px solid #fde047;border-radius:10px;background:#fefce8;color:#854d0e;'><strong>Note:</strong> Skipped changes made no Exchange update. Each skipped reason is shown below.</div>"
  } elseif ($supersededRows -gt 0) {
    $followUpHtml = "<div style='margin:16px 0 0;padding:12px 14px;border:1px solid #bfdbfe;border-radius:10px;background:#eff6ff;color:#1e40af;'><strong>Note:</strong> $supersededRows earlier autosave row(s) were safely superseded by the final value and are not listed as separate changes below.</div>"
  }

  $html = @"
<div style="margin:0;padding:20px;background:#f1f5f9;font-family:Roboto,Arial,sans-serif;color:#0f172a;line-height:1.45;">
  <div style="max-width:920px;margin:0 auto;border:1px solid #cbd5e1;border-radius:14px;background:#ffffff;overflow:hidden;">
    <div style="padding:20px 22px;background:#0f172a;color:#ffffff;">
      <div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#cbd5e1;">FC Uno Exchange</div>
      <h2 style="margin:5px 0 0;font-size:22px;">Address book sync</h2>
    </div>
    <div style="padding:20px 22px;">
      <span style="display:inline-block;padding:5px 10px;border:1px solid $statusBorder;border-radius:999px;background:$statusBackground;color:$statusColor;font-size:12px;font-weight:900;">$(Escape-Html $statusText)</span>
      <p style="margin:12px 0 0;font-size:14px;">$(Escape-Html $Message)</p>
      <table role="presentation" style="margin-top:12px;border-collapse:collapse;font-size:12px;color:#475569;">
        <tr><td style="padding:2px 12px 2px 0;font-weight:700;">Requested by</td><td style="padding:2px 0;">$(Escape-Html $requestedBy)</td></tr>
        <tr><td style="padding:2px 12px 2px 0;font-weight:700;">Requested at</td><td style="padding:2px 0;">$(Escape-Html $startedAt)</td></tr>
      </table>
      $metricsHtml
      $followUpHtml

      <h3 style="margin:22px 0 8px;font-size:16px;">Change results</h3>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;border:1px solid #cbd5e1;font-size:12px;">
          <thead>
            <tr style="background:#e2e8f0;color:#334155;text-align:left;">
              <th style="padding:9px 8px;border-bottom:1px solid #cbd5e1;">Status</th>
              <th style="padding:9px 8px;border-bottom:1px solid #cbd5e1;">Requested change</th>
              <th style="padding:9px 8px;border-bottom:1px solid #cbd5e1;">Item</th>
              <th style="padding:9px 8px;border-bottom:1px solid #cbd5e1;">Exchange result</th>
            </tr>
          </thead>
          <tbody>$changeRows</tbody>
        </table>
      </div>

      <h3 style="margin:22px 0 8px;font-size:16px;">Summary</h3>
      <table style="width:100%;max-width:460px;border-collapse:collapse;font-size:12px;">$detailsRows</table>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:10px;">Queue result statuses and Exchange verification details are recorded for audit and troubleshooting.</p>
    </div>
  </div>
</div>
"@

  try {
    $subject = "Exchange address book sync: $statusText"
    if ($hasQueueStats) {
      $subject += " - $completedRows completed, $failedRows failed, $actionableSkippedRows skipped"
    }
    Send-ExchangeSmtpMail $from @($recipients) $subject $html
  } catch {
    Write-Warning ("Exchange sync notification email failed: {0}" -f $_.Exception.Message)
  }
}

function Add-FullSyncFailure([hashtable]$Stats, $EntityType, $DisplayName, $Identifier, $Result) {
  Increment-Stat $Stats "failedQueueRows"
  $Stats["changeDetails"] = @($Stats["changeDetails"]) + [pscustomobject]@{
    status = "failed"
    action = "full_sync"
    actionLabel = "Full reconciliation"
    entityType = Clean-Text $EntityType
    displayName = Clean-Text $DisplayName
    identifier = Clean-Text $Identifier
    result = Clean-Text $Result
    queueRowId = ""
    eventId = ""
    actorId = ""
    requestedBy = ""
    queuedAt = ""
    attempt = 1
    fieldChanges = @()
  }
}

function Invoke-FullExchangeSync {
  $stats = @{
    syncMode = "full"
    contacts = 0
    groups = 0
    groupMembers = 0
    failedQueueRows = 0
    skippedQueueRows = 0
    verifiedQueueRows = 0
    changeDetails = @()
    addedMemberEmails = @()
    removedMemberEmails = @()
    createdContacts = 0
    updatedContacts = 0
    removedContacts = 0
    createdGroups = 0
    updatedGroups = 0
    removedGroups = 0
    addedMembers = 0
    removedMembers = 0
  }

  $script:CanonicalExchangeRows = $null
  $exchangeRows = Get-CanonicalExchangeRows
  $stats["contacts"] = @($exchangeRows.Contacts).Count
  $stats["groups"] = @($exchangeRows.Groups).Count
  $stats["groupMembers"] = @($exchangeRows.Members).Count

  foreach ($invalid in @($exchangeRows.InvalidContacts)) {
    Add-FullSyncFailure $stats "Contact" $invalid.DisplayName $invalid.Email "FCUNO validation failed: $($invalid.Reason). No Exchange mutation was attempted for this row."
  }

  $aliasCounts = @{}
  foreach ($recipient in @($exchangeRows.Contacts) + @($exchangeRows.Groups)) {
    $baseAlias = (Clean-Text $recipient.BaseAlias).ToLowerInvariant()
    if (-not $baseAlias) { continue }
    if (-not (Has-MapKey $aliasCounts $baseAlias)) { $aliasCounts[$baseAlias] = 0 }
    $aliasCounts[$baseAlias] = [int]$aliasCounts[$baseAlias] + 1
  }
  foreach ($baseAlias in @($aliasCounts.Keys | Where-Object { [int]$aliasCounts[$_] -gt 1 } | Sort-Object)) {
    try {
      Sync-ExchangeAliasPeers $baseAlias $stats
    } catch {
      Add-FullSyncFailure $stats "Alias collision" $baseAlias $baseAlias $_.Exception.Message
    }
  }

  $contactIndex = 0
  foreach ($contact in @($exchangeRows.Contacts)) {
    $contactIndex += 1
    try {
      if ($contactIndex % 50 -eq 0) { Renew-ExchangeSyncLock }
      Upsert-ExchangeMailContact $contact $stats
      if ($contactIndex % 100 -eq 0) { Write-Host ("Reconciled {0} of {1} FCUNO contacts." -f $contactIndex, @($exchangeRows.Contacts).Count) }
    } catch {
      Add-FullSyncFailure $stats "Contact" $contact.DisplayName $contact.ExternalEmailAddress $_.Exception.Message
      Write-Warning ("Full reconciliation failed for contact {0}: {1}" -f $contact.DisplayName, $_.Exception.Message)
    }
  }

  $groupIndex = 0
  foreach ($group in @($exchangeRows.Groups)) {
    $groupIndex += 1
    try {
      if ($groupIndex % 20 -eq 0) { Renew-ExchangeSyncLock }
      $members = @($exchangeRows.Members | Where-Object { (Clean-Text $_.SourceGroupId) -eq (Clean-Text $group.SourceGroupId) })
      Sync-ExchangeGroupMembers $group $members $stats
    } catch {
      Add-FullSyncFailure $stats "Group" $group.GroupName $group.Alias $_.Exception.Message
      Write-Warning ("Full reconciliation failed for group {0}: {1}" -f $group.GroupName, $_.Exception.Message)
    }
  }

  $desiredContactSourceKeys = @{}
  $desiredContactEmails = @{}
  foreach ($contact in @($exchangeRows.Contacts)) {
    $desiredContactSourceKeys[(Clean-Text $contact.SourceKey)] = $true
    $desiredContactEmails[(Normalize-Email $contact.ExternalEmailAddress)] = $true
  }
  $managedContacts = @(Get-MailContact -ResultSize Unlimited -Filter "CustomAttribute1 -eq '$ManagedMarker'" -ErrorAction Stop)
  foreach ($managedContact in $managedContacts) {
    $sourceKey = Clean-Text $managedContact.CustomAttribute2
    $email = Get-RecipientEmail $managedContact
    $isDesired = ($sourceKey -and (Has-MapKey $desiredContactSourceKeys $sourceKey)) -or ($email -and (Has-MapKey $desiredContactEmails $email))
    if ($isDesired) { continue }
    try {
      Remove-MailContact -Identity $managedContact.Identity -Confirm:$false -ErrorAction Stop
      $verified = Get-MailContact -Identity $managedContact.Identity -ErrorAction SilentlyContinue
      if ($verified) { throw "Exchange still returns the removed managed contact." }
      Increment-Stat $stats "removedContacts"
    } catch {
      Add-FullSyncFailure $stats "Contact" $managedContact.DisplayName $email ("Could not remove stale managed contact: " + $_.Exception.Message)
    }
  }

  $desiredGroupSourceKeys = @{}
  $desiredGroupAliases = @{}
  foreach ($group in @($exchangeRows.Groups)) {
    $desiredGroupSourceKeys[(Clean-Text $group.SourceKey)] = $true
    $desiredGroupAliases[(Clean-Text $group.Alias).ToLowerInvariant()] = $true
  }
  $managedGroups = @(Get-DistributionGroup -ResultSize Unlimited -Filter "CustomAttribute1 -eq '$ManagedMarker'" -ErrorAction Stop)
  foreach ($managedGroup in $managedGroups) {
    $sourceKey = Clean-Text $managedGroup.CustomAttribute2
    $alias = (Clean-Text $managedGroup.Alias).ToLowerInvariant()
    $isDesired = ($sourceKey -and (Has-MapKey $desiredGroupSourceKeys $sourceKey)) -or ($alias -and (Has-MapKey $desiredGroupAliases $alias))
    if ($isDesired) { continue }
    try {
      Remove-DistributionGroup -Identity $managedGroup.Identity -Confirm:$false -ErrorAction Stop
      $verified = Get-DistributionGroup -Identity $managedGroup.Identity -ErrorAction SilentlyContinue
      if ($verified) { throw "Exchange still returns the removed managed group." }
      Increment-Stat $stats "removedGroups"
    } catch {
      Add-FullSyncFailure $stats "Group" $managedGroup.DisplayName $alias ("Could not remove stale managed group: " + $_.Exception.Message)
    }
  }

  $finalManagedContacts = @(Get-MailContact -ResultSize Unlimited -Filter "CustomAttribute1 -eq '$ManagedMarker'" -ErrorAction Stop)
  $finalManagedGroups = @(Get-DistributionGroup -ResultSize Unlimited -Filter "CustomAttribute1 -eq '$ManagedMarker'" -ErrorAction Stop)
  $stats["verifiedManagedContacts"] = $finalManagedContacts.Count
  $stats["verifiedManagedGroups"] = $finalManagedGroups.Count
  if ($finalManagedContacts.Count -ne @($exchangeRows.Contacts).Count) {
    Add-FullSyncFailure $stats "Full address book" "Managed contacts" "$($finalManagedContacts.Count) in Exchange / $(@($exchangeRows.Contacts).Count) in FCUNO" "Final managed-contact count does not match the canonical FCUNO projection."
  }
  if ($finalManagedGroups.Count -ne @($exchangeRows.Groups).Count) {
    Add-FullSyncFailure $stats "Full address book" "Managed groups" "$($finalManagedGroups.Count) in Exchange / $(@($exchangeRows.Groups).Count) in FCUNO" "Final managed-group count does not match the canonical FCUNO projection."
  }

  return $stats
}

if ($LibraryOnly) { return }

$webhookPayload = Get-WebhookPayload $WebhookData
$syncMode = (Clean-Text $webhookPayload.syncMode).ToLowerInvariant()
if (-not $syncMode) { $syncMode = "incremental" }
$script:CurrentQueueRunId = [Guid]::NewGuid().ToString()
$details = $null

try {
  if (-not (Acquire-ExchangeSyncLock $syncMode)) {
    Write-Output "Exchange address book sync did not start because another full or incremental sync currently holds the mutation lease. Durable queue rows remain pending for the next run."
    return
  }
  $script:SyncLockAcquired = $true
  Save-SyncStatus "running" "Exchange sync is running."

  Import-ExchangeOnlineManagementModule

  $appId = Get-AutomationSetting "EXCHANGE_APP_ID"
  $tenantId = Get-AutomationSetting "EXCHANGE_TENANT_ID"
  $organization = Get-AutomationSetting "EXCHANGE_ORGANIZATION"
  Assert-ExchangeSettings $appId $tenantId $organization
  $pfxBase64 = Get-AutomationSetting "EXCHANGE_CERT_PFX_BASE64"
  $pfxPassword = Get-AutomationSetting "EXCHANGE_CERT_PASSWORD"
  $pfxPath = Join-Path $env:TEMP "fcuno-exchange-sync.pfx"
  [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($pfxBase64))
  $securePassword = ConvertTo-SecureString $pfxPassword -AsPlainText -Force

  Connect-ExchangeOnline -AppId $appId -CertificateFilePath $pfxPath -CertificatePassword $securePassword -Organization $organization -ShowBanner:$false -ErrorAction Stop
  $script:ExchangeOnlineConnected = $true

  if ($syncMode -ne "full") {
    $details = Get-StatsObject (Invoke-IncrementalExchangeSync)
    Write-Output ("Exchange incremental sync summary: {0}" -f ($details | ConvertTo-Json -Compress))
    $failedRows = [int]$details.failedQueueRows
    $completedRows = [int]$details.completedQueueRows
    $skippedRows = [int]$details.skippedQueueRows
    $supersededRows = [int]$details.supersededQueueRows
    $actionableSkippedRows = [Math]::Max(0, $skippedRows - $supersededRows)
    if ($failedRows -gt 0) {
      $message = "Exchange incremental sync failed for $failedRows change(s); $completedRows other change(s) completed and were verified."
      Save-SyncStatus "failed" $message $details
      Send-ExchangeSyncNotification "failed" $message $details $webhookPayload
    } elseif ([int]$details.queuedRows -le 0) {
      $message = "Exchange incremental sync completed. No pending changes were queued."
      Save-SyncStatus "completed" $message $details
      if ($WebhookData) { Send-ExchangeSyncNotification "completed" $message $details $webhookPayload }
    } elseif ($actionableSkippedRows -gt 0) {
      $message = "Exchange incremental sync failed because $actionableSkippedRows requested change(s) were skipped."
      Save-SyncStatus "failed" $message $details
      Send-ExchangeSyncNotification "failed" $message $details $webhookPayload
    } else {
      $message = "Exchange incremental sync completed."
      Save-SyncStatus "completed" $message $details
      Send-ExchangeSyncNotification "completed" $message $details $webhookPayload
    }
    return
  }

  $details = Get-StatsObject (Invoke-FullExchangeSync)
  Write-Output ("Exchange full sync summary: {0}" -f ($details | ConvertTo-Json -Depth 8 -Compress))
  if ([int]$details.failedQueueRows -gt 0) {
    $message = "Exchange full reconciliation failed with $([int]$details.failedQueueRows) validation or verification error(s)."
    Save-SyncStatus "failed" $message $details
    Send-ExchangeSyncNotification "failed" $message $details $webhookPayload
  } else {
    $message = "Exchange full reconciliation completed and verified."
    Save-SyncStatus "completed" $message $details
    Send-ExchangeSyncNotification "completed" $message $details $webhookPayload
  }
  return
} catch {
  $syncError = $_
  try {
    Save-SyncStatus "failed" $syncError.Exception.Message
  } catch {
    Write-Warning ("Could not save Exchange sync failure status: {0}" -f $_.Exception.Message)
  }
  Send-ExchangeSyncNotification "failed" $syncError.Exception.Message $details $webhookPayload
  throw
} finally {
  if ($script:ExchangeOnlineConnected -and (Get-Module -Name ExchangeOnlineManagement)) {
    Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
  }
  Release-ExchangeSyncLock
}
