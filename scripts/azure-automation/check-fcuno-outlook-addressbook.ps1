param(
  [switch]$LibraryOnly,
  [ValidateRange(60, 7200)][int]$MaxDurationSeconds = 2400,
  [ValidateRange(1, 100)][int]$MaxDetails = 30,
  [ValidateRange(100, 1000)][int]$PageSize = 500,
  [ValidateRange(1, 100)][int]$GroupBatchSize = 20
)

# A separate, manually invoked diagnostic. Never schedules, repairs, certifies,
# refreshes template state, renews a lease, writes status, or sends a message.
$ErrorActionPreference = 'Stop'
$WarningPreference = 'Stop'
$script:CurrentCheckClock = $null
$script:CurrentCheckConnected = $false
$script:CurrentCheckConnectionAttempted = $false
$script:CurrentCheckConnectionId = $null
$script:CurrentCheckCertificate = $null
$script:CurrentCheckServiceKey = $null
$script:CurrentCheckMaxRows = 100000

# BEGIN GENERATED CURRENT CHECK HELPERS
# Offline AST-selected pure helpers; exact bodies retain worker projection semantics.
$CurrentCheckVersion = 'fcuno-current-addressbook-check/2026-10-28.1'
$CurrentCheckWorkerSourceSha256 = '6c85d2712d5963beda3095afb9e6cb50300ff7620c215eae70d1e901aace504e'
$CurrentCheckConfigSha256 = '53acdcf6b2ca066fa46ccfa8488948b662c1e71e5b1575621a59bb224f3eb4b4'
$CurrentCheckSupabaseOrigin = 'https://gglyugbrnyvyfktgwert.supabase.co'
$CurrentCheckExpectedAppId = '1bf8841e-99a9-43fe-a8f7-85aedbd7bdc1'
$CurrentCheckTenantId = '70011d0d-19b4-4a61-8195-ab1fd987c20f'
$CanonicalExchangeAddressBookDomain = 'cosulich1.onmicrosoft.com'
$ManagedMarker = 'FCUNO_SHARED_ADDRESSBOOK'
$ExchangeDirectoryNameCollisionSourceKeys = @(
  "FCUNO_CONTACT:3f7e1efa4cff782afea6f0e0e672a90f1824cfa8"
)
function Add-ExchangeLookupEntry([hashtable]$Map, $Key, $Value) {
  $cleanKey = Clean-Text $Key
  if (-not $cleanKey) { return }
  if (Has-MapKey $Map $cleanKey) {
    $Map[$cleanKey] = @($Map[$cleanKey]) + @($Value)
  } else {
    $Map[$cleanKey] = @($Value)
  }
}

function Build-ExchangeRows($Contacts, $Groups, $Members) {
  $seenEmails = @{}
  $seenAliases = @{}
  $allContactRows = @()
  $contactRows = @()
  $contactById = @{}
  $contactDependencyById = @{}
  $contactByEmail = @{}
  $contactIdsByEmail = @{}
  $invalidContactCandidates = @()
  $invalidContacts = @()
  $skippedInvalidContacts = @()
  $duplicateContacts = @()

  $orderedContacts = @($Contacts | Sort-Object `
    @{ Expression = { Normalize-Email $_.primary_email }; Ascending = $true }, `
    @{ Expression = {
      $updated = [DateTimeOffset]::MinValue
      if ([DateTimeOffset]::TryParse((Clean-Text $_.updated_at), [ref]$updated)) { return $updated }
      return [DateTimeOffset]::MinValue
    }; Descending = $true }, `
    @{ Expression = { Clean-Text $_.id }; Ascending = $true })

  $internalEmails = @{}
  foreach ($contact in $orderedContacts) {
    $email = Normalize-Email $contact.primary_email
    if (-not (Test-ValidEmail $email)) { continue }
    $sourceContactId = Clean-Text $contact.id
    $displayName = Clean-Text $(if ($contact.display_name) { $contact.display_name } else { $email })
    $aliasSeed = if ($contact.nickname) { $contact.nickname } else { $displayName }
    $baseAlias = Get-ExchangeAlias $aliasSeed ("contact-" + $sourceContactId)
    $isInternalSource = Is-InternalContact $contact $email
    if ($isInternalSource) { $internalEmails[$email] = $true }
    $contactDependencyById[$sourceContactId] = [pscustomobject]@{
      SourceBook = Clean-Text $contact.source_book
      SourceContactId = $sourceContactId
      DisplayName = $displayName
      BaseAlias = $baseAlias
      ExternalEmailAddress = $email
      IsInternalSource = [bool]$isInternalSource
      SourceKey = Get-ContactSourceKey $sourceContactId
    }
  }

  foreach ($contact in $orderedContacts) {
    $email = Normalize-Email $contact.primary_email
    if (-not (Test-ValidEmail $email)) {
      $invalidContactCandidates += [pscustomobject]@{
        SourceBook = Clean-Text $contact.source_book
        SourceContactId = Clean-Text $contact.id
        DisplayName = Clean-Text $contact.display_name
        Email = $email
        EmbeddedValidEmails = @(Get-EmbeddedContactValidEmails $contact)
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

    $sourceContactId = Clean-Text $contact.id
    $dependencyRow = $contactDependencyById[$sourceContactId]
    $displayName = Clean-Text $dependencyRow.DisplayName
    $baseAlias = Clean-Text $dependencyRow.BaseAlias
    $row = [pscustomobject]@{
      SourceBook = Clean-Text $contact.source_book
      SourceContactId = $sourceContactId
      DisplayName = $displayName
      FirstName = Clean-Text $contact.first_name
      LastName = Clean-Text $contact.last_name
      BaseAlias = $baseAlias
      Alias = ""
      ExternalEmailAddress = $email
      Nickname = Clean-Text $contact.nickname
      SourceKey = Get-ContactSourceKey $contact.id
      IsInternalSource = [bool]$dependencyRow.IsInternalSource
      HasInternalSource = [bool](Has-MapKey $internalEmails $email)
    }

    $allContactRows += $row
    if (-not (Is-InternalContact $row $email)) { $contactRows += $row }
    $seenEmails[$email] = $row
    $contactByEmail[$email] = $row
    $contactIdsByEmail[$email] = @((Clean-Text $contact.id))
    $contactById[(Clean-Text $contact.id)] = $row
  }

  $internalAliasBySourceId = @{}
  $internalAliasReservations = @($contactDependencyById.Values |
    Where-Object { [bool]$_.IsInternalSource } |
    Sort-Object BaseAlias, SourceContactId)
  foreach ($reservation in $internalAliasReservations) {
    $reservedAlias = Get-UniqueAlias `
      $reservation.BaseAlias `
      $seenAliases `
      ("contact:" + (Clean-Text $reservation.SourceContactId))
    $internalAliasBySourceId[(Clean-Text $reservation.SourceContactId)] = $reservedAlias
    $reservation | Add-Member -NotePropertyName Alias -NotePropertyValue $reservedAlias -Force
  }
  $aliasOrderedContactRows = @(
    @($allContactRows | Where-Object { Is-InternalContact $_ $_.ExternalEmailAddress }) +
    @($allContactRows | Where-Object { -not (Is-InternalContact $_ $_.ExternalEmailAddress) })
  )
  foreach ($contactRow in $aliasOrderedContactRows) {
    $sourceContactId = Clean-Text $contactRow.SourceContactId
    if (Has-MapKey $internalAliasBySourceId $sourceContactId) {
      $contactRow.Alias = $internalAliasBySourceId[$sourceContactId]
    } else {
      $contactRow.Alias = Get-UniqueAlias $contactRow.BaseAlias $seenAliases ("contact:" + $sourceContactId)
    }
  }

  $directoryNameCounts = @{}
  foreach ($contactRow in @($contactRows)) {
    $baseName = Get-ExchangeDirectoryNameBase $contactRow.DisplayName
    $nameKey = $baseName.ToLowerInvariant()
    if (-not (Has-MapKey $directoryNameCounts $nameKey)) { $directoryNameCounts[$nameKey] = 0 }
    $directoryNameCounts[$nameKey] = [int]$directoryNameCounts[$nameKey] + 1
  }
  $seenDirectoryNames = @{}
  foreach ($contactRow in @($contactRows)) {
    $baseName = Get-ExchangeDirectoryNameBase $contactRow.DisplayName
    $forceStableSuffix = (
      [int]$directoryNameCounts[$baseName.ToLowerInvariant()] -gt 1 -or
      (Test-ExchangeDirectoryNameRequiresStableSuffix $contactRow.SourceKey)
    )
    $directoryName = Get-UniqueExchangeDirectoryName $contactRow.DisplayName $seenDirectoryNames $contactRow.SourceKey $forceStableSuffix
    $contactRow | Add-Member -NotePropertyName DirectoryName -NotePropertyValue $directoryName -Force
  }

  foreach ($email in @($contactByEmail.Keys)) {
    $canonicalContact = $contactByEmail[$email]
    $allowedOwnerSourceKeys = @($contactIdsByEmail[$email] | ForEach-Object { Get-ContactSourceKey $_ })
    $canonicalContact | Add-Member -NotePropertyName AllowedOwnerSourceKeys -NotePropertyValue $allowedOwnerSourceKeys -Force
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
      SmtpAddress = ""
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

  # Empty FCUNO groups are deliberately absent from Exchange, so they must not reserve a
  # directory Name. When multiple projected groups share one base name, suffix every peer
  # deterministically so no input-order-dependent peer owns the unsuffixed identity.
  $projectedGroupRows = @($groupRows | Where-Object { [int]$_.MemberCount -gt 0 })
  $groupDirectoryNameCounts = @{}
  foreach ($groupRow in $projectedGroupRows) {
    $baseName = Get-ExchangeDirectoryNameBase $groupRow.GroupName
    $baseKey = $baseName.ToLowerInvariant()
    if (-not (Has-MapKey $groupDirectoryNameCounts $baseKey)) { $groupDirectoryNameCounts[$baseKey] = 0 }
    $groupDirectoryNameCounts[$baseKey] = [int]$groupDirectoryNameCounts[$baseKey] + 1
  }
  foreach ($groupRow in $projectedGroupRows) {
    $baseName = Get-ExchangeDirectoryNameBase $groupRow.GroupName
    $forceStableSuffix = [int]$groupDirectoryNameCounts[$baseName.ToLowerInvariant()] -gt 1
    $directoryName = Get-UniqueExchangeDirectoryName $groupRow.GroupName $seenDirectoryNames $groupRow.SourceKey $forceStableSuffix
    $groupRow | Add-Member -NotePropertyName DirectoryName -NotePropertyValue $directoryName -Force
    $groupRow.SmtpAddress = Get-ExpectedExchangeGroupSmtpAddress $groupRow
  }

  $rawMemberContactIds = @{}
  foreach ($member in @($Members)) {
    $rawContactId = Clean-Text $member.contact_id
    if ($rawContactId) { $rawMemberContactIds[$rawContactId] = $true }
  }

  $allGroupsByShadowName = @{}
  foreach ($groupRow in @($groupRows)) {
    $sourceBookKey = (Clean-Text $groupRow.SourceBook).ToLowerInvariant()
    $groupNameKey = (Clean-Text $groupRow.GroupName).ToLowerInvariant()
    if (-not $sourceBookKey -or -not $groupNameKey) { continue }
    $shadowKey = "$sourceBookKey`0$groupNameKey"
    if (-not (Has-MapKey $allGroupsByShadowName $shadowKey)) { $allGroupsByShadowName[$shadowKey] = @() }
    $allGroupsByShadowName[$shadowKey] = @($allGroupsByShadowName[$shadowKey]) + @($groupRow)
  }

  $projectedGroupsByShadowName = @{}
  foreach ($groupRow in @($groupRows | Where-Object { [int]$_.MemberCount -gt 0 })) {
    $sourceBookKey = (Clean-Text $groupRow.SourceBook).ToLowerInvariant()
    $groupNameKey = (Clean-Text $groupRow.GroupName).ToLowerInvariant()
    if (-not $sourceBookKey -or -not $groupNameKey) { continue }
    $shadowKey = "$sourceBookKey`0$groupNameKey"
    if (-not (Has-MapKey $projectedGroupsByShadowName $shadowKey)) { $projectedGroupsByShadowName[$shadowKey] = @() }
    $projectedGroupsByShadowName[$shadowKey] = @($projectedGroupsByShadowName[$shadowKey]) + @($groupRow)
  }

  foreach ($candidate in @($invalidContactCandidates)) {
    $sourceBookKey = (Clean-Text $candidate.SourceBook).ToLowerInvariant()
    $displayName = Clean-Text $candidate.DisplayName
    $invalidEmail = Clean-Text $candidate.Email
    $shadowKey = "$sourceBookKey`0$($displayName.ToLowerInvariant())"
    $matchingGroups = if ($sourceBookKey -and $displayName -and (Has-MapKey $projectedGroupsByShadowName $shadowKey)) {
      @($projectedGroupsByShadowName[$shadowKey] | Sort-Object SourceGroupId)
    } else {
      @()
    }
    $allMatchingGroups = if ($sourceBookKey -and $displayName -and (Has-MapKey $allGroupsByShadowName $shadowKey)) {
      @($allGroupsByShadowName[$shadowKey] | Sort-Object SourceGroupId)
    } else {
      @()
    }
    $sourceId = Clean-Text $candidate.SourceContactId
    $isExactGroupShadow = (
      $invalidEmail.Equals($displayName, [StringComparison]::OrdinalIgnoreCase) -and
      $allMatchingGroups.Count -eq 1 -and
      $matchingGroups.Count -eq 1 -and
      (Clean-Text $allMatchingGroups[0].SourceGroupId) -eq (Clean-Text $matchingGroups[0].SourceGroupId) -and
      -not (Has-MapKey $rawMemberContactIds $sourceId) -and
      @($candidate.EmbeddedValidEmails).Count -eq 0
    )

    if ($isExactGroupShadow) {
      $shadowGroup = $matchingGroups[0]
      $memberCount = [int]$shadowGroup.MemberCount
      $skippedInvalidContacts += [pscustomobject]@{
        SourceBook = Clean-Text $candidate.SourceBook
        SourceContactId = $sourceId
        DisplayName = $displayName
        Email = $invalidEmail
        SourceKey = Get-ContactSourceKey $sourceId
        GroupSourceId = Clean-Text $shadowGroup.SourceGroupId
        GroupName = Clean-Text $shadowGroup.GroupName
        GroupAlias = Clean-Text $shadowGroup.Alias
        GroupSourceKey = Clean-Text $shadowGroup.SourceKey
        ValidMemberCount = $memberCount
        Reason = "Skipped invalid contact placeholder because the same-book group '$($shadowGroup.GroupName)' and its $memberCount valid projected member(s) are the certified Exchange representation."
      }
      continue
    }

    $invalidContacts += [pscustomobject]@{
      SourceBook = Clean-Text $candidate.SourceBook
      SourceContactId = $sourceId
      DisplayName = $displayName
      Email = $invalidEmail
      Reason = "Invalid external email address"
    }
  }

  return @{
    Contacts = $contactRows
    Groups = $projectedGroupRows
    Members = $memberRows
    ContactById = $contactById
    ContactDependencyById = $contactDependencyById
    ContactByEmail = $contactByEmail
    ContactIdsByEmail = $contactIdsByEmail
    GroupById = $groupById
    InvalidContacts = $invalidContacts
    SkippedInvalidContacts = $skippedInvalidContacts
    DuplicateContacts = $duplicateContacts
  }
}

function Clean-Text($Value) {
  if ($null -eq $Value) { return "" }
  return ([string]$Value -replace "\s+", " ").Trim()
}

function Get-CanonicalExchangeProjectionCounts($Rows) {
  if (-not $Rows) { return $null }
  return [ordered]@{
    contacts = @($Rows.Contacts).Count
    groups = @($Rows.Groups).Count
    members = @($Rows.Members).Count
    invalidContacts = @($Rows.InvalidContacts).Count
    skippedInvalidContacts = @($Rows.SkippedInvalidContacts).Count
    duplicateContacts = @($Rows.DuplicateContacts).Count
  }
}

function Get-CanonicalExchangeProjectionJson($Rows) {
  $projection = Get-CanonicalExchangeProjectionPayload $Rows
  if (-not $projection) { return "" }
  return ($projection | ConvertTo-Json -Depth 8 -Compress)
}

function Get-CanonicalExchangeProjectionPayload($Rows) {
  if (-not $Rows) { return $null }
  return [ordered]@{
    contacts = @($Rows.Contacts | Sort-Object SourceKey | ForEach-Object {
      [ordered]@{
        sourceContactId = Clean-Text $_.SourceContactId
        directoryName = Clean-Text $_.DirectoryName
        displayName = Clean-Text $_.DisplayName
        firstName = Clean-Text $_.FirstName
        lastName = Clean-Text $_.LastName
        baseAlias = Clean-Text $_.BaseAlias
        alias = Clean-Text $_.Alias
        externalEmailAddress = Normalize-Email $_.ExternalEmailAddress
        nickname = Clean-Text $_.Nickname
        sourceKey = Clean-Text $_.SourceKey
        allowedOwnerSourceKeys = @($_.AllowedOwnerSourceKeys | ForEach-Object { Clean-Text $_ } | Where-Object { $_ } | Sort-Object -Unique)
      }
    })
    groups = @($Rows.Groups | Sort-Object SourceKey | ForEach-Object {
      [ordered]@{
        sourceGroupId = Clean-Text $_.SourceGroupId
        directoryName = Clean-Text $_.DirectoryName
        groupName = Clean-Text $_.GroupName
        baseAlias = Clean-Text $_.BaseAlias
        alias = Clean-Text $_.Alias
        smtpAddress = Normalize-Email $_.SmtpAddress
        description = Clean-Text $_.Description
        memberCount = [int]$_.MemberCount
        sourceKey = Clean-Text $_.SourceKey
      }
    })
    members = @($Rows.Members | Sort-Object SourceGroupId, MemberEmail, SourceContactId | ForEach-Object {
      [ordered]@{
        groupName = Clean-Text $_.GroupName
        groupAlias = Clean-Text $_.GroupAlias
        memberDisplayName = Clean-Text $_.MemberDisplayName
        memberEmail = Normalize-Email $_.MemberEmail
        sourceGroupId = Clean-Text $_.SourceGroupId
        sourceContactId = Clean-Text $_.SourceContactId
      }
    })
    invalidContacts = @($Rows.InvalidContacts | Sort-Object SourceContactId | ForEach-Object {
      [ordered]@{
        sourceContactId = Clean-Text $_.SourceContactId
        displayName = Clean-Text $_.DisplayName
        email = Normalize-Email $_.Email
        reason = Clean-Text $_.Reason
      }
    })
    skippedInvalidContacts = @($Rows.SkippedInvalidContacts | Sort-Object SourceContactId | ForEach-Object {
      [ordered]@{
        sourceBook = Clean-Text $_.SourceBook
        sourceContactId = Clean-Text $_.SourceContactId
        displayName = Clean-Text $_.DisplayName
        email = Clean-Text $_.Email
        sourceKey = Clean-Text $_.SourceKey
        groupSourceId = Clean-Text $_.GroupSourceId
        groupName = Clean-Text $_.GroupName
        groupAlias = Clean-Text $_.GroupAlias
        groupSourceKey = Clean-Text $_.GroupSourceKey
        validMemberCount = [int]$_.ValidMemberCount
        reason = Clean-Text $_.Reason
      }
    })
    duplicateContacts = @($Rows.DuplicateContacts | Sort-Object SourceContactId | ForEach-Object {
      [ordered]@{
        sourceContactId = Clean-Text $_.SourceContactId
        canonicalSourceContactId = Clean-Text $_.CanonicalSourceContactId
        email = Normalize-Email $_.Email
      }
    })
  }
}

function Get-ContactSourceKey($SourceContactId) {
  $sourceId = Clean-Text $SourceContactId
  if (-not $sourceId) { return "" }
  return "FCUNO_CONTACT:$sourceId"
}

function Get-EmbeddedContactValidEmails($Contact) {
  $payloads = @()
  $vcard = Clean-Text (Get-MapValue $Contact "vcard")
  if ($vcard) { $payloads += $vcard }

  $properties = Get-MapValue $Contact "properties"
  if ($null -ne $properties) {
    try {
      $payloads += ($properties | ConvertTo-Json -Depth 20 -Compress)
    } catch {
      $propertiesText = Clean-Text $properties
      if ($propertiesText) { $payloads += $propertiesText }
    }
  }

  $validEmails = @{}
  foreach ($payload in @($payloads)) {
    foreach ($match in [regex]::Matches((Clean-Text $payload), "(?i)[a-z0-9.!#$%&'*+/=?^_``{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+")) {
      $email = Normalize-Email $match.Value
      if (Test-ValidEmail $email) { $validEmails[$email] = $true }
    }
  }
  return @($validEmails.Keys | Sort-Object)
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

function Get-ExchangeContactDirectoryName($Contact) {
  $directoryName = Clean-Text (Get-MapValue $Contact "DirectoryName")
  if (-not $directoryName) { $directoryName = Clean-Text (Get-MapValue $Contact "DisplayName") }
  if (-not $directoryName) { throw "The Exchange contact directory name is missing." }
  if ($directoryName.Length -gt 64) { throw "The Exchange contact directory name exceeds 64 characters." }
  return $directoryName
}

function Get-ExchangeContactProfileImmutableJoinKeys($ExchangeObject) {
  if (-not $ExchangeObject) { return @() }
  $seen = @{}
  foreach ($propertyName in @("Guid", "ExternalDirectoryObjectId", "DistinguishedName")) {
    $value = Clean-Text $ExchangeObject.$propertyName
    if (-not $value -or $value -eq "00000000-0000-0000-0000-000000000000") { continue }
    $key = $value.ToLowerInvariant()
    if (Has-MapKey $seen $key) { continue }
    $seen[$key] = $true
    Write-Output $key
  }

  $identity = Clean-Text $ExchangeObject.Identity
  if ($identity -and ((Test-GuidText $identity) -or $identity -match "(?i)^(CN|OU|DC)=")) {
    $key = $identity.ToLowerInvariant()
    if (-not (Has-MapKey $seen $key)) { Write-Output $key }
  }
}

function Get-ExchangeDirectoryNameBase($DisplayName) {
  $baseName = Clean-Text $DisplayName
  if (-not $baseName) { $baseName = "FCUNO Contact" }
  if ($baseName.Length -gt 64) { $baseName = $baseName.Substring(0, 64) }
  return $baseName
}

function Get-ExchangeDistributionGroupMismatches($Existing, $Group, $Profile = $null) {
  $mismatches = @()
  if (-not $Existing) { return @("distribution group is missing") }
  if (-not $Group) { return @("desired group is missing") }
  $expectedAlias = Clean-Text $Group.Alias
  $expectedName = Get-ExchangeGroupDirectoryName $Group
  $expectedDisplayName = Clean-Text $Group.GroupName
  $expectedSourceKey = Clean-Text $Group.SourceKey
  $expectedSmtpAddress = Get-ExpectedExchangeGroupSmtpAddress $Group
  if (-not (Clean-Text $Existing.Alias).Equals($expectedAlias, [StringComparison]::OrdinalIgnoreCase)) { $mismatches += "alias" }
  if ((Normalize-Email $Existing.PrimarySmtpAddress) -cne $expectedSmtpAddress) { $mismatches += "primary SMTP address" }
  if ((Clean-Text $Existing.Name) -cne $expectedName) { $mismatches += "name" }
  if ((Clean-Text $Existing.DisplayName) -cne $expectedDisplayName) { $mismatches += "display name" }
  if (-not $Profile) {
    $mismatches += "group profile"
  } elseif ((Clean-Text $Profile.Notes) -cne (Clean-Text $Group.Description)) {
    $mismatches += "description"
  }
  if ((Clean-Text $Existing.CustomAttribute1) -cne $ManagedMarker) { $mismatches += "managed marker" }
  if ((Clean-Text $Existing.CustomAttribute2) -cne $expectedSourceKey) { $mismatches += "source key" }
  if ([bool]$Existing.HiddenFromAddressListsEnabled) { $mismatches += "address-list visibility" }
  return $mismatches
}

function Get-ExchangeGroupDirectoryName($Group) {
  $directoryName = Clean-Text (Get-MapValue $Group "DirectoryName")
  if (-not $directoryName) { $directoryName = Clean-Text (Get-MapValue $Group "GroupName") }
  if (-not $directoryName) { throw "The Exchange group directory name is missing." }
  if ($directoryName.Length -gt 64) { throw "The Exchange group directory name exceeds 64 characters." }
  return $directoryName
}

function Get-ExchangeGroupMembershipMismatches($DesiredMembers, $ActualMembers) {
  $mismatches = @()
  $desiredEmailCounts = @{}
  foreach ($member in @($DesiredMembers)) {
    $email = Normalize-Email $member.MemberEmail
    if (-not $email) {
      $mismatches += "desired member has no valid email"
      continue
    }
    if (-not (Has-MapKey $desiredEmailCounts $email)) { $desiredEmailCounts[$email] = 0 }
    $desiredEmailCounts[$email] = [int]$desiredEmailCounts[$email] + 1
  }

  $actualState = Get-ExchangeGroupMembershipState $ActualMembers
  foreach ($email in @($desiredEmailCounts.Keys | Sort-Object)) {
    $actualCount = if (Has-MapKey $actualState.EmailCounts $email) { [int]$actualState.EmailCounts[$email] } else { 0 }
    $expectedCount = [int]$desiredEmailCounts[$email]
    if ($actualCount -ne $expectedCount) { $mismatches += "$email expected $expectedCount, found $actualCount" }
  }
  foreach ($email in @($actualState.EmailCounts.Keys | Where-Object { -not (Has-MapKey $desiredEmailCounts $_) } | Sort-Object)) {
    $mismatches += "$email is unexpected (found $($actualState.EmailCounts[$email]))"
  }
  foreach ($identity in @($actualState.UnresolvedMembers | Sort-Object)) {
    $mismatches += "unresolved member $identity"
  }
  return $mismatches
}

function Get-ExchangeGroupMembershipState($Members) {
  $emailCounts = @{}
  $unresolvedMembers = @()
  foreach ($member in @($Members)) {
    $email = Get-RecipientEmail $member
    if (-not $email) {
      $identity = Clean-Text $member.Identity
      $unresolvedMembers += $(if ($identity) { $identity } else { "<missing identity>" })
      continue
    }
    if (-not (Has-MapKey $emailCounts $email)) { $emailCounts[$email] = 0 }
    $emailCounts[$email] = [int]$emailCounts[$email] + 1
  }
  return @{ EmailCounts = $emailCounts; UnresolvedMembers = $unresolvedMembers }
}

function Get-ExchangeImmutableGroupJoinKeys($ExchangeObject) {
  if (-not $ExchangeObject) { return @() }
  $seen = @{}
  foreach ($propertyName in @("Guid", "ExternalDirectoryObjectId", "DistinguishedName")) {
    $value = Clean-Text $ExchangeObject.$propertyName
    if (-not $value -or $value -eq "00000000-0000-0000-0000-000000000000") { continue }
    $key = $value.ToLowerInvariant()
    if (Has-MapKey $seen $key) { continue }
    $seen[$key] = $true
    Write-Output $key
  }
}

function Get-ExchangeMailContactMismatches($Existing, $Contact, $Profile = $null) {
  $mismatches = @()
  if (-not $Existing) { return @("mail contact is missing") }
  if (-not $Contact) { return @("desired contact is missing") }
  $expectedEmail = Normalize-Email $Contact.ExternalEmailAddress
  $expectedAlias = Clean-Text $Contact.Alias
  $expectedName = Get-ExchangeContactDirectoryName $Contact
  $expectedDisplayName = Clean-Text $Contact.DisplayName
  $expectedSourceKey = Clean-Text $Contact.SourceKey
  if ((Normalize-Email (Get-RecipientEmail $Existing)) -ne $expectedEmail) { $mismatches += "external email" }
  if (-not (Clean-Text $Existing.Alias).Equals($expectedAlias, [StringComparison]::OrdinalIgnoreCase)) { $mismatches += "alias" }
  if ((Clean-Text $Existing.Name) -cne $expectedName) { $mismatches += "name" }
  if ((Clean-Text $Existing.DisplayName) -cne $expectedDisplayName) { $mismatches += "display name" }
  if ((Clean-Text $Existing.CustomAttribute1) -cne $ManagedMarker) { $mismatches += "managed marker" }
  if ((Clean-Text $Existing.CustomAttribute2) -cne $expectedSourceKey) { $mismatches += "source key" }
  if ([bool]$Existing.HiddenFromAddressListsEnabled) { $mismatches += "address-list visibility" }
  if (-not $Profile) {
    $mismatches += "contact profile"
  } else {
    if ((Clean-Text $Profile.FirstName) -cne (Clean-Text $Contact.FirstName)) { $mismatches += "first name" }
    if ((Clean-Text $Profile.LastName) -cne (Clean-Text $Contact.LastName)) { $mismatches += "last name" }
  }
  return $mismatches
}

function Get-ExchangeStrongCommandIdentity($ExchangeObject) {
  if (-not $ExchangeObject) { return "" }
  foreach ($propertyName in @("Guid", "DistinguishedName", "ExternalDirectoryObjectId")) {
    $value = Clean-Text $ExchangeObject.$propertyName
    if ($value -and $value -ne "00000000-0000-0000-0000-000000000000") { return $value }
  }
  return ""
}

function Get-ExpectedExchangeGroupSmtpAddress($Group) {
  if (-not $Group) { throw "The desired Exchange group is missing." }
  $alias = (Clean-Text (Get-MapValue $Group "Alias")).ToLowerInvariant()
  if (-not $alias -or $alias -notmatch "^[a-z0-9._-]{1,64}$") {
    throw "The desired Exchange group has no valid alias for its certified SMTP address."
  }
  $expected = Normalize-Email "$alias@$(Get-RequiredExchangeAddressBookDomain)"
  if (-not (Test-ValidEmail $expected)) {
    throw "The desired Exchange group alias and required address-book domain do not form a valid SMTP address."
  }
  $projected = Normalize-Email (Get-MapValue $Group "SmtpAddress")
  if ($projected -and $projected -cne $expected) {
    throw "The desired Exchange group SMTP address '$projected' does not match its certified alias/domain address '$expected'."
  }
  return $expected
}

function Get-GroupSourceKey($SourceGroupId) {
  $sourceId = Clean-Text $SourceGroupId
  if (-not $sourceId) { return "" }
  return "FCUNO_GROUP:$sourceId"
}

function Get-MapValue($Map, [string]$Key) {
  if (-not (Has-MapKey $Map $Key)) { return $null }
  if ($Map -is [hashtable] -or $Map -is [System.Collections.IDictionary]) {
    return $Map[$Key]
  }
  return $Map.PSObject.Properties[$Key].Value
}

function Get-NormalizedExchangeAddressBookDomain($Value) {
  $domain = (Clean-Text $Value).TrimStart("@").ToLowerInvariant()
  if (
    -not $domain -or
    $domain.Length -gt 253 -or
    -not (Test-ValidEmail "fcuno-addressbook@$domain")
  ) {
    throw "Automation variable EXCHANGE_ADDRESSBOOK_DOMAIN must be the exact canonical SMTP domain $CanonicalExchangeAddressBookDomain."
  }
  if ($domain -cne $CanonicalExchangeAddressBookDomain) {
    throw "Automation variable EXCHANGE_ADDRESSBOOK_DOMAIN must exactly match $CanonicalExchangeAddressBookDomain."
  }
  return $domain
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

function Get-RequiredExchangeAddressBookDomain {
  $domain = Clean-Text $script:ExchangeAddressBookDomain
  if (-not $domain) {
    throw "EXCHANGE_ADDRESSBOOK_DOMAIN is not loaded. The Exchange group SMTP address cannot be projected or certified."
  }
  return Get-NormalizedExchangeAddressBookDomain $domain
}

function Get-StableExchangeHash($Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes((Clean-Text $Value))))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
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

function Get-UniqueExchangeDirectoryName($DisplayName, [hashtable]$SeenNames, $StableKey, [bool]$ForceStableSuffix = $false) {
  $baseName = Get-ExchangeDirectoryNameBase $DisplayName
  $baseKey = $baseName.ToLowerInvariant()
  if (-not $ForceStableSuffix -and -not (Has-MapKey $SeenNames $baseKey)) {
    $SeenNames[$baseKey] = $true
    return $baseName
  }

  $stableText = Clean-Text $StableKey
  if (-not $stableText) { throw "A stable FCUNO source key is required to disambiguate Exchange directory names." }
  $hash = Get-StableExchangeHash $stableText
  for ($hashLength = 8; $hashLength -le 32; $hashLength += 4) {
    $suffix = " [" + $hash.Substring(0, $hashLength) + "]"
    $maxBaseLength = 64 - $suffix.Length
    $candidate = $baseName.Substring(0, [Math]::Min($baseName.Length, $maxBaseLength)).TrimEnd() + $suffix
    $candidateKey = $candidate.ToLowerInvariant()
    if (-not (Has-MapKey $SeenNames $candidateKey)) {
      $SeenNames[$candidateKey] = $true
      return $candidate
    }
  }
  throw "Could not allocate a unique deterministic Exchange directory name for '$baseName'."
}

function Has-MapKey($Map, [string]$Key) {
  if (-not $Map -or -not $Key) { return $false }
  if ($Map -is [hashtable]) {
    return $Map.ContainsKey($Key)
  }
  if ($Map -is [System.Collections.IDictionary]) { return $Map.Contains($Key) }
  $property = $Map.PSObject.Properties[$Key]
  return $null -ne $property
}

function Is-InternalContact($Contact, $Email) {
  if (Is-InternalEmail $Email) { return $true }
  foreach ($propertyName in @("IsInternalSource", "HasInternalSource")) {
    $value = Get-MapValue $Contact $propertyName
    if ($value -is [bool] -and $value) { return $true }
    if ($value -is [string] -and $value.Equals("true", [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  $sourceBook = Clean-Text (Get-MapValue $Contact "source_book")
  if (-not $sourceBook) { $sourceBook = Clean-Text (Get-MapValue $Contact "SourceBook") }
  return $sourceBook.Equals("FC-INTERNAL", [StringComparison]::OrdinalIgnoreCase)
}

function Is-InternalEmail($Email) {
  # cosulich.com.sg is hosted outside this Exchange tenant and FC-GENERAL rows
  # on that domain must remain managed mail contacts. Explicit FC-INTERNAL
  # provenance below still suppresses genuine internal recipients on any domain.
  $internalDomains = @("cosulich.com.hk")
  $domain = ((Clean-Text $Email).ToLowerInvariant().Split("@") | Select-Object -Last 1)
  return $internalDomains -contains $domain
}

function New-ExchangeContactProfileLookup($Profiles) {
  $lookup = @{ ByImmutableKey = @{} }
  $profilePosition = 0
  foreach ($profile in @($Profiles)) {
    $entry = [pscustomobject]@{ Position = $profilePosition; Profile = $profile }
    $profilePosition += 1
    foreach ($joinKey in @(Get-ExchangeContactProfileImmutableJoinKeys $profile)) {
      Add-ExchangeLookupEntry $lookup.ByImmutableKey $joinKey $entry
    }
  }
  return $lookup
}

function New-ExchangeDistributionGroupLookup($Groups) {
  $lookup = @{ BySourceKey = @{}; ByAlias = @{}; ByDisplayName = @{} }
  foreach ($group in @($Groups)) {
    Add-ExchangeLookupEntry $lookup.BySourceKey (Clean-Text $group.CustomAttribute2) $group
    Add-ExchangeLookupEntry $lookup.ByAlias ((Clean-Text $group.Alias).ToLowerInvariant()) $group
    Add-ExchangeLookupEntry $lookup.ByDisplayName (Clean-Text $group.DisplayName) $group
  }
  return $lookup
}

function New-ExchangeGroupProfileLookup($Profiles) {
  $lookup = @{ ByImmutableKey = @{} }
  $profilePosition = 0
  foreach ($profile in @($Profiles)) {
    $entry = [pscustomobject]@{ Position = $profilePosition; Profile = $profile }
    $profilePosition += 1
    foreach ($joinKey in @(Get-ExchangeImmutableGroupJoinKeys $profile)) {
      Add-ExchangeLookupEntry $lookup.ByImmutableKey $joinKey $entry
    }
  }
  return $lookup
}

function New-ExchangeMailContactLookup($Contacts) {
  $lookup = @{ BySourceKey = @{}; ByEmail = @{} }
  foreach ($contact in @($Contacts)) {
    Add-ExchangeLookupEntry $lookup.BySourceKey (Clean-Text $contact.CustomAttribute2) $contact
    Add-ExchangeLookupEntry $lookup.ByEmail (Normalize-Email (Get-RecipientEmail $contact)) $contact
  }
  return $lookup
}

function Normalize-Email($Value) {
  $text = (Clean-Text $Value).ToLowerInvariant()
  $text = $text -replace "^[Ss][Mm][Tt][Pp]:", ""
  return $text
}

function Resolve-ExchangeContactProfileHint($MailContact, $Lookup) {
  if (-not $MailContact -or -not $Lookup) { return $null }
  $matchedEntries = @{}
  foreach ($joinKey in @(Get-ExchangeContactProfileImmutableJoinKeys $MailContact)) {
    foreach ($entry in @($Lookup.ByImmutableKey[$joinKey])) {
      if ($null -eq $entry) { continue }
      $matchedEntries[[string]$entry.Position] = $entry
    }
  }
  if ($matchedEntries.Count -gt 1) {
    throw "More than one Exchange contact profile matches immutable identity for mail contact '$($MailContact.Identity)'."
  }
  if ($matchedEntries.Count -eq 1) {
    return @($matchedEntries.Values)[0].Profile
  }
  return $null
}

function Resolve-ExchangeGroupProfileHint($DistributionGroup, $Lookup) {
  if (-not $DistributionGroup -or -not $Lookup) { return $null }
  $matchedEntries = @{}
  foreach ($joinKey in @(Get-ExchangeImmutableGroupJoinKeys $DistributionGroup)) {
    foreach ($entry in @($Lookup.ByImmutableKey[$joinKey])) {
      if ($null -eq $entry) { continue }
      $matchedEntries[[string]$entry.Position] = $entry
    }
  }
  if ($matchedEntries.Count -gt 1) {
    throw "More than one authoritative Exchange group profile matches distribution group '$($DistributionGroup.Identity)'."
  }
  if ($matchedEntries.Count -eq 1) {
    return @($matchedEntries.Values)[0].Profile
  }
  return $null
}

function Test-ExchangeDirectoryNameRequiresStableSuffix($SourceKey) {
  $candidate = Clean-Text $SourceKey
  if (-not $candidate) { return $false }
  return @($ExchangeDirectoryNameCollisionSourceKeys | Where-Object {
    (Clean-Text $_).Equals($candidate, [StringComparison]::OrdinalIgnoreCase)
  }).Count -gt 0
}

function Test-GuidText($Value) {
  $guid = [Guid]::Empty
  return [Guid]::TryParse((Clean-Text $Value), [ref]$guid)
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
# END GENERATED CURRENT CHECK HELPERS

function Get-CurrentSha256([string]$Value) {
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()
}

function Assert-CurrentCheckBudget {
  if ($null -ne $script:CurrentCheckClock -and $script:CurrentCheckClock.Elapsed.TotalSeconds -ge $MaxDurationSeconds) {
    throw 'CURRENT_CHECK_BUDGET'
  }
}

function Assert-CurrentNativeCount($Value) {
  if (($Value -isnot [int] -and $Value -isnot [long]) -or $Value -lt 0) {
    throw 'CURRENT_CHECK_INVALID_COUNT'
  }
}

function Assert-CurrentServiceKey([string]$Key) {
  if ($Key -cmatch '^sb_secret_[A-Za-z0-9_-]{10,}$') {return}
  if ($Key -cmatch '^sb_publishable_' -or $Key -notmatch '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') {throw 'CURRENT_CHECK_SERVICE_KEY_ROLE'}
  try {
    $payload=$Key.Split('.')[1].Replace('-','+').Replace('_','/')
    $payload=$payload.PadRight($payload.Length+((4-$payload.Length%4)%4),'=')
    $claims=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json -AsHashtable -ErrorAction Stop
    if($claims.role -cne 'service_role' -or $claims.ref -cne ([Uri]$CurrentCheckSupabaseOrigin).Host.Split('.')[0]) {throw 'role'}
  } catch {throw 'CURRENT_CHECK_SERVICE_KEY_ROLE'}
}

function Get-CurrentSetting([string]$Name) {
  $value = Get-AutomationVariable -Name $Name -ErrorAction Stop
  if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) { throw 'CURRENT_CHECK_CONFIGURATION' }
  return [string]$value
}

function Assert-CurrentSettings($Url, $AppId, $TenantId, $Organization, $Domain) {
  if ([string]$Url -cne $CurrentCheckSupabaseOrigin -or [string]$AppId -cne $CurrentCheckExpectedAppId -or
      [string]$TenantId -cne $CurrentCheckTenantId -or [string]$Organization -cne $CanonicalExchangeAddressBookDomain -or
      [string]$Domain -cne $CanonicalExchangeAddressBookDomain -or -not (Test-GuidText $CurrentCheckExpectedAppId)) { throw 'CURRENT_CHECK_CONFIGURATION_TARGET' }
}

function Initialize-CurrentCheckConnection {
  Assert-CurrentCheckBudget
  if ($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSVersion.Minor -ne 6) { throw 'CURRENT_CHECK_RUNTIME' }
  $url = Get-CurrentSetting 'NEXT_PUBLIC_SUPABASE_URL'
  $app = Get-CurrentSetting 'EXCHANGE_APP_ID'
  $tenant = Get-CurrentSetting 'EXCHANGE_TENANT_ID'
  $org = Get-CurrentSetting 'EXCHANGE_ORGANIZATION'
  $domain = Get-CurrentSetting 'EXCHANGE_ADDRESSBOOK_DOMAIN'
  Assert-CurrentSettings $url $app $tenant $org $domain
  $script:CurrentCheckServiceKey = Get-CurrentSetting 'SUPABASE_SERVICE_ROLE_KEY'
  Assert-CurrentServiceKey $script:CurrentCheckServiceKey
  $script:ExchangeAddressBookDomain = $domain
  $configuredModule = Get-AutomationVariable -Name 'EXCHANGE_ONLINE_MANAGEMENT_VERSION' -ErrorAction SilentlyContinue
  if ($configuredModule -and [string]$configuredModule -cne '3.10.1') { throw 'CURRENT_CHECK_RUNTIME' }
  Import-Module ExchangeOnlineManagement -RequiredVersion '3.10.1' -ErrorAction Stop
  if (@(Get-ConnectionInformation -ErrorAction Stop).Count -ne 0) { throw 'CURRENT_CHECK_EXISTING_SESSION' }
  $pfxBytes = [Convert]::FromBase64String((Get-CurrentSetting 'EXCHANGE_CERT_PFX_BASE64'))
  $password = Get-CurrentSetting 'EXCHANGE_CERT_PASSWORD'
  try {
    $script:CurrentCheckCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
      $pfxBytes, $password, [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
  } finally {
    [Array]::Clear($pfxBytes, 0, $pfxBytes.Length)
    $password = $null
  }
  $cert = $script:CurrentCheckCertificate
  $now = [DateTime]::UtcNow
  if (-not $cert.HasPrivateKey -or $cert.Thumbprint -cnotmatch '^[0-9A-F]{40}$' -or
      $cert.NotBefore.ToUniversalTime() -gt $now -or $cert.NotAfter.ToUniversalTime() -le $now.AddSeconds($MaxDurationSeconds)) {
    throw 'CURRENT_CHECK_CERTIFICATE'
  }
  Assert-CurrentCheckBudget
  # Only these read cmdlets are imported into this new Automation job's session.
  $script:CurrentCheckConnectionAttempted = $true
  $connectionWarnings=@()
  Connect-ExchangeOnline -AppId $app -Certificate $cert -Organization $org -ShowBanner:$false -CommandName @(
    'Get-MailContact', 'Get-Contact', 'Get-DistributionGroup', 'Get-Group', 'Get-DistributionGroupMember'
  ) -ErrorAction Stop -WarningAction SilentlyContinue -WarningVariable connectionWarnings | Out-Null
  $script:CurrentCheckConnected = $true
  if($connectionWarnings.Count) {throw 'CURRENT_CHECK_CONNECTION_WARNING'}
  $connections = @(Get-ConnectionInformation -ErrorAction Stop)
  if ($connections.Count -ne 1) { throw 'CURRENT_CHECK_SESSION_TARGET' }
  $connection = $connections[0]
  $script:CurrentCheckConnectionId = Clean-Text $connection.ConnectionId
  $expires = [DateTimeOffset]::MinValue
  if ((Clean-Text $connection.State) -cne 'Connected' -or (Clean-Text $connection.AppId) -cne $app -or
      (Clean-Text $connection.TenantID) -cne $tenant -or (Clean-Text $connection.Organization) -cne $org -or
      $connection.CertificateAuthentication -isnot [bool] -or -not $connection.CertificateAuthentication -or
      -not $script:CurrentCheckConnectionId -or (Clean-Text $connection.TokenStatus) -cne 'Active' -or
      -not [DateTimeOffset]::TryParse((Clean-Text $connection.TokenExpiryTimeUTC), [ref]$expires) -or $expires -le [DateTimeOffset]::UtcNow) {
    throw 'CURRENT_CHECK_SESSION_TARGET'
  }
  Assert-CurrentCheckBudget
}

function Close-CurrentCheckConnection {
  try {
    if ($script:CurrentCheckConnectionAttempted) {
      if ($script:CurrentCheckConnectionId) {
        Disconnect-ExchangeOnline -ConnectionId $script:CurrentCheckConnectionId -Confirm:$false -ErrorAction Stop | Out-Null
      } else {
        # Initialization refused pre-existing sessions, so these are this job's.
        Disconnect-ExchangeOnline -Confirm:$false -ErrorAction Stop | Out-Null
      }
    }
  } finally {
    $script:CurrentCheckConnected = $false
    $script:CurrentCheckConnectionAttempted = $false
    $script:CurrentCheckConnectionId = $null
    $script:CurrentCheckServiceKey = $null
    if ($null -ne $script:CurrentCheckCertificate) { $script:CurrentCheckCertificate.Dispose(); $script:CurrentCheckCertificate = $null }
  }
}

function Invoke-CurrentSupabasePage([string]$Table, [string]$Query, [int]$Offset, [int]$Limit) {
  Assert-CurrentCheckBudget
  $allowed = @{
    shared_addressbook_contacts = @('select=*&order=id.asc')
    shared_addressbook_groups = @('select=*&order=id.asc')
    shared_addressbook_group_members = @('select=*&order=group_id.asc,contact_id.asc')
    outlook_exchange_sync_queue = @(
      'select=queue_sequence,updated_at&order=updated_at.desc,queue_sequence.desc',
      'select=id,queue_sequence,updated_at,status,next_attempt_at&status=in.(pending,processing,failed)&order=queue_sequence.asc'
    )
    outlook_exchange_sync_lock = @('select=lock_name,run_id,sync_mode,acquired_at,heartbeat_at,expires_at&order=lock_name.asc')
    outlook_exchange_truth_ledger = @('select=ledger_sequence,entry_sha256&order=ledger_sequence.desc')
  }
  if (-not $allowed.ContainsKey($Table) -or $Query -cnotin $allowed[$Table] -or $Offset -lt 0 -or
      $Limit -lt 1 -or $Limit -gt 1000 -or $Offset -gt $script:CurrentCheckMaxRows -or -not $script:CurrentCheckServiceKey) {
    throw 'CURRENT_CHECK_READ_NOT_ALLOWED'
  }
  $configuredUrl = Get-CurrentSetting 'NEXT_PUBLIC_SUPABASE_URL'
  if ($configuredUrl -cne $CurrentCheckSupabaseOrigin) { throw 'CURRENT_CHECK_CONFIGURATION_TARGET' }
  Assert-CurrentServiceKey $script:CurrentCheckServiceKey
  $uri = "$CurrentCheckSupabaseOrigin/rest/v1/$Table" + "?$Query&offset=$Offset&limit=$Limit"
  $headers = @{ apikey=$script:CurrentCheckServiceKey; Prefer='count=exact'; 'Range-Unit'='items'; 'User-Agent'='fcuno-current-addressbook-check/1.0' }
  if ($script:CurrentCheckServiceKey -notmatch '^sb_(secret|publishable)_') { $headers.Authorization = "Bearer $($script:CurrentCheckServiceKey)" }
  # Redirects are never followed with the service credential. Only this literal
  # GET call exists; no caller-supplied method, body, origin, table or RPC.
  $requestWarnings=@()
  $response = Invoke-WebRequest -Method Get -Uri $uri -Headers $headers -MaximumRedirection 0 -ConnectionTimeoutSeconds 30 -OperationTimeoutSeconds 60 -ErrorAction Stop -WarningAction SilentlyContinue -WarningVariable requestWarnings
  Assert-CurrentCheckBudget
  if($requestWarnings.Count) {throw 'CURRENT_CHECK_HTTP_WARNING'}
  if([Text.Encoding]::UTF8.GetByteCount([string]$response.Content) -gt 33554432) {throw 'CURRENT_CHECK_PAGE_BYTES'}
  if ([int]$response.StatusCode -notin @(200,206)) { throw 'CURRENT_CHECK_HTTP_STATUS' }
  $range = [string]($response.Headers['Content-Range'] | Select-Object -First 1)
  $rows = ConvertFrom-Json -InputObject $response.Content -AsHashtable -NoEnumerate -Depth 100 -ErrorAction Stop
  if ($rows -isnot [array]) { throw 'CURRENT_CHECK_NONARRAY_PAGE' }
  [long]$total = -1; [long]$from = -1; [long]$to = -1
  if ($range -match '^(\d+)-(\d+)/(\d+)$') {
    $from=[long]$Matches[1]; $to=[long]$Matches[2]; $total=[long]$Matches[3]
  } elseif ($range -match '^\*/(\d+)$') { $total=[long]$Matches[1] }
  else { throw 'CURRENT_CHECK_RANGE' }
  Assert-CurrentNativeCount $total
  $expected = [Math]::Min([long]$Limit, [Math]::Max(0L, $total - $Offset))
  if ($rows.Count -ne $expected -or ($expected -gt 0 -and ($from -ne $Offset -or $to -ne ($Offset+$expected-1))) -or
      ($expected -eq 0 -and ($from -ne -1 -or $to -ne -1))) { throw 'CURRENT_CHECK_INCOMPLETE_PAGE' }
  return @{ Rows=$rows; Total=$total; From=$from; To=$to }
}

function Get-CurrentRows([string]$Table, [string]$Query, [string[]]$Keys) {
  $all = [Collections.Generic.List[object]]::new()
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  [long]$total = -1
  $lastKey = $null
  do {
    $page = Invoke-CurrentSupabasePage $Table $Query $all.Count $PageSize
    Assert-CurrentNativeCount $page.Total
    if ($page.Total -gt $script:CurrentCheckMaxRows) {throw 'CURRENT_CHECK_ENUMERATION_LIMIT'}
    if ($page.Rows -isnot [array] -or ($total -ge 0 -and $page.Total -ne $total)) { throw 'CURRENT_CHECK_PAGE_DRIFT' }
    $total = [long]$page.Total
    $expected = [Math]::Min([long]$PageSize, [Math]::Max(0L, $total-$all.Count))
    if ($page.Rows.Count -ne $expected -or ($expected -gt 0 -and ($page.From -ne $all.Count -or $page.To -ne $all.Count+$expected-1))) { throw 'CURRENT_CHECK_INCOMPLETE_PAGE' }
    foreach ($row in $page.Rows) {
      if ($null -eq $row -or $row -isnot [System.Collections.IDictionary]) { throw 'CURRENT_CHECK_INVALID_ROW' }
      $parts = @($Keys | ForEach-Object { $value=Clean-Text (Get-MapValue $row $_); if (-not $value -or $value.Contains([char]0)) { throw 'CURRENT_CHECK_ROW_ID' }; $value })
      $key = $parts -join [char]0
      if (-not $seen.Add($key) -or ($null -ne $lastKey -and [StringComparer]::Ordinal.Compare($lastKey,$key) -ge 0)) { throw 'CURRENT_CHECK_ROW_ORDER_OR_DUPLICATE' }
      $lastKey = $key
      $all.Add($row)
    }
    Assert-CurrentCheckBudget
  } while ($all.Count -lt $total)
  if ($all.Count -ne $total) { throw 'CURRENT_CHECK_INCOMPLETE_PAGE' }
  return ,$all.ToArray()
}

function Get-CurrentSourceSnapshot {
  $contacts = Get-CurrentRows 'shared_addressbook_contacts' 'select=*&order=id.asc' @('id')
  $groups = Get-CurrentRows 'shared_addressbook_groups' 'select=*&order=id.asc' @('id')
  $members = Get-CurrentRows 'shared_addressbook_group_members' 'select=*&order=group_id.asc,contact_id.asc' @('group_id','contact_id')
  $raw = [ordered]@{contacts=$contacts;groups=$groups;members=$members}
  $sourceIssues=[Collections.Generic.List[string]]::new()
  $contactIds=@{};$groupIds=@{};$rawGroupCounts=@{}
  foreach($contact in $contacts) {$contactIds[[string]$contact.id]=$true}
  foreach($group in $groups) {
    $groupIds[[string]$group.id]=$true
    if(-not (Clean-Text $group.name) -and -not (Clean-Text $group.nickname) -and -not (Clean-Text $group.source_uid)) {$sourceIssues.Add('unnamed_source_group')}
  }
  foreach($member in $members) {
    if(-not (Has-MapKey $contactIds ([string]$member.contact_id)) -or -not (Has-MapKey $groupIds ([string]$member.group_id))) {$sourceIssues.Add('orphan_source_membership')}
    $key=[string]$member.group_id
    if(-not $rawGroupCounts.ContainsKey($key)) {$rawGroupCounts[$key]=0}
    $rawGroupCounts[$key]++
  }
  foreach($group in $groups) {
    if(Has-MapKey $group 'member_count') {
      Assert-CurrentNativeCount $group.member_count
      $actual=if(Has-MapKey $rawGroupCounts ([string]$group.id)) {$rawGroupCounts[[string]$group.id]} else {0}
      if($group.member_count -ne $actual) {$sourceIssues.Add('source_group_counter_differs')}
    }
  }
  $rows = Build-ExchangeRows $contacts $groups $members
  Assert-CurrentCheckBudget
  return @{
    Rows=$rows; Fingerprint=(Get-CurrentSha256 (Get-CanonicalExchangeProjectionJson $rows))
    RawFingerprint=(Get-CurrentSha256 ($raw | ConvertTo-Json -Depth 100 -Compress))
    Counts=@{contacts=[int]$contacts.Count;groups=[int]$groups.Count;members=[int]$members.Count};Complete=$true
    SourceValidationIssues=@($sourceIssues | Sort-Object -Unique)
  }
}

function Get-CurrentOperationalState {
  $watermark = Invoke-CurrentSupabasePage 'outlook_exchange_sync_queue' 'select=queue_sequence,updated_at&order=updated_at.desc,queue_sequence.desc' 0 1
  $unsettled = Invoke-CurrentSupabasePage 'outlook_exchange_sync_queue' 'select=id,queue_sequence,updated_at,status,next_attempt_at&status=in.(pending,processing,failed)&order=queue_sequence.asc' 0 1
  $leases = Get-CurrentRows 'outlook_exchange_sync_lock' 'select=lock_name,run_id,sync_mode,acquired_at,heartbeat_at,expires_at&order=lock_name.asc' @('lock_name')
  $head = Invoke-CurrentSupabasePage 'outlook_exchange_truth_ledger' 'select=ledger_sequence,entry_sha256&order=ledger_sequence.desc' 0 1
  Assert-CurrentNativeCount $unsettled.Total
  $queueWatermark = '0'
  if ($watermark.Total -gt 0) {
    $row=$watermark.Rows[0]
    Assert-CurrentNativeCount $row.queue_sequence
    $date=[DateTimeOffset]::MinValue
    if ($row.queue_sequence -le 0 -or -not [DateTimeOffset]::TryParse([string]$row.updated_at,[ref]$date)) { throw 'CURRENT_CHECK_QUEUE_FENCE' }
    $queueWatermark="$( $row.queue_sequence )@$($row.updated_at)"
  }
  $active=$false
  foreach($lease in $leases) {
    $expires=[DateTimeOffset]::MinValue
    if (-not (Test-GuidText $lease.run_id) -or -not [DateTimeOffset]::TryParse([string]$lease.expires_at,[ref]$expires)) { throw 'CURRENT_CHECK_LEASE_FENCE' }
    if ($expires -gt [DateTimeOffset]::UtcNow) { $active=$true }
  }
  if ($head.Total -lt 1 -or $head.Rows.Count -ne 1) { throw 'CURRENT_CHECK_LEDGER_HEAD' }
  $ledger=$head.Rows[0]
  # Ledger/queue sequences are not constrained by source max-row bounds.
  if (($ledger.ledger_sequence -isnot [int] -and $ledger.ledger_sequence -isnot [long]) -or $ledger.ledger_sequence -le 0 -or
      [string]$ledger.entry_sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'CURRENT_CHECK_LEDGER_HEAD' }
  return @{QueueWatermark=$queueWatermark;UnsettledCount=[long]$unsettled.Total;ActiveSync=[bool]$active;Complete=$true
    LedgerHead="$($ledger.ledger_sequence)@$($ledger.entry_sha256)";LeaseFingerprint=(Get-CurrentSha256 ($leases | ConvertTo-Json -Depth 10 -Compress))}
}

function Get-CurrentExchangeInventory([string]$Kind) {
  Assert-CurrentCheckBudget
  $readWarnings=@()
  $rows = @(switch -CaseSensitive ($Kind) {
    'MailContacts' { Get-MailContact -ResultSize Unlimited -ErrorAction Stop -WarningAction SilentlyContinue -WarningVariable +readWarnings }
    'ContactProfiles' { Get-Contact -ResultSize Unlimited -ErrorAction Stop -WarningAction SilentlyContinue -WarningVariable +readWarnings }
    'DistributionGroups' { Get-DistributionGroup -ResultSize Unlimited -ErrorAction Stop -WarningAction SilentlyContinue -WarningVariable +readWarnings }
    'GroupProfiles' { Get-Group -ResultSize Unlimited -ErrorAction Stop -WarningAction SilentlyContinue -WarningVariable +readWarnings }
    default { throw 'CURRENT_CHECK_INVENTORY_KIND' }
  })
  Assert-CurrentCheckBudget
  if($readWarnings.Count) {throw 'CURRENT_CHECK_INVENTORY_WARNING'}
  if ($rows.Count -gt $script:CurrentCheckMaxRows) { throw 'CURRENT_CHECK_INVENTORY_LIMIT' }
  $ids=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($row in $rows) {
    if ($null -eq $row) { throw 'CURRENT_CHECK_INVENTORY_NULL' }
    $id=Get-ExchangeStrongCommandIdentity $row
    if (-not $id -or -not $ids.Add($id)) { throw 'CURRENT_CHECK_INVENTORY_ID' }
  }
  return ,$rows
}

function Get-CurrentExchangeMembers($Group) {
  Assert-CurrentCheckBudget
  $identity=Get-ExchangeStrongCommandIdentity $Group
  if (-not $identity) { throw 'CURRENT_CHECK_MEMBERSHIP_ID' }
  $readWarnings=@()
  $rows=@(Get-DistributionGroupMember -Identity $identity -ResultSize Unlimited -ErrorAction Stop -WarningAction SilentlyContinue -WarningVariable readWarnings)
  Assert-CurrentCheckBudget
  if($readWarnings.Count) {throw 'CURRENT_CHECK_MEMBERSHIP_WARNING'}
  if ($rows.Count -gt $script:CurrentCheckMaxRows -or @($rows | Where-Object {$null -eq $_}).Count -gt 0) { throw 'CURRENT_CHECK_MEMBERSHIP_INCOMPLETE' }
  return ,$rows
}

function Test-CurrentImmutableIdentity($First, $Second) {
  $shared=$false
  foreach($property in @('Guid','ExternalDirectoryObjectId','DistinguishedName')) {
    $a=Clean-Text $First.$property; $b=Clean-Text $Second.$property
    if ($a -eq '00000000-0000-0000-0000-000000000000') {$a=''}
    if ($b -eq '00000000-0000-0000-0000-000000000000') {$b=''}
    if ($a -and $b) {
      if (-not $a.Equals($b,[StringComparison]::OrdinalIgnoreCase)) { return $false }
      $shared=$true
    }
  }
  return $shared
}

function Add-CurrentDifference($Stats, [string]$Kind, [string]$SourceKey, [string]$Code) {
  $Stats.mismatchCount=[int]$Stats.mismatchCount+1
  if ($Stats.details.Count -lt $MaxDetails) {
    # Stable source identifiers and fixed reason codes only: no contact names,
    # emails, vCards, credential material, raw provider errors or tenant dump.
    $safeKey=if($SourceKey -cmatch '^FCUNO_(CONTACT|GROUP):[A-Za-z0-9_-]{1,80}$') {$SourceKey} else {''}
    $Stats.details.Add([ordered]@{kind=$Kind;sourceKey=$safeKey;code=$Code})
  }
}

function Get-CurrentExchangeObservation($Rows) {
  $mail=Get-CurrentExchangeInventory 'MailContacts'
  $profiles=Get-CurrentExchangeInventory 'ContactProfiles'
  $groups=Get-CurrentExchangeInventory 'DistributionGroups'
  $groupProfiles=Get-CurrentExchangeInventory 'GroupProfiles'
  $mailLookup=New-ExchangeMailContactLookup $mail
  $contactProfiles=New-ExchangeContactProfileLookup $profiles
  $groupLookup=New-ExchangeDistributionGroupLookup $groups
  $groupProfileLookup=New-ExchangeGroupProfileLookup $groupProfiles
  $stats=@{mismatchCount=0;details=[Collections.Generic.List[object]]::new();managedContacts=0;managedGroups=0;membershipGroups=0;memberships=0}
  $observed=[Collections.Generic.List[object]]::new()
  $desiredContactKeys=@{}; $desiredGroupKeys=@{}
  foreach($contact in @($Rows.Contacts)) {
    Assert-CurrentCheckBudget
    $source=Clean-Text $contact.SourceKey; $desiredContactKeys[$source]=$true
    $sourceMatches=@($mailLookup.BySourceKey[$source]);$emailMatches=@($mailLookup.ByEmail[(Normalize-Email $contact.ExternalEmailAddress)])
    if($sourceMatches.Count -ne 1 -or $emailMatches.Count -ne 1) {Add-CurrentDifference $stats 'contact' $source 'missing_or_duplicate';continue}
    if(-not (Test-CurrentImmutableIdentity $sourceMatches[0] $emailMatches[0])) {Add-CurrentDifference $stats 'contact' $source 'contradictory_identity';continue}
    $profile=$null
    try {$profile=Resolve-ExchangeContactProfileHint $sourceMatches[0] $contactProfiles} catch {Add-CurrentDifference $stats 'contact' $source 'ambiguous_profile';continue}
    if(-not $profile -or -not (Test-CurrentImmutableIdentity $sourceMatches[0] $profile)) {Add-CurrentDifference $stats 'contact' $source 'missing_or_contradictory_profile';continue}
    if(@(Get-ExchangeMailContactMismatches $sourceMatches[0] $contact $profile).Count) {Add-CurrentDifference $stats 'contact' $source 'metadata_differs'}
  }
  foreach($group in @($Rows.Groups)) {
    Assert-CurrentCheckBudget
    $source=Clean-Text $group.SourceKey;$desiredGroupKeys[$source]=$true
    $sourceMatches=@($groupLookup.BySourceKey[$source]);$aliasMatches=@($groupLookup.ByAlias[(Clean-Text $group.Alias).ToLowerInvariant()])
    if($sourceMatches.Count -ne 1 -or $aliasMatches.Count -ne 1) {Add-CurrentDifference $stats 'group' $source 'missing_or_duplicate';continue}
    if(-not (Test-CurrentImmutableIdentity $sourceMatches[0] $aliasMatches[0])) {Add-CurrentDifference $stats 'group' $source 'contradictory_identity';continue}
    $actual=$sourceMatches[0];$profile=$null
    try {$profile=Resolve-ExchangeGroupProfileHint $actual $groupProfileLookup} catch {Add-CurrentDifference $stats 'group' $source 'ambiguous_profile'}
    if(-not $profile -or -not (Test-CurrentImmutableIdentity $actual $profile)) {Add-CurrentDifference $stats 'group' $source 'missing_or_contradictory_profile'}
    if(@(Get-ExchangeDistributionGroupMismatches $actual $group $profile).Count) {Add-CurrentDifference $stats 'group' $source 'metadata_differs'}
    $actualMembers=Get-CurrentExchangeMembers $actual
    $desiredMembers=@($Rows.Members | Where-Object {$_.SourceGroupId -eq $group.SourceGroupId})
    if(@(Get-ExchangeGroupMembershipMismatches $desiredMembers $actualMembers).Count) {Add-CurrentDifference $stats 'membership' $source 'projected_email_multiset_differs'}
    foreach($member in $desiredMembers) {
      $email=Normalize-Email $member.MemberEmail
      $desiredContact=$Rows.ContactByEmail[$email]
      if($null -eq $desiredContact -or (Is-InternalContact $desiredContact $email)) {continue}
      $expectedRecipients=@($mailLookup.BySourceKey[(Clean-Text $desiredContact.SourceKey)] | Where-Object {$null -ne $_})
      $actualRecipients=@($actualMembers | Where-Object {(Normalize-Email (Get-RecipientEmail $_)) -ceq $email})
      if($expectedRecipients.Count -ne 1 -or $actualRecipients.Count -ne 1 -or -not (Test-CurrentImmutableIdentity $expectedRecipients[0] $actualRecipients[0])) {
        Add-CurrentDifference $stats 'membership' $source 'managed_member_identity_differs'
      }
    }
    $stats.membershipGroups++;$stats.memberships+=$actualMembers.Count
    # Preserve actual immutable member identity in the repeat-observation digest,
    # even though the worker's desired membership contract is normalized email.
    $memberState=@($actualMembers | ForEach-Object {[ordered]@{email=Get-RecipientEmail $_;id=Get-ExchangeStrongCommandIdentity $_}} | Sort-Object email,id)
    $observed.Add([ordered]@{kind='membership';source=$source;members=$memberState})
    if(($stats.membershipGroups % $GroupBatchSize) -eq 0) {Assert-CurrentCheckBudget;[Threading.Thread]::Yield() | Out-Null}
  }
  foreach($object in $mail) {
    if((Clean-Text $object.CustomAttribute1) -ceq $ManagedMarker) {
      $stats.managedContacts++
      if(-not (Has-MapKey $desiredContactKeys (Clean-Text $object.CustomAttribute2))) {Add-CurrentDifference $stats 'contact' (Clean-Text $object.CustomAttribute2) 'unexpected_managed_contact'}
    }
  }
  foreach($object in $groups) {
    if((Clean-Text $object.CustomAttribute1) -ceq $ManagedMarker) {
      $stats.managedGroups++
      if(-not (Has-MapKey $desiredGroupKeys (Clean-Text $object.CustomAttribute2))) {Add-CurrentDifference $stats 'group' (Clean-Text $object.CustomAttribute2) 'unexpected_managed_group'}
    }
  }
  # Include all collected identity + compared metadata in a repeat-read digest;
  # it is never output or stored, and unrelated recipient records are not dumped.
  foreach($kind in @('mail','profiles','groups','groupProfiles')) {
    $items=Get-Variable -Name $kind -ValueOnly
    $state=@($items | ForEach-Object {[ordered]@{id=Get-ExchangeStrongCommandIdentity $_;guid=Clean-Text $_.Guid;externalId=Clean-Text $_.ExternalDirectoryObjectId;dn=Clean-Text $_.DistinguishedName
      email=Get-RecipientEmail $_;smtp=Normalize-Email $_.PrimarySmtpAddress;alias=Clean-Text $_.Alias;name=Clean-Text $_.Name;displayName=Clean-Text $_.DisplayName
      firstName=Clean-Text $_.FirstName;lastName=Clean-Text $_.LastName;notes=Clean-Text $_.Notes;marker=Clean-Text $_.CustomAttribute1;source=Clean-Text $_.CustomAttribute2;hidden=[bool]$_.HiddenFromAddressListsEnabled}} | Sort-Object id)
    $observed.Add([ordered]@{kind=$kind;items=$state})
  }
  Assert-CurrentCheckBudget
  return @{Stats=$stats;Fingerprint=(Get-CurrentSha256 ($observed.ToArray() | ConvertTo-Json -Depth 30 -Compress));Complete=$true}
}

function Assert-CurrentSnapshot($Snapshot) {
  if ($Snapshot.Complete -isnot [bool] -or -not $Snapshot.Complete -or $null -eq $Snapshot.Rows -or
      [string]$Snapshot.Fingerprint -cnotmatch '^[0-9a-f]{64}$' -or [string]$Snapshot.RawFingerprint -cnotmatch '^[0-9a-f]{64}$') {throw 'CURRENT_CHECK_SOURCE_INCOMPLETE'}
  foreach($key in @('contacts','groups','members')) {Assert-CurrentNativeCount $Snapshot.Counts[$key]}
}

function Assert-CurrentOperationalState($State) {
  if ($State.Complete -isnot [bool] -or -not $State.Complete -or $State.ActiveSync -isnot [bool] -or
      [string]$State.QueueWatermark -notmatch '^(0|[1-9][0-9]*@.+)$' -or [string]$State.LedgerHead -cnotmatch '^[1-9][0-9]*@[0-9a-f]{64}$' -or
      [string]$State.LeaseFingerprint -cnotmatch '^[0-9a-f]{64}$') {throw 'CURRENT_CHECK_FENCE_INCOMPLETE'}
  Assert-CurrentNativeCount $State.UnsettledCount
}

function Invoke-CurrentAddressBookCheck {
  if ($null -eq $script:CurrentCheckClock -or -not $script:CurrentCheckClock.IsRunning) {$script:CurrentCheckClock=[Diagnostics.Stopwatch]::StartNew()}
  $result=[ordered]@{schema='fcuno.current-addressbook-observation/v1';version=$CurrentCheckVersion;status='INCONCLUSIVE';readOnly=$true;certified=$false
    observationOnly=$true;certificationWritten=$false;manualOnly=$true;roleVisibleOnly=$true;sourceStable=$false;queueStable=$false;exchangeStable=$false;startedAt=[DateTimeOffset]::UtcNow.ToString('o')
    finishedAt=$null;elapsedSeconds=0;workerSourceSha256=$CurrentCheckWorkerSourceSha256;configSha256=$CurrentCheckConfigSha256
    certificatePinIndependentlyVerified=$false;providerCredentialReadRestricted=$false;providerVisibilityIndependentlyVerified=$false
    scope='Current canonical FCUNO projection versus twice-observed role-visible Exchange managed contacts/groups and projected member-email multisets. Managed external-member immutable identity is also compared. Not an atomic snapshot, tenant-global inventory proof, provider authorization audit, history proof or client-delivery check.'
    budgetSeconds=$MaxDurationSeconds;budgetCancelsInflightCmdlet=$false;exchangeReadCmdlets=0
    counts=@{};mismatchCount=0;details=@();detailsTruncated=$false;reasons=@()}
  try {
    $before=Get-CurrentOperationalState;Assert-CurrentOperationalState $before
    if($before.ActiveSync -or $before.UnsettledCount -gt 0) {throw 'CURRENT_CHECK_SYNC_BUSY'}
    $source=Get-CurrentSourceSnapshot;Assert-CurrentSnapshot $source
    $result.counts=@{sourceContacts=$source.Counts.contacts;sourceGroups=$source.Counts.groups;sourceMembers=$source.Counts.members
      projectedContacts=[int]@($source.Rows.Contacts).Count;projectedGroups=[int]@($source.Rows.Groups).Count;projectedMembers=[int]@($source.Rows.Members).Count
      invalidContacts=[int]@($source.Rows.InvalidContacts).Count;skippedGroupShadowPlaceholders=[int]@($source.Rows.SkippedInvalidContacts).Count;duplicateSourceContacts=[int]@($source.Rows.DuplicateContacts).Count
      sourceValidationIssues=[int]@($source.SourceValidationIssues | Where-Object {$_}).Count}
    $first=Get-CurrentExchangeObservation $source.Rows
    $second=Get-CurrentExchangeObservation $source.Rows
    if($first.Complete -isnot [bool] -or -not $first.Complete -or $second.Complete -isnot [bool] -or -not $second.Complete -or
      [string]$first.Fingerprint -cnotmatch '^[0-9a-f]{64}$' -or [string]$second.Fingerprint -cnotmatch '^[0-9a-f]{64}$') {throw 'CURRENT_CHECK_EXCHANGE_INCOMPLETE'}
    $afterSource=Get-CurrentSourceSnapshot;Assert-CurrentSnapshot $afterSource
    $after=Get-CurrentOperationalState;Assert-CurrentOperationalState $after
    Assert-CurrentCheckBudget
    $result.sourceStable=$source.Fingerprint -ceq $afterSource.Fingerprint -and $source.RawFingerprint -ceq $afterSource.RawFingerprint
    $result.queueStable=$before.QueueWatermark -ceq $after.QueueWatermark -and $before.LedgerHead -ceq $after.LedgerHead -and $before.LeaseFingerprint -ceq $after.LeaseFingerprint
    $result.exchangeStable=$first.Fingerprint -ceq $second.Fingerprint
    $result.counts.observedManagedContacts=[int]$second.Stats.managedContacts;$result.counts.observedManagedGroups=[int]$second.Stats.managedGroups
    $result.counts.observedMembershipGroups=[int]$second.Stats.membershipGroups;$result.counts.observedMemberships=[int]$second.Stats.memberships
    $result.exchangeReadCmdlets=[int](8+$first.Stats.membershipGroups+$second.Stats.membershipGroups)
    $result.mismatchCount=[int]$second.Stats.mismatchCount;$result.details=@($second.Stats.details.ToArray());$result.detailsTruncated=$result.mismatchCount -gt $result.details.Count
    if(-not $result.sourceStable -or -not $result.queueStable -or -not $result.exchangeStable -or $after.ActiveSync -or $after.UnsettledCount -gt 0) {$result.reasons=@('observed_state_changed_or_sync_busy')}
    elseif($result.counts.invalidContacts -gt 0 -or $result.counts.sourceValidationIssues -gt 0) {$result.reasons=@('invalid_source_contacts_or_relations')}
    elseif($result.mismatchCount -gt 0) {$result.status='MISMATCH'}
    else {$result.status='OBSERVED_MATCH'}
  } catch {
    # Deliberately never serialize exception text: HTTP failures may contain
    # authenticated URLs, headers, credential values or private business data.
    $code=[string]$_.Exception.Message
    $result.reasons=@($(if($code -cmatch '^CURRENT_CHECK_[A-Z_]+$') {$code.ToLowerInvariant()} else {'provider_or_validation_read_failed'}))
  } finally {
    $result.finishedAt=[DateTimeOffset]::UtcNow.ToString('o')
    $result.elapsedSeconds=[int][Math]::Ceiling($script:CurrentCheckClock.Elapsed.TotalSeconds)
    $script:CurrentCheckClock.Stop()
  }
  return $result
}

if($LibraryOnly) {return}
$script:CurrentCheckClock=[Diagnostics.Stopwatch]::StartNew()
try {
  Initialize-CurrentCheckConnection
  $receipt=Invoke-CurrentAddressBookCheck
  Write-Output ($receipt | ConvertTo-Json -Depth 10 -Compress)
} catch {
  Write-Output ('{"schema":"fcuno.current-addressbook-observation/v1","status":"INCONCLUSIVE","readOnly":true,"certified":false,"observationOnly":true,"certificationWritten":false,"reasons":["connection_or_configuration_read_failed"]}')
} finally {
  try {Close-CurrentCheckConnection} catch {Write-Output 'Current address-book diagnostic session cleanup could not be confirmed; no repair or certification was attempted.'}
}
