param(
  [object]$WebhookData
)

$ErrorActionPreference = "Stop"

function Get-AutomationSetting($Name) {
  $value = Get-AutomationVariable -Name $Name -ErrorAction SilentlyContinue
  if (-not $value) {
    throw "Missing Automation variable: $Name"
  }
  return $value
}

function Invoke-SupabaseRest($Method, $Path, $Body = $null) {
  $supabaseUrl = (Get-AutomationSetting "NEXT_PUBLIC_SUPABASE_URL").TrimEnd("/")
  $serviceRoleKey = Get-AutomationSetting "SUPABASE_SERVICE_ROLE_KEY"
  $headers = @{
    apikey = $serviceRoleKey
    Authorization = "Bearer $serviceRoleKey"
  }
  if ($Body) {
    $headers["Content-Type"] = "application/json"
    if ($Method -eq "POST") {
      $headers["Prefer"] = "resolution=merge-duplicates"
    }
    return Invoke-RestMethod -Method $Method -Uri "$supabaseUrl/rest/v1/$Path" -Headers $headers -Body ($Body | ConvertTo-Json -Depth 20)
  }
  return Invoke-RestMethod -Method $Method -Uri "$supabaseUrl/rest/v1/$Path" -Headers $headers
}

function Clean-Text($Value) {
  if ($null -eq $Value) { return "" }
  return ([string]$Value -replace "\s+", " ").Trim()
}

function Get-ExchangeAlias($Value, $Fallback) {
  $base = (Clean-Text $(if ($Value) { $Value } else { $Fallback })).ToLower()
  $base = $base -replace "&", " and "
  $base = $base -replace "[^a-z0-9._-]+", "-"
  $base = $base -replace "^[.-]+|[.-]+$", ""
  if ($base.Length -gt 58) { $base = $base.Substring(0, 58) }
  if ($base) { return $base }
  return $Fallback
}

function Get-UniqueAlias($BaseAlias, [hashtable]$SeenAliases) {
  $alias = $BaseAlias
  $index = 2
  while ($SeenAliases.ContainsKey($alias)) {
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
  $domain = ((Clean-Text $Email).ToLower().Split("@") | Select-Object -Last 1)
  return $internalDomains -contains $domain
}

function Load-AllRows($Table, $OrderColumn) {
  $rows = @()
  $pageSize = 1000
  $from = 0
  while ($true) {
    $to = $from + $pageSize - 1
    $path = "$Table" + "?select=*&order=$OrderColumn.asc&offset=$from&limit=$pageSize"
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
  $seenContactAliases = @{}
  $contactRows = @()
  $contactById = @{}

  foreach ($contact in $Contacts) {
    $email = (Clean-Text $contact.primary_email).ToLower()
    if (-not $email -or $seenEmails.ContainsKey($email)) { continue }

    $displayName = Clean-Text $(if ($contact.display_name) { $contact.display_name } else { $email })
    $aliasSeed = if ($contact.nickname) { $contact.nickname } else { $displayName }
    $row = [pscustomobject]@{
      SourceBook = Clean-Text $contact.source_book
      SourceContactId = $contact.id
      DisplayName = $displayName
      FirstName = Clean-Text $contact.first_name
      LastName = Clean-Text $contact.last_name
      Alias = Get-UniqueAlias (Get-ExchangeAlias $aliasSeed "contact-$($contactRows.Count + 1)") $seenContactAliases
      ExternalEmailAddress = $email
      Nickname = Clean-Text $contact.nickname
    }

    if (-not (Is-InternalEmail $email)) { $contactRows += $row }
    $seenEmails[$email] = $true
    $contactById[$contact.id] = $row
  }

  $seenGroupAliases = @{}
  $groupRows = @()
  foreach ($group in $Groups) {
    if ([int]($group.member_count ?? 0) -le 0) { continue }
    $name = Clean-Text $(if ($group.name) { $group.name } elseif ($group.nickname) { $group.nickname } else { $group.source_uid })
    if (-not $name) { continue }
    $aliasSeed = if ($group.nickname) { $group.nickname } else { $name }
    $groupRows += [pscustomobject]@{
      SourceBook = Clean-Text $group.source_book
      SourceGroupId = $group.id
      GroupName = $name
      Alias = Get-UniqueAlias (Get-ExchangeAlias $aliasSeed "group-$($groupRows.Count + 1)") $seenGroupAliases
      Description = Clean-Text $group.description
      MemberCount = 0
    }
  }

  $groupById = @{}
  foreach ($groupRow in $groupRows) { $groupById[$groupRow.SourceGroupId] = $groupRow }
  $seenMembers = @{}
  $memberRows = @()

  foreach ($member in $Members) {
    $group = $groupById[$member.group_id]
    $contact = $contactById[$member.contact_id]
    if (-not $group -or -not $contact) { continue }
    $key = "$($group.Alias)`0$($contact.ExternalEmailAddress)"
    if ($seenMembers.ContainsKey($key)) { continue }
    $seenMembers[$key] = $true
    $group.MemberCount = [int]$group.MemberCount + 1
    $memberRows += [pscustomobject]@{
      GroupName = $group.GroupName
      GroupAlias = $group.Alias
      MemberDisplayName = $contact.DisplayName
      MemberEmail = $contact.ExternalEmailAddress
    }
  }

  return @{
    Contacts = $contactRows
    Groups = @($groupRows | Where-Object { [int]$_.MemberCount -gt 0 })
    Members = $memberRows
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

try {
  Save-SyncStatus "running" "Exchange sync is running."

  if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
    Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force -AllowClobber
  }
  Import-Module ExchangeOnlineManagement

  $appId = Get-AutomationSetting "EXCHANGE_APP_ID"
  $tenantId = Get-AutomationSetting "EXCHANGE_TENANT_ID"
  $organization = Get-AutomationSetting "EXCHANGE_ORGANIZATION"
  $pfxBase64 = Get-AutomationSetting "EXCHANGE_CERT_PFX_BASE64"
  $pfxPassword = Get-AutomationSetting "EXCHANGE_CERT_PASSWORD"
  $pfxPath = Join-Path $env:TEMP "fcuno-exchange-sync.pfx"
  [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($pfxBase64))
  $securePassword = ConvertTo-SecureString $pfxPassword -AsPlainText -Force

  Connect-ExchangeOnline -AppId $appId -CertificateFilePath $pfxPath -CertificatePassword $securePassword -Organization $organization -ShowBanner:$false

  $contacts = Load-AllRows "shared_addressbook_contacts" "display_name"
  $groups = Load-AllRows "shared_addressbook_groups" "name"
  $members = Load-AllRows "shared_addressbook_group_members" "source_book"
  $exchangeRows = Build-ExchangeRows $contacts $groups $members

  $createdContacts = 0
  $updatedContacts = 0
  foreach ($contact in $exchangeRows.Contacts) {
    $existing = Get-MailContact -Filter "ExternalEmailAddress -eq '$($contact.ExternalEmailAddress)'" -ErrorAction SilentlyContinue
    if ($existing) {
      Set-MailContact -Identity $existing.Identity -DisplayName $contact.DisplayName -FirstName $contact.FirstName -LastName $contact.LastName -HiddenFromAddressListsEnabled $false -ErrorAction Stop
      $updatedContacts += 1
    } else {
      New-MailContact -Name $contact.DisplayName -DisplayName $contact.DisplayName -ExternalEmailAddress $contact.ExternalEmailAddress -Alias $contact.Alias | Out-Null
      Set-MailContact -Identity $contact.ExternalEmailAddress -HiddenFromAddressListsEnabled $false -ErrorAction Stop
      $createdContacts += 1
    }
  }

  $createdGroups = 0
  $updatedGroups = 0
  foreach ($group in $exchangeRows.Groups) {
    $existing = Get-DistributionGroup -Identity $group.Alias -ErrorAction SilentlyContinue
    if ($existing) {
      Set-DistributionGroup -Identity $group.Alias -DisplayName $group.GroupName -Notes $group.Description -HiddenFromAddressListsEnabled $false -ErrorAction Stop
      $updatedGroups += 1
    } else {
      New-DistributionGroup -Name $group.GroupName -Alias $group.Alias -Notes $group.Description | Out-Null
      Set-DistributionGroup -Identity $group.Alias -HiddenFromAddressListsEnabled $false -ErrorAction Stop
      $createdGroups += 1
    }
  }

  $addedMembers = 0
  foreach ($member in $exchangeRows.Members) {
    try {
      Add-DistributionGroupMember -Identity $member.GroupAlias -Member $member.MemberEmail -ErrorAction Stop
      $addedMembers += 1
    } catch {
      if ($_.Exception.Message -notmatch "already a member") {
        Write-Warning ("Could not add {0} to {1}: {2}" -f $member.MemberEmail, $member.GroupName, $_.Exception.Message)
      }
    }
  }

  $details = @{
    contacts = $exchangeRows.Contacts.Count
    groups = $exchangeRows.Groups.Count
    groupMembers = $exchangeRows.Members.Count
    createdContacts = $createdContacts
    updatedContacts = $updatedContacts
    createdGroups = $createdGroups
    updatedGroups = $updatedGroups
    addedMembers = $addedMembers
  }
  Save-SyncStatus "completed" "Exchange sync completed." $details
} catch {
  Save-SyncStatus "failed" $_.Exception.Message
  throw
} finally {
  Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
}
