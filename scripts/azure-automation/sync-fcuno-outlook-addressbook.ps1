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
$script:SyncLockLastRenewedAt = [DateTimeOffset]::MinValue
$script:SyncLockRenewInterval = [TimeSpan]::FromMinutes(5)
$script:CurrentSyncRequestedAt = $null

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

function Get-ExchangeContactProfileCommandIdentity($Profile) {
  if (-not $Profile) { throw "The Exchange contact profile is missing." }
  foreach ($propertyName in @("Guid", "DistinguishedName")) {
    $value = Clean-Text $Profile.$propertyName
    if ($value -and $value -ne "00000000-0000-0000-0000-000000000000") { return $value }
  }
  throw "The Exchange contact profile has no supported immutable GUID or distinguished-name identity."
}

function Get-ExchangeContactDirectoryName($Contact) {
  $directoryName = Clean-Text (Get-MapValue $Contact "DirectoryName")
  if (-not $directoryName) { $directoryName = Clean-Text (Get-MapValue $Contact "DisplayName") }
  if (-not $directoryName) { throw "The Exchange contact directory name is missing." }
  if ($directoryName.Length -gt 64) { throw "The Exchange contact directory name exceeds 64 characters." }
  return $directoryName
}

function Set-ExchangeContactProfile($Identity, $Contact) {
  $profile = @{
    Identity = $Identity
    Name = Get-ExchangeContactDirectoryName $Contact
    DisplayName = $Contact.DisplayName
    FirstName = $(if (Clean-Text $Contact.FirstName) { Clean-Text $Contact.FirstName } else { $null })
    LastName = $(if (Clean-Text $Contact.LastName) { Clean-Text $Contact.LastName } else { $null })
    ErrorAction = "Stop"
  }
  Renew-ExchangeSyncLockIfDue
  Set-Contact @profile
  Renew-ExchangeSyncLockIfDue
}

function Assert-ExchangeContactProfile($Identity, $Contact, $Label) {
  $expectedFirstName = Clean-Text $Contact.FirstName
  $expectedLastName = Clean-Text $Contact.LastName
  $actualFirstName = ""
  $actualLastName = ""
  for ($attempt = 1; $attempt -le 4; $attempt += 1) {
    if ($attempt -gt 1) { Start-Sleep -Seconds 2 }
    Renew-ExchangeSyncLockIfDue
    $profile = Get-Contact -Identity $Identity -ErrorAction Stop
    Renew-ExchangeSyncLockIfDue
    if (-not $profile) { continue }
    $actualFirstName = Clean-Text $profile.FirstName
    $actualLastName = Clean-Text $profile.LastName
    if ($actualFirstName -eq $expectedFirstName -and $actualLastName -eq $expectedLastName) { return }
  }
  throw "$Label has the wrong contact profile after verification. Expected FirstName '$expectedFirstName' and LastName '$expectedLastName'; got FirstName '$actualFirstName' and LastName '$actualLastName'."
}

function Assert-ExchangeRecipientName($Recipient, $ExpectedDirectoryName, $ExpectedDisplayName, $Label) {
  $expectedName = Clean-Text $ExpectedDirectoryName
  $expectedDisplayName = Clean-Text $ExpectedDisplayName
  $actualDisplayName = Clean-Text $Recipient.DisplayName
  $actualName = Clean-Text $Recipient.Name
  if ($actualDisplayName -cne $expectedDisplayName -or $actualName -cne $expectedName) {
    throw "$Label was updated but Exchange verification did not match. Expected Name '$expectedName' and DisplayName '$expectedDisplayName'; got Name '$actualName' and DisplayName '$actualDisplayName'."
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

function Test-ExchangeMailContactMatches($Existing, $Contact, $Profile = $null) {
  return @(Get-ExchangeMailContactMismatches $Existing $Contact $Profile).Count -eq 0
}

function Get-ExchangeDistributionGroupMismatches($Existing, $Group, $Profile = $null) {
  $mismatches = @()
  if (-not $Existing) { return @("distribution group is missing") }
  if (-not $Group) { return @("desired group is missing") }
  $expectedAlias = Clean-Text $Group.Alias
  $expectedName = Clean-Text $Group.GroupName
  $expectedSourceKey = Clean-Text $Group.SourceKey
  if (-not (Clean-Text $Existing.Alias).Equals($expectedAlias, [StringComparison]::OrdinalIgnoreCase)) { $mismatches += "alias" }
  if ((Clean-Text $Existing.Name) -cne $expectedName) { $mismatches += "name" }
  if ((Clean-Text $Existing.DisplayName) -cne $expectedName) { $mismatches += "display name" }
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

function Test-ExchangeDistributionGroupMatches($Existing, $Group, $Profile = $null) {
  return @(Get-ExchangeDistributionGroupMismatches $Existing $Group $Profile).Count -eq 0
}

function Add-ExchangeLookupEntry([hashtable]$Map, $Key, $Value) {
  $cleanKey = Clean-Text $Key
  if (-not $cleanKey) { return }
  if (Has-MapKey $Map $cleanKey) {
    $Map[$cleanKey] = @($Map[$cleanKey]) + @($Value)
  } else {
    $Map[$cleanKey] = @($Value)
  }
}

function Get-ExchangeObjectJoinKeys($ExchangeObject) {
  if (-not $ExchangeObject) { return @() }
  $seen = @{}
  foreach ($propertyName in @("Identity", "Guid", "ExternalDirectoryObjectId", "DistinguishedName")) {
    $value = Clean-Text $ExchangeObject.$propertyName
    if (-not $value -or $value -eq "00000000-0000-0000-0000-000000000000") { continue }
    $key = $value.ToLowerInvariant()
    if (Has-MapKey $seen $key) { continue }
    $seen[$key] = $true
    Write-Output $key
  }
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

function Test-ExchangeObjectsShareImmutableIdentity($First, $Second) {
  if (-not $First -or -not $Second) { return $false }
  $firstKeys = @{}
  foreach ($key in @(Get-ExchangeImmutableGroupJoinKeys $First)) { $firstKeys[$key] = $true }
  foreach ($key in @(Get-ExchangeImmutableGroupJoinKeys $Second)) {
    if (Has-MapKey $firstKeys $key) { return $true }
  }
  return $false
}

function Get-ExchangeStrongCommandIdentity($ExchangeObject) {
  if (-not $ExchangeObject) { return "" }
  foreach ($propertyName in @("Guid", "DistinguishedName", "ExternalDirectoryObjectId")) {
    $value = Clean-Text $ExchangeObject.$propertyName
    if ($value -and $value -ne "00000000-0000-0000-0000-000000000000") { return $value }
  }
  return ""
}

function Resolve-ExchangeContactProfileForMailContact($MailContact, $Label, [int]$MaxAttempts = 1) {
  if (-not $MailContact) { throw "$Label has no mail-contact object for profile resolution." }
  if ($MaxAttempts -lt 1) { $MaxAttempts = 1 }
  $filterProperty = ""
  $filterValue = ""
  foreach ($propertyName in @("Guid", "DistinguishedName")) {
    $value = Clean-Text $MailContact.$propertyName
    if ($value -and $value -ne "00000000-0000-0000-0000-000000000000") {
      $filterProperty = $propertyName
      $filterValue = $value
      break
    }
  }
  if (-not $filterValue) { throw "$Label has no supported immutable GUID or distinguished-name identity for profile resolution." }
  $escapedFilterValue = Escape-ExchangeFilterValue $filterValue
  $profileFilter = "$filterProperty -eq '$escapedFilterValue'"
  $lastResult = "no contact profile was visible through immutable $filterProperty '$filterValue'"
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
    if ($attempt -gt 1) { Start-Sleep -Seconds 2 }
    Renew-ExchangeSyncLockIfDue
    $profiles = @(Get-Contact -Filter $profileFilter -RecipientTypeDetails MailContact -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
    Renew-ExchangeSyncLockIfDue
    if ($profiles.Count -gt 1) {
      throw "$Label profile resolution found $($profiles.Count) Exchange contact profiles for immutable $filterProperty '$filterValue'."
    }
    if ($profiles.Count -eq 1) {
      $profile = Resolve-ExchangeContactProfileHint $MailContact (New-ExchangeContactProfileLookup @($profiles[0]))
      if ($profile) { return $profile }
      $lastResult = "the immutable identity returned one profile, but its GUID/distinguished name did not correlate to the mail contact"
    }
  }
  throw "$Label profile resolution failed after $MaxAttempts attempt(s): $lastResult."
}

function Get-ManagedExchangeMailContactBySourceKey($SourceKey, $Email, $Label, [int]$MaxAttempts = 1) {
  $sourceKey = Clean-Text $SourceKey
  $email = Normalize-Email $Email
  if (-not $sourceKey) { throw "$Label has no FCUNO source key." }
  if ($MaxAttempts -lt 1) { $MaxAttempts = 1 }
  $escapedSourceKey = Escape-ExchangeFilterValue $sourceKey
  $lastResult = "no mail contact with source key $sourceKey"
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
    if ($attempt -gt 1) { Start-Sleep -Seconds 2 }
    Renew-ExchangeSyncLockIfDue
    $matches = @(Get-MailContact -Filter "CustomAttribute2 -eq '$escapedSourceKey'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
    Renew-ExchangeSyncLockIfDue
    if ($matches.Count -gt 1) { throw "$Label source key $sourceKey resolved to $($matches.Count) Exchange mail contacts." }
    if ($matches.Count -eq 1) {
      $match = $matches[0]
      $actualEmail = Normalize-Email (Get-RecipientEmail $match)
      $actualSourceKey = Clean-Text $match.CustomAttribute2
      $actualMarker = Clean-Text $match.CustomAttribute1
      if ($actualEmail -eq $email -and $actualSourceKey -eq $sourceKey -and $actualMarker -eq $ManagedMarker) { return $match }
      $lastResult = "the mail contact is not yet fully marked for source key $sourceKey and email $email"
    }
  }
  throw "$Label could not be resolved exactly after $MaxAttempts attempt(s): $lastResult."
}

function Test-ExchangeIdentityNotFoundError($ErrorRecord) {
  if (-not $ErrorRecord) { return $false }
  $exceptionType = ""
  if ($ErrorRecord.Exception) {
    $exceptionType = Clean-Text $ErrorRecord.Exception.GetType().FullName
  }
  $fullyQualifiedErrorId = Clean-Text $ErrorRecord.FullyQualifiedErrorId
  if ($exceptionType -match "ManagementObjectNotFoundException$" -or $fullyQualifiedErrorId -match "ManagementObjectNotFoundException") {
    return $true
  }
  $message = Clean-Text $ErrorRecord.Exception.Message
  return $message -match "(?i)^The operation couldn't be performed because object '.+' couldn't be found(?: on '.+')?\.?$"
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

function Test-ExchangeObjectsRepresentSameRecipient($First, $Second) {
  if (-not $First -or -not $Second) { return $false }
  if ([object]::ReferenceEquals($First, $Second)) { return $true }
  $firstKeys = @{}
  foreach ($key in @(Get-ExchangeObjectJoinKeys $First)) { $firstKeys[$key] = $true }
  foreach ($key in @(Get-ExchangeObjectJoinKeys $Second)) {
    if (Has-MapKey $firstKeys $key) { return $true }
  }
  return $false
}

function Resolve-ExchangeMailContactCandidates($Contact, $SourceMatches, $EmailMatches) {
  $sourceKey = Clean-Text $Contact.SourceKey
  $email = Normalize-Email $Contact.ExternalEmailAddress
  $sourceCandidates = @($SourceMatches)
  $emailCandidates = @($EmailMatches)
  if ($sourceCandidates.Count -gt 1) { throw "More than one Exchange contact is tagged with source key $sourceKey." }
  if ($emailCandidates.Count -gt 1) { throw "More than one Exchange contact uses $email." }

  $sourceCandidate = if ($sourceCandidates.Count -eq 1) { $sourceCandidates[0] } else { $null }
  $emailCandidate = if ($emailCandidates.Count -eq 1) { $emailCandidates[0] } else { $null }
  if ($sourceCandidate -and $emailCandidate -and -not (Test-ExchangeObjectsRepresentSameRecipient $sourceCandidate $emailCandidate)) {
    throw "Exchange source key $sourceKey and email $email resolve to different contact objects, so neither object was changed."
  }
  if (-not $sourceCandidate -and $emailCandidate) {
    $emailOwnerKey = Clean-Text $emailCandidate.CustomAttribute2
    if ($emailOwnerKey -and $emailOwnerKey -ne $sourceKey) {
      $allowedOwnerKeys = @($Contact.AllowedOwnerSourceKeys | ForEach-Object { Clean-Text $_ })
      if ($allowedOwnerKeys -notcontains $emailOwnerKey) {
        throw "Exchange email $email belongs to source key $emailOwnerKey, not $sourceKey, so ownership was not transferred."
      }
    }
  }
  if ($sourceCandidate) { return $sourceCandidate }
  if ($emailCandidate) { return $emailCandidate }
  return $null
}

function New-ExchangeMailContactLookup($Contacts) {
  $lookup = @{ BySourceKey = @{}; ByEmail = @{} }
  foreach ($contact in @($Contacts)) {
    Add-ExchangeLookupEntry $lookup.BySourceKey (Clean-Text $contact.CustomAttribute2) $contact
    Add-ExchangeLookupEntry $lookup.ByEmail (Normalize-Email (Get-RecipientEmail $contact)) $contact
  }
  return $lookup
}

function Resolve-ExchangeMailContactHint($Contact, $Lookup) {
  $sourceKey = Clean-Text $Contact.SourceKey
  $sourceMatches = if ($sourceKey) { @($Lookup.BySourceKey[$sourceKey]) } else { @() }
  $email = Normalize-Email $Contact.ExternalEmailAddress
  $emailMatches = if ($email) { @($Lookup.ByEmail[$email]) } else { @() }
  return Resolve-ExchangeMailContactCandidates $Contact $sourceMatches $emailMatches
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

function Resolve-ExchangeDistributionGroupHint($Group, $Lookup) {
  $sourceKey = Clean-Text $Group.SourceKey
  $sourceMatches = if ($sourceKey) { @($Lookup.BySourceKey[$sourceKey]) } else { @() }
  if ($sourceMatches.Count -gt 1) { throw "More than one Exchange group is tagged with source key $sourceKey." }
  if ($sourceMatches.Count -eq 1) { return $sourceMatches[0] }

  $alias = (Clean-Text $Group.Alias).ToLowerInvariant()
  $aliasMatches = if ($alias) { @($Lookup.ByAlias[$alias]) } else { @() }
  if ($aliasMatches.Count -gt 1) { throw "More than one Exchange group uses alias '$alias'." }
  if ($aliasMatches.Count -eq 1) {
    $existing = $aliasMatches[0]
    $existingOwnerKey = Clean-Text $existing.CustomAttribute2
    if ($existingOwnerKey -and $existingOwnerKey -ne $sourceKey) {
      throw "Exchange alias $alias belongs to source key $existingOwnerKey, not $sourceKey."
    }
    if ((Clean-Text $existing.DisplayName) -ne (Clean-Text $Group.GroupName)) {
      throw "Exchange alias $alias belongs to group '$($existing.DisplayName)', not '$($Group.GroupName)'."
    }
    return $existing
  }

  return $null
}

function Format-HongKongTime($Value) {
  $date = [DateTimeOffset]::MinValue
  $text = Clean-Text $Value
  if ($text -and [DateTimeOffset]::TryParse($text, [ref]$date)) {
    return $date.ToUniversalTime().ToOffset([TimeSpan]::FromHours(8)).ToString("yyyy-MM-dd HH:mm:ss 'HKT'")
  }
  return (Get-Date).ToUniversalTime().AddHours(8).ToString("yyyy-MM-dd HH:mm:ss 'HKT'")
}

function ConvertTo-UtcTimestamp($Value) {
  if ($null -eq $Value) { return "" }
  try {
    $date = if ($Value -is [DateTimeOffset]) {
      [DateTimeOffset]$Value
    } elseif ($Value -is [DateTime]) {
      [DateTimeOffset]::new([DateTime]$Value)
    } else {
      $parsed = [DateTimeOffset]::MinValue
      if (-not [DateTimeOffset]::TryParse((Clean-Text $Value), [ref]$parsed)) { return "" }
      $parsed
    }
    return $date.ToUniversalTime().UtcDateTime.ToString("o")
  } catch {
    return ""
  }
}

function Format-OptionalHongKongTime($Value) {
  $date = [DateTimeOffset]::MinValue
  $text = Clean-Text $Value
  if (-not $text -or -not [DateTimeOffset]::TryParse($text, [ref]$date)) { return "" }
  return $date.ToUniversalTime().ToOffset([TimeSpan]::FromHours(8)).ToString("yyyy-MM-dd HH:mm:ss 'HKT'")
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

function Get-StableExchangeHash($Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes((Clean-Text $Value))))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-ExchangeDirectoryNameBase($DisplayName) {
  $baseName = Clean-Text $DisplayName
  if (-not $baseName) { $baseName = "FCUNO Contact" }
  if ($baseName.Length -gt 64) { $baseName = $baseName.Substring(0, 64) }
  return $baseName
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

function Is-InternalEmail($Email) {
  $internalDomains = @("cosulich.com.hk", "cosulich.com.sg")
  $domain = ((Clean-Text $Email).ToLowerInvariant().Split("@") | Select-Object -Last 1)
  return $internalDomains -contains $domain
}

function Is-InternalContact($Contact, $Email) {
  if (Is-InternalEmail $Email) { return $true }
  $sourceBook = Clean-Text (Get-MapValue $Contact "source_book")
  if (-not $sourceBook) { $sourceBook = Clean-Text (Get-MapValue $Contact "SourceBook") }
  return $sourceBook.Equals("FC-INTERNAL", [StringComparison]::OrdinalIgnoreCase)
}

function Load-AllRows($Table, $OrderColumn) {
  $rows = @()
  $pageSize = 1000
  $from = 0
  $orderExpression = Clean-Text $OrderColumn
  if ($orderExpression -notmatch "\.") { $orderExpression = "$orderExpression.asc" }
  while ($true) {
    Renew-ExchangeSyncLockIfDue
    $to = $from + $pageSize - 1
    $path = "$Table" + "?select=*&order=$orderExpression&offset=$from&limit=$pageSize"
    $batch = Invoke-SupabaseRest -Method "GET" -Path $path
    Renew-ExchangeSyncLockIfDue
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
  $allContactRows = @()
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
      Alias = ""
      ExternalEmailAddress = $email
      Nickname = Clean-Text $contact.nickname
      SourceKey = Get-ContactSourceKey $contact.id
    }

    $allContactRows += $row
    if (-not (Is-InternalContact $contact $email)) { $contactRows += $row }
    $seenEmails[$email] = $row
    $contactByEmail[$email] = $row
    $contactIdsByEmail[$email] = @((Clean-Text $contact.id))
    $contactById[(Clean-Text $contact.id)] = $row
  }

  $aliasOrderedContactRows = @(
    @($allContactRows | Where-Object { Is-InternalContact $_ $_.ExternalEmailAddress }) +
    @($allContactRows | Where-Object { -not (Is-InternalContact $_ $_.ExternalEmailAddress) })
  )
  foreach ($contactRow in $aliasOrderedContactRows) {
    $contactRow.Alias = Get-UniqueAlias $contactRow.BaseAlias $seenAliases ("contact:" + (Clean-Text $contactRow.SourceContactId))
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
    $forceStableSuffix = [int]$directoryNameCounts[$baseName.ToLowerInvariant()] -gt 1
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

function Get-CanonicalExchangeProjectionFingerprint($Rows) {
  if (-not $Rows) { return "" }
  $projection = [ordered]@{
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
        groupName = Clean-Text $_.GroupName
        baseAlias = Clean-Text $_.BaseAlias
        alias = Clean-Text $_.Alias
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
    duplicateContacts = @($Rows.DuplicateContacts | Sort-Object SourceContactId | ForEach-Object {
      [ordered]@{
        sourceContactId = Clean-Text $_.SourceContactId
        canonicalSourceContactId = Clean-Text $_.CanonicalSourceContactId
        email = Normalize-Email $_.Email
      }
    })
  }
  $json = $projection | ConvertTo-Json -Depth 8 -Compress
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-ExchangeQueueHighWater {
  $rows = @(Invoke-SupabaseRest -Method "GET" -Path "outlook_exchange_sync_queue?select=queue_sequence,updated_at&order=updated_at.desc,queue_sequence.desc&limit=1")
  if ($rows.Count -le 0) { return "0" }
  return "$(Clean-Text $rows[0].queue_sequence)@$(Clean-Text $rows[0].updated_at)"
}

function ConvertFrom-ExchangeQueueHighWater($Value) {
  $text = Clean-Text $Value
  if (-not $text) { throw "The Exchange queue high-water fence is missing." }
  $separatorPosition = $text.IndexOf("@")
  $sequenceText = if ($separatorPosition -ge 0) { $text.Substring(0, $separatorPosition) } else { $text }
  $updatedAtText = if ($separatorPosition -ge 0) { $text.Substring($separatorPosition + 1) } else { "" }
  [long]$sequence = 0
  if (-not [long]::TryParse($sequenceText, [ref]$sequence) -or $sequence -lt 0) {
    throw "The Exchange queue high-water sequence '$sequenceText' is invalid."
  }
  if ($sequence -gt 0 -and -not $updatedAtText) {
    throw "The Exchange queue high-water timestamp is missing for sequence $sequence."
  }
  if ($updatedAtText) {
    [DateTimeOffset]$parsedUpdatedAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($updatedAtText, [ref]$parsedUpdatedAt)) {
      throw "The Exchange queue high-water timestamp '$updatedAtText' is invalid."
    }
  }
  return [pscustomobject]@{
    Sequence = $sequence
    UpdatedAt = $(if ($updatedAtText) { $updatedAtText } else { $null })
  }
}

function Get-ExchangeSourceCertificationDrift($InitialFingerprint, $InitialQueueHighWater, $LatestFingerprint, $LatestQueueHighWater) {
  $reasons = @()
  if ((Clean-Text $InitialFingerprint) -cne (Clean-Text $LatestFingerprint)) {
    $reasons += "the canonical Exchange projection changed"
  }
  if ((Clean-Text $InitialQueueHighWater) -cne (Clean-Text $LatestQueueHighWater)) {
    $reasons += "the durable queue high-water changed from '$(Clean-Text $InitialQueueHighWater)' to '$(Clean-Text $LatestQueueHighWater)'"
  }
  return $reasons
}

function Sync-ExchangeAliasPeers($BaseAlias, [hashtable]$Stats, [bool]$SkipNoOpWrites = $false, [bool]$IncludeSinglePeer = $false) {
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
  if ($peers.Count -eq 0 -or ($peers.Count -eq 1 -and -not $IncludeSinglePeer)) { return }

  $orderedPeers = @($peers | Sort-Object `
    @{ Expression = { if ((Clean-Text $_.Value.Alias).Equals($base, [StringComparison]::OrdinalIgnoreCase)) { 1 } else { 0 } }; Ascending = $true }, `
    @{ Expression = { Clean-Text $_.Value.SourceKey }; Ascending = $true })
  foreach ($peer in $orderedPeers) {
    Renew-ExchangeSyncLockIfDue
    if ($peer.Kind -eq "contact") {
      Upsert-ExchangeMailContact $peer.Value $Stats $SkipNoOpWrites
    } else {
      Upsert-ExchangeDistributionGroup $peer.Value $Stats $SkipNoOpWrites
    }
    Renew-ExchangeSyncLockIfDue
  }
}

function Sync-ExchangeDirectoryNamePeers($DisplayName, [hashtable]$Stats, $ExcludeSourceKey = "", [bool]$IncludeSinglePeer = $false) {
  $displayNameText = Clean-Text $DisplayName
  if (-not $displayNameText) { return }
  $directoryBase = Get-ExchangeDirectoryNameBase $displayNameText
  $rows = Get-CanonicalExchangeRows
  $allPeers = @($rows.Contacts | Where-Object {
    (Get-ExchangeDirectoryNameBase $_.DisplayName).Equals($directoryBase, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($allPeers.Count -eq 0 -or ($allPeers.Count -eq 1 -and -not $IncludeSinglePeer)) { return }

  $excludedSourceKey = Clean-Text $ExcludeSourceKey
  foreach ($peer in @($allPeers | Sort-Object SourceKey)) {
    if ($excludedSourceKey -and (Clean-Text $peer.SourceKey) -eq $excludedSourceKey) { continue }
    Renew-ExchangeSyncLockIfDue
    Upsert-ExchangeMailContact $peer $Stats $true
    Renew-ExchangeSyncLockIfDue
  }
}

function Save-SyncStatus($Status, $Message, $Details = $null) {
  $now = (Get-Date).ToUniversalTime().ToString("o")
  $requestedAt = ConvertTo-UtcTimestamp $script:CurrentSyncRequestedAt
  if (-not $requestedAt) { $requestedAt = $now }
  $payload = @{
    key = "outlook-addressbook-exchange-sync"
    payload = @{
      status = $Status
      message = $Message
      requestedAt = $requestedAt
      response = $Details
    }
    updated_at = $now
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
  if ([bool]$result) { $script:SyncLockLastRenewedAt = [DateTimeOffset]::UtcNow }
  return [bool]$result
}

function Renew-ExchangeSyncLock {
  if (-not $script:CurrentQueueRunId) { throw "Cannot renew the Exchange sync lock without a run ID." }
  $result = Invoke-SupabaseRest -Method "POST" -Path "rpc/renew_outlook_exchange_sync_lock" -Body @{
    p_run_id = $script:CurrentQueueRunId
    p_lease_minutes = 30
  }
  if (-not [bool]$result) { throw "The Exchange sync job lost its global mutation lease." }
  $script:SyncLockLastRenewedAt = [DateTimeOffset]::UtcNow
}

function Renew-ExchangeSyncLockIfDue([switch]$Force) {
  if (-not $script:SyncLockAcquired) { return }
  $now = [DateTimeOffset]::UtcNow
  $lastRenewedAt = $script:SyncLockLastRenewedAt
  $renewalDue = $Force -or $lastRenewedAt -eq [DateTimeOffset]::MinValue -or ($now - $lastRenewedAt) -ge $script:SyncLockRenewInterval
  if (-not $renewalDue) { return }
  Renew-ExchangeSyncLock
  $script:SyncLockLastRenewedAt = [DateTimeOffset]::UtcNow
}

function Release-ExchangeSyncLock {
  if (-not $script:CurrentQueueRunId -or -not $script:SyncLockAcquired) { return }
  try {
    Invoke-SupabaseRest -Method "POST" -Path "rpc/release_outlook_exchange_sync_lock" -Body @{
      p_run_id = $script:CurrentQueueRunId
    } | Out-Null
  } finally {
    $script:SyncLockAcquired = $false
    $script:SyncLockLastRenewedAt = [DateTimeOffset]::MinValue
  }
}

function Get-ExchangeQueueBacklogRows {
  $allRows = @()
  $offset = 0
  $pageSize = 1000
  while ($true) {
    Renew-ExchangeSyncLockIfDue
    $select = "id,queue_sequence,status,attempts,next_attempt_at,run_id,processing_started_at,claimed_at,error_message,error_history,action,entity_type,entity_id,entity_email,entity_alias,display_name,event_id,actor_id,requested_by,created_at,payload,changed_fields,audit_log_ids,change_set_ids"
    $rows = @(Invoke-SupabaseRest -Method "GET" -Path "outlook_exchange_sync_queue?select=$select&or=(status.eq.pending,status.eq.processing,status.eq.failed)&order=queue_sequence.asc&offset=$offset&limit=$pageSize")
    $allRows += $rows
    if ($rows.Count -lt $pageSize) { break }
    $offset += $pageSize
  }
  return $allRows
}

function Get-ExchangeQueueBacklogCount {
  return @(Get-ExchangeQueueBacklogRows).Count
}

function Get-ExchangeQueueRetryState($Row, $ReferenceTime = $null) {
  $status = (Clean-Text $Row.status).ToLowerInvariant()
  $attempt = [Math]::Max(0, [int]$Row.attempts)
  $runId = Clean-Text $Row.run_id
  if (-not $ReferenceTime) { $ReferenceTime = [DateTimeOffset]::UtcNow }
  $referenceUtc = ([DateTimeOffset]$ReferenceTime).ToUniversalTime()

  if ($status -eq "pending") {
    return [pscustomobject]@{
      Code = "pending"
      Label = "Pending and ready for the next incremental sync."
      Retryable = $true
      Terminal = $false
    }
  }
  if ($status -eq "processing") {
    $leaseStartedAt = Clean-Text $Row.claimed_at
    if (-not $leaseStartedAt) { $leaseStartedAt = Clean-Text $Row.processing_started_at }
    $leaseText = Format-OptionalHongKongTime $leaseStartedAt
    $parts = @("Processing")
    if ($runId) { $parts += "under run $runId" }
    if ($leaseText) { $parts += "since $leaseText" }
    return [pscustomobject]@{
      Code = "processing"
      Label = (($parts -join " ") + ". If this lease is abandoned, the queue claim will expire it safely before deciding whether another retry remains.")
      Retryable = $false
      Terminal = $false
    }
  }
  if ($status -eq "failed") {
    if ($attempt -ge 3) {
      return [pscustomobject]@{
        Code = "terminal_limit"
        Label = "Terminal: retry limit exhausted after attempt $attempt of 3; manual correction and requeue are required."
        Retryable = $false
        Terminal = $true
      }
    }

    $nextAttemptText = Clean-Text $Row.next_attempt_at
    $nextAttempt = [DateTimeOffset]::MinValue
    if ($nextAttemptText -and [DateTimeOffset]::TryParse($nextAttemptText, [ref]$nextAttempt)) {
      $nextAttempt = $nextAttempt.ToUniversalTime()
      $nextAttemptHkt = Format-OptionalHongKongTime $nextAttempt
      $label = if ($nextAttempt -le $referenceUtc) {
        "Retryable now on the next incremental sync (attempt $attempt of 3 completed)."
      } else {
        "Retry scheduled for $nextAttemptHkt (attempt $attempt of 3 completed)."
      }
      return [pscustomobject]@{
        Code = $(if ($nextAttempt -le $referenceUtc) { "retry_due" } else { "retry_scheduled" })
        Label = $label
        Retryable = $true
        Terminal = $false
      }
    }

    return [pscustomobject]@{
      Code = "terminal_unscheduled"
      Label = "Terminal: no automatic retry is scheduled after attempt $attempt of 3; manual correction and requeue are required."
      Retryable = $false
      Terminal = $true
    }
  }

  return [pscustomobject]@{
    Code = "unknown"
    Label = "Queue status '$status' has no automatic retry classification."
    Retryable = $false
    Terminal = $false
  }
}

function Get-ExchangeQueueFailureTransition($Row, $ErrorMessage, $RecordedAt = $null) {
  if (-not $RecordedAt) { $RecordedAt = [DateTimeOffset]::UtcNow }
  $recordedAtUtc = ([DateTimeOffset]$RecordedAt).ToUniversalTime()
  $recordedAtText = $recordedAtUtc.ToString("o")
  $attempt = [Math]::Max(1, [int]$Row.attempts)
  $terminal = $attempt -ge 3
  $nextAttemptAt = if ($terminal) { $null } else { $recordedAtUtc.AddMinutes(15).ToString("o") }
  $history = @($Row.error_history | Where-Object { $null -ne $_ })
  $history += [ordered]@{
    type = "processing_failed"
    message = Clean-Text $ErrorMessage
    recorded_at = $recordedAtText
    attempt = $attempt
    terminal = $terminal
    run_id = Clean-Text $script:CurrentQueueRunId
  }
  $retryState = if ($terminal) {
    "Terminal: retry limit exhausted after attempt $attempt of 3; manual correction and requeue are required."
  } else {
    "Retry scheduled for $(Format-OptionalHongKongTime $nextAttemptAt) after attempt $attempt of 3."
  }
  return [pscustomobject]@{
    Attempt = $attempt
    Terminal = $terminal
    NextAttemptAt = $nextAttemptAt
    RetryState = $retryState
    Fields = @{
      status = "failed"
      error_message = Clean-Text $ErrorMessage
      error_history = @($history)
      next_attempt_at = $nextAttemptAt
      completed_at = $(if ($terminal) { $recordedAtText } else { $null })
      exchange_verified_at = $null
    }
  }
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

function Get-ExchangeAtomicRpcContractError($Result, $SuccessProperty, $RequiredSuccessObjectProperty) {
  if (-not $Result) { return "the RPC returned no JSON object" }
  $successPropertyValue = Get-MapValue $Result $SuccessProperty
  if ($successPropertyValue -isnot [bool]) { return "the '$SuccessProperty' flag is missing or is not boolean" }
  $idempotentValue = Get-MapValue $Result "idempotent"
  if ($idempotentValue -isnot [bool]) { return "the 'idempotent' flag is missing or is not boolean" }
  $reason = Clean-Text (Get-MapValue $Result "reason")
  if (-not $reason) { return "the result reason is missing" }
  [long]$supersededCount = -1
  if (-not [long]::TryParse((Clean-Text (Get-MapValue $Result "supersededCount")), [ref]$supersededCount) -or $supersededCount -lt 0) {
    return "the superseded row count is missing or invalid"
  }
  if (-not (Has-MapKey $Result "supersededRows")) { return "the superseded row details are missing" }
  $supersededRows = @(Get-MapValue $Result "supersededRows" | Where-Object { $null -ne $_ })
  if ($supersededRows.Count -ne $supersededCount) {
    return "the superseded row count ($supersededCount) does not match the returned detail count ($($supersededRows.Count))"
  }
  if ([bool]$successPropertyValue -and $RequiredSuccessObjectProperty -and -not (Get-MapValue $Result $RequiredSuccessObjectProperty)) {
    return "the successful result is missing '$RequiredSuccessObjectProperty'"
  }
  if ([bool]$successPropertyValue -and $SuccessProperty -eq "completed") {
    $completedRow = Get-MapValue $Result "completedRow"
    foreach ($propertyName in @("id", "eventId", "entityType", "entityId", "entityKey", "entityEmail", "entityAlias", "action", "displayName", "payload", "changeSetId", "changeSetIds", "auditLogId", "auditLogIds", "actorId", "requestedBy", "changedFields", "sourceVersion", "status", "attempts", "errorHistory", "runId", "exchangeVerifiedAt", "completedAt")) {
      if (-not (Has-MapKey $completedRow $propertyName)) { return "the completed row is missing '$propertyName'" }
    }
    if (-not (Clean-Text (Get-MapValue $completedRow "id")) -or (Clean-Text (Get-MapValue $completedRow "status")) -ne "completed") {
      return "the completed row identity or status is invalid"
    }
  }
  if ([bool]$successPropertyValue -and $SuccessProperty -eq "certified") {
    foreach ($propertyName in @("certifiedAt", "sourceFingerprint", "queueFence")) {
      if (-not (Has-MapKey $Result $propertyName) -or -not (Get-MapValue $Result $propertyName)) { return "the certification result is missing '$propertyName'" }
    }
  }
  foreach ($supersededRow in $supersededRows) {
    foreach ($propertyName in @("id", "eventId", "entityType", "entityId", "entityKey", "entityEmail", "entityAlias", "action", "displayName", "payload", "changeSetId", "changeSetIds", "auditLogId", "auditLogIds", "actorId", "requestedBy", "changedFields", "sourceVersion", "status", "attempts", "previousErrorMessage", "errorMessage", "errorHistory", "previousRunId", "completedAt")) {
      if (-not (Has-MapKey $supersededRow $propertyName)) { return "a superseded row is missing '$propertyName'" }
    }
    if (-not (Clean-Text (Get-MapValue $supersededRow "id")) -or (Clean-Text (Get-MapValue $supersededRow "status")) -ne "skipped") {
      return "a superseded row identity or status is invalid"
    }
    if ($SuccessProperty -eq "completed") {
      foreach ($propertyName in @("supersededByQueueRowId", "supersededByRunId")) {
        if (-not (Clean-Text (Get-MapValue $supersededRow $propertyName))) { return "an incrementally superseded row is missing '$propertyName'" }
      }
    } elseif (-not (Clean-Text (Get-MapValue $supersededRow "supersededByFullRunId"))) {
      return "a full-certification superseded row is missing 'supersededByFullRunId'"
    }
  }
  return ""
}

function Invoke-ExchangeAtomicRpcWithRetry($Path, [hashtable]$Body, $SuccessProperty, $RequiredSuccessObjectProperty, $OperationLabel) {
  $lastAmbiguousError = ""
  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    try {
      Renew-ExchangeSyncLockIfDue
      $result = Invoke-SupabaseRest -Method "POST" -Path $Path -Body $Body
      Renew-ExchangeSyncLockIfDue
      $contractError = Get-ExchangeAtomicRpcContractError $result $SuccessProperty $RequiredSuccessObjectProperty
      if ($contractError) {
        throw "$OperationLabel returned malformed confirmation: $contractError."
      }
      if (-not [bool](Get-MapValue $result $SuccessProperty)) {
        throw "$OperationLabel was not accepted: $(Clean-Text (Get-MapValue $result 'reason'))"
      }
      return $result
    } catch {
      $lastAmbiguousError = Clean-Text $_.Exception.Message
      $isConfirmedRejection = $lastAmbiguousError -like "$OperationLabel was not accepted:*"
      if ($isConfirmedRejection -or $attempt -ge 3) { throw }
      Start-Sleep -Seconds 2
    }
  }
  throw "$OperationLabel did not return a confirmed result after bounded retries. Last error: $lastAmbiguousError"
}

function Complete-VerifiedExchangeQueueRow($RowId) {
  $rowIdText = Clean-Text $RowId
  if (-not (Test-GuidText $rowIdText)) { throw "A valid queue row UUID is required for atomic verified completion." }
  if (-not (Test-GuidText $script:CurrentQueueRunId)) { throw "A valid active run UUID is required for atomic verified completion." }
  return Invoke-ExchangeAtomicRpcWithRetry `
    "rpc/complete_verified_outlook_exchange_sync_queue_row" `
    @{ p_queue_row_id = $rowIdText; p_run_id = $script:CurrentQueueRunId } `
    "completed" `
    "completedRow" `
    "Atomic Exchange queue completion"
}

function Commit-FullExchangeQueueCertification($QueueHighWater, $SourceFingerprint) {
  if (-not (Test-GuidText $script:CurrentQueueRunId)) { throw "A valid active run UUID is required for full Exchange queue certification." }
  $fingerprint = Clean-Text $SourceFingerprint
  if (-not $fingerprint) { throw "The source fingerprint is required for full Exchange queue certification." }
  $fence = ConvertFrom-ExchangeQueueHighWater $QueueHighWater
  return Invoke-ExchangeAtomicRpcWithRetry `
    "rpc/certify_full_outlook_exchange_sync_queue" `
    @{
      p_run_id = $script:CurrentQueueRunId
      p_queue_high_water_sequence = [long]$fence.Sequence
      p_queue_high_water_updated_at = $fence.UpdatedAt
      p_source_fingerprint = $fingerprint
    } `
    "certified" `
    "queueFence" `
    "Atomic full Exchange queue certification"
}

function Get-ContactExchangeRowFromSource($SourceContactId) {
  $sourceId = Clean-Text $SourceContactId
  if (-not $sourceId) { return $null }
  $rows = Get-CanonicalExchangeRows
  if (-not (Has-MapKey $rows.ContactById $sourceId)) { return $null }
  $contact = $rows.ContactById[$sourceId]
  if ($contact -and -not (Is-InternalContact $contact $contact.ExternalEmailAddress)) { return $contact }
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
        id = "FCUNO contact ID"
        display_name = "Display name"
        primary_email = "Email"
        nickname = "Nickname / alias seed"
        first_name = "First name"
        last_name = "Last name"
        source_book = "Source book"
        source_card = "Source card"
        vcard = "vCard metadata"
        properties = "Contact properties metadata"
      }
    }
    "group" {
      $before = $Row.payload.beforeGroup
      $after = $Row.payload.afterGroup
      $labels = [ordered]@{
        id = "FCUNO group ID"
        name = "Group name"
        nickname = "Nickname / alias seed"
        description = "Description"
        source_book = "Source book"
        source_uid = "Source UID"
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

  $action = (Clean-Text $Row.action).ToLowerInvariant()
  $restrictToChangedFields = $action -in @("update_contact", "update_group")
  $explicitChangedFields = @($Row.changed_fields | ForEach-Object { (Clean-Text $_).ToLowerInvariant() } | Where-Object { $_ })
  if ($explicitChangedFields.Count -le 0 -and $Row.payload -and (Has-MapKey $Row.payload "changedFields")) {
    $explicitChangedFields = @(Get-MapValue $Row.payload "changedFields" | ForEach-Object { (Clean-Text $_).ToLowerInvariant() } | Where-Object { $_ })
  }
  $explicitFieldLookup = @{}
  foreach ($fieldName in $explicitChangedFields) { $explicitFieldLookup[$fieldName] = $true }

  $changes = @()
  foreach ($field in $labels.Keys) {
    if ($restrictToChangedFields -and -not (Has-MapKey $explicitFieldLookup $field.ToLowerInvariant())) { continue }
    $oldValue = Get-PayloadProperty $before $field
    $newValue = Get-PayloadProperty $after $field
    if ($oldValue -ceq $newValue) { continue }
    if ($field -in @("vcard", "properties")) {
      $changes += "$($labels[$field]): changed (FCUNO metadata / verification-only; raw value omitted)"
      continue
    }
    $oldLabel = if ($oldValue) { $oldValue } else { "(blank)" }
    $newLabel = if ($newValue) { $newValue } else { "(blank)" }
    $changes += "$($labels[$field]): $oldLabel -> $newLabel"
  }
  return $changes
}

function Get-QueueSupersededSaveCount($Row) {
  if (-not $Row -or -not $Row.payload -or -not (Has-MapKey $Row.payload "operationHistory")) { return 0 }
  $history = @(Get-MapValue $Row.payload "operationHistory" | Where-Object { $null -ne $_ -and (Clean-Text $_) })
  return [Math]::Max(0, $history.Count - 1)
}

function Add-SyncChangeDetail([hashtable]$Stats, $Row, $Status, $Result, $QueueStatus = "", $RetryState = $null, $NextRetryAt = "", $RunId = "") {
  if (-not (Has-MapKey $Stats "changeDetails")) { $Stats["changeDetails"] = @() }
  $effectiveQueueStatus = (Clean-Text $QueueStatus).ToLowerInvariant()
  if (-not $effectiveQueueStatus) { $effectiveQueueStatus = (Clean-Text $Status).ToLowerInvariant() }
  if (-not $effectiveQueueStatus) { $effectiveQueueStatus = (Clean-Text $Row.status).ToLowerInvariant() }
  if (-not $RetryState -and $effectiveQueueStatus -in @("pending", "processing", "failed")) {
    $RetryState = Get-ExchangeQueueRetryState $Row
  }
  $nextRetryText = Clean-Text $NextRetryAt
  if (-not $nextRetryText) { $nextRetryText = Clean-Text $Row.next_attempt_at }
  $runIdText = Clean-Text $RunId
  if (-not $runIdText) { $runIdText = Clean-Text $Row.run_id }
  $Stats["changeDetails"] = @($Stats["changeDetails"]) + [pscustomobject]@{
    status = (Clean-Text $Status).ToLowerInvariant()
    queueStatus = $effectiveQueueStatus
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
    attempt = [Math]::Max(0, [int]$Row.attempts)
    retryState = $(if ($RetryState) { Clean-Text $RetryState.Label } else { "" })
    retryable = $(if ($RetryState) { [bool]$RetryState.Retryable } else { $false })
    terminal = $(if ($RetryState) { [bool]$RetryState.Terminal } else { $false })
    nextRetryAt = Format-OptionalHongKongTime $nextRetryText
    runId = $runIdText
    latestError = Clean-Text $Row.error_message
    errorHistory = @($Row.error_history | Where-Object { $null -ne $_ })
    fieldChanges = @(Get-QueueFieldChanges $Row)
    auditLogIds = @($Row.audit_log_ids | ForEach-Object { Clean-Text $_ } | Where-Object { $_ })
    changeSetIds = @($Row.change_set_ids | ForEach-Object { Clean-Text $_ } | Where-Object { $_ })
  }
}

function Get-ExchangeSupersessionIds($Row, $PluralProperty, $SingularProperty) {
  $ids = @()
  foreach ($value in @(Get-MapValue $Row $PluralProperty) + @(Get-MapValue $Row $SingularProperty)) {
    $id = Clean-Text $value
    if ($id -and $ids -notcontains $id) { $ids += $id }
  }
  return $ids
}

function Add-ExchangeResolvedTerminalQueueDetails([hashtable]$Stats, $RpcResult, $ResolutionMode) {
  [int]$supersededCount = [int](Get-MapValue $RpcResult "supersededCount")
  if ($supersededCount -le 0) { return }
  $supersededRows = @(Get-MapValue $RpcResult "supersededRows" | Where-Object { $null -ne $_ })
  Increment-Stat $Stats "resolvedTerminalQueueRows" $supersededCount
  Increment-Stat $Stats "skippedQueueRows" $supersededCount

  foreach ($supersededRow in $supersededRows) {
    $entityType = Clean-Text (Get-MapValue $supersededRow "entityType")
    $entityKey = Clean-Text (Get-MapValue $supersededRow "entityKey")
    $entityEmail = Normalize-Email (Get-MapValue $supersededRow "entityEmail")
    $entityAlias = Clean-Text (Get-MapValue $supersededRow "entityAlias")
    if (-not $entityEmail -and $entityType -eq "contact" -and (Test-ValidEmail $entityKey)) { $entityEmail = Normalize-Email $entityKey }
    if (-not $entityAlias -and $entityType -ne "contact") { $entityAlias = $entityKey }
    $auditLogIds = @(Get-ExchangeSupersessionIds $supersededRow "auditLogIds" "auditLogId")
    $changeSetIds = @(Get-ExchangeSupersessionIds $supersededRow "changeSetIds" "changeSetId")
    $previousError = Clean-Text (Get-MapValue $supersededRow "previousErrorMessage")
    $supersedingQueueRowId = Clean-Text (Get-MapValue $supersededRow "supersededByQueueRowId")
    $supersedingRunId = Clean-Text (Get-MapValue $supersededRow "supersededByRunId")
    $supersedingFullRunId = Clean-Text (Get-MapValue $supersededRow "supersededByFullRunId")
    $resolutionParts = @()
    if ((Clean-Text $ResolutionMode).ToLowerInvariant() -eq "full") {
      $resolutionParts += "Terminal queue failure was resolved by source-fenced full Exchange certification run $supersedingFullRunId."
    } else {
      $resolutionParts += "Terminal queue failure was resolved by later Exchange-verified processing of the current FCUNO state in queue row $supersedingQueueRowId from run $supersedingRunId."
    }
    if ($previousError) { $resolutionParts += "Previous terminal error: $previousError" }
    $resolutionParts += "The durable queue error history retains the original failure and the supersession record."

    $detailRow = [pscustomobject]@{
      id = Clean-Text (Get-MapValue $supersededRow "id")
      event_id = Clean-Text (Get-MapValue $supersededRow "eventId")
      entity_type = $entityType
      entity_id = Clean-Text (Get-MapValue $supersededRow "entityId")
      entity_key = $entityKey
      entity_email = $entityEmail
      entity_alias = $entityAlias
      action = Clean-Text (Get-MapValue $supersededRow "action")
      display_name = Clean-Text (Get-MapValue $supersededRow "displayName")
      payload = Get-MapValue $supersededRow "payload"
      changed_fields = @(Get-MapValue $supersededRow "changedFields")
      audit_log_ids = $auditLogIds
      change_set_ids = $changeSetIds
      actor_id = Clean-Text (Get-MapValue $supersededRow "actorId")
      requested_by = Clean-Text (Get-MapValue $supersededRow "requestedBy")
      created_at = ""
      status = "skipped"
      attempts = [Math]::Max(0, [int](Get-MapValue $supersededRow "attempts"))
      next_attempt_at = ""
      run_id = Clean-Text (Get-MapValue $supersededRow "previousRunId")
      error_message = $previousError
      error_history = @(Get-MapValue $supersededRow "errorHistory" | Where-Object { $null -ne $_ })
    }
    $resolvedState = [pscustomobject]@{
      Label = "Resolved: later Exchange-verified processing of the current FCUNO state superseded this terminal failure."
      Retryable = $false
      Terminal = $false
    }
    Add-SyncChangeDetail $Stats $detailRow "superseded" ($resolutionParts -join " ") "skipped" $resolvedState "" $detailRow.run_id
    $detail = @($Stats["changeDetails"])[@($Stats["changeDetails"]).Count - 1]
    $detail | Add-Member -NotePropertyName supersededByQueueRowId -NotePropertyValue $supersedingQueueRowId -Force
    $detail | Add-Member -NotePropertyName supersededByRunId -NotePropertyValue $supersedingRunId -Force
    $detail | Add-Member -NotePropertyName supersededByFullRunId -NotePropertyValue $supersedingFullRunId -Force
  }
}

function Add-ExchangeQueueBacklogDetails([hashtable]$Stats, $Rows) {
  if (-not (Has-MapKey $Stats "changeDetails")) { $Stats["changeDetails"] = @() }
  $queueRowPositions = @{}
  for ($detailPosition = 0; $detailPosition -lt @($Stats["changeDetails"]).Count; $detailPosition += 1) {
    $detail = @($Stats["changeDetails"])[$detailPosition]
    $existingId = Clean-Text (Get-DetailValue $detail "queueRowId")
    if ($existingId) { $queueRowPositions[$existingId] = $detailPosition }
  }

  $retryableRows = 0
  $terminalRows = 0
  $activeRows = 0
  foreach ($row in @($Rows)) {
    $retryState = Get-ExchangeQueueRetryState $row
    if ([bool]$retryState.Retryable) {
      $retryableRows += 1
    } elseif ([bool]$retryState.Terminal) {
      $terminalRows += 1
    } else {
      $activeRows += 1
    }

    $rowId = Clean-Text $row.id
    $queueStatus = (Clean-Text $row.status).ToLowerInvariant()
    $resultParts = @("Queue status: $queueStatus.")
    $latestError = Clean-Text $row.error_message
    if ($latestError) { $resultParts += "Latest error: $latestError" }
    if ($rowId -and (Has-MapKey $queueRowPositions $rowId)) {
      $previousResult = Clean-Text (Get-DetailValue @($Stats["changeDetails"])[$queueRowPositions[$rowId]] "result")
      if ($previousResult -and $previousResult -notmatch "^Queue status:") { $resultParts += "Current run result: $previousResult" }
    }
    $resultParts += "Retry state: $($retryState.Label)"
    $detailStats = @{ changeDetails = @() }
    Add-SyncChangeDetail $detailStats $row $queueStatus ($resultParts -join " ") $queueStatus $retryState $row.next_attempt_at $row.run_id
    $authoritativeDetail = @($detailStats.changeDetails)[0]
    if ($rowId -and (Has-MapKey $queueRowPositions $rowId)) {
      $updatedDetails = @($Stats["changeDetails"])
      $updatedDetails[$queueRowPositions[$rowId]] = $authoritativeDetail
      $Stats["changeDetails"] = $updatedDetails
    } else {
      $Stats["changeDetails"] = @($Stats["changeDetails"]) + $authoritativeDetail
      if ($rowId) { $queueRowPositions[$rowId] = @($Stats["changeDetails"]).Count - 1 }
    }
  }
  $Stats["retryableBacklogRows"] = $retryableRows
  $Stats["terminalBacklogRows"] = $terminalRows
  $Stats["activeBacklogRows"] = $activeRows
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

function Add-FullSyncMutationDetail([hashtable]$Stats, $ActionLabel, $EntityType, $DisplayName, $Identifier, $StableId, $ExchangeIdentity, $Result, $FieldChanges) {
  if (-not (Has-MapKey $Stats "changeDetails")) { $Stats["changeDetails"] = @() }
  $Stats["changeDetails"] = @($Stats["changeDetails"]) + [pscustomobject]@{
    status = "completed"
    queueStatus = "completed"
    action = "full_sync"
    actionLabel = Clean-Text $ActionLabel
    entityType = Clean-Text $EntityType
    displayName = Clean-Text $DisplayName
    identifier = Clean-Text $Identifier
    stableId = Clean-Text $StableId
    exchangeIdentity = Clean-Text $ExchangeIdentity
    result = Clean-Text $Result
    queueRowId = ""
    eventId = ""
    actorId = ""
    requestedBy = ""
    queuedAt = ""
    attempt = 0
    retryState = ""
    retryable = $false
    terminal = $false
    nextRetryAt = ""
    runId = Clean-Text $script:CurrentQueueRunId
    latestError = ""
    fieldChanges = @($FieldChanges | ForEach-Object { Clean-Text $_ } | Where-Object { $_ })
    auditLogIds = @()
    changeSetIds = @()
  }
}

function Publish-FullSyncMutationDetails([hashtable]$Stats, $Details, [bool]$Verified, $VerificationError = "") {
  if (-not (Has-MapKey $Stats "changeDetails")) { $Stats["changeDetails"] = @() }
  foreach ($detail in @($Details)) {
    if ($null -eq $detail) { continue }
    if ($Verified) {
      $Stats["changeDetails"] = @($Stats["changeDetails"]) + $detail
      continue
    }
    $failedDetail = [pscustomobject]@{}
    foreach ($property in @($detail.PSObject.Properties)) {
      $failedDetail | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
    }
    $failedDetail.status = "failed"
    $failedDetail.queueStatus = "failed"
    $failedDetail.result = "Partial Exchange mutation was attempted but final verification failed: $(Clean-Text $VerificationError)"
    $Stats["changeDetails"] = @($Stats["changeDetails"]) + $failedDetail
  }
}

function Get-FullContactMutationFieldChanges($Existing, $Profile, $Contact, [bool]$Created) {
  $beforeMissing = $(if ($Created) { "(missing)" } else { "(blank)" })
  $fields = @(
    [pscustomobject]@{ Label = "Name"; Before = $(if ($Existing) { Clean-Text $Existing.Name } else { $beforeMissing }); After = Get-ExchangeContactDirectoryName $Contact },
    [pscustomobject]@{ Label = "Display name"; Before = $(if ($Existing) { Clean-Text $Existing.DisplayName } else { $beforeMissing }); After = Clean-Text $Contact.DisplayName },
    [pscustomobject]@{ Label = "Email"; Before = $(if ($Existing) { Normalize-Email (Get-RecipientEmail $Existing) } else { $beforeMissing }); After = Normalize-Email $Contact.ExternalEmailAddress },
    [pscustomobject]@{ Label = "Alias"; Before = $(if ($Existing) { Clean-Text $Existing.Alias } else { $beforeMissing }); After = Clean-Text $Contact.Alias },
    [pscustomobject]@{ Label = "First name"; Before = $(if ($Profile) { Clean-Text $Profile.FirstName } elseif ($Created) { $beforeMissing } else { "(unresolved)" }); After = Clean-Text $Contact.FirstName },
    [pscustomobject]@{ Label = "Last name"; Before = $(if ($Profile) { Clean-Text $Profile.LastName } elseif ($Created) { $beforeMissing } else { "(unresolved)" }); After = Clean-Text $Contact.LastName },
    [pscustomobject]@{ Label = "Management marker"; Before = $(if ($Existing) { Clean-Text $Existing.CustomAttribute1 } else { $beforeMissing }); After = $ManagedMarker },
    [pscustomobject]@{ Label = "FCUNO source key"; Before = $(if ($Existing) { Clean-Text $Existing.CustomAttribute2 } else { $beforeMissing }); After = Clean-Text $Contact.SourceKey },
    [pscustomobject]@{ Label = "Address-list visibility"; Before = $(if ($Existing) { $(if ([bool]$Existing.HiddenFromAddressListsEnabled) { "Hidden" } else { "Visible" }) } else { $beforeMissing }); After = "Visible" }
  )
  $changes = @()
  foreach ($field in $fields) {
    $before = $(if (Clean-Text $field.Before) { Clean-Text $field.Before } else { "(blank)" })
    $after = $(if (Clean-Text $field.After) { Clean-Text $field.After } else { "(blank)" })
    if ($Created -or $before -cne $after) { $changes += "$($field.Label): $before -> $after" }
  }
  return $changes
}

function Get-FullGroupMutationFieldChanges($Existing, $Profile, $Group, [bool]$Created) {
  $beforeMissing = $(if ($Created) { "(missing)" } else { "(blank)" })
  $fields = @(
    [pscustomobject]@{ Label = "Name"; Before = $(if ($Existing) { Clean-Text $Existing.Name } else { $beforeMissing }); After = Clean-Text $Group.GroupName },
    [pscustomobject]@{ Label = "Group name"; Before = $(if ($Existing) { Clean-Text $Existing.DisplayName } else { $beforeMissing }); After = Clean-Text $Group.GroupName },
    [pscustomobject]@{ Label = "Alias"; Before = $(if ($Existing) { Clean-Text $Existing.Alias } else { $beforeMissing }); After = Clean-Text $Group.Alias },
    [pscustomobject]@{ Label = "Description"; Before = $(if ($Profile) { Clean-Text $Profile.Notes } elseif ($Created) { $beforeMissing } else { "(unresolved)" }); After = Clean-Text $Group.Description },
    [pscustomobject]@{ Label = "Management marker"; Before = $(if ($Existing) { Clean-Text $Existing.CustomAttribute1 } else { $beforeMissing }); After = $ManagedMarker },
    [pscustomobject]@{ Label = "FCUNO source key"; Before = $(if ($Existing) { Clean-Text $Existing.CustomAttribute2 } else { $beforeMissing }); After = Clean-Text $Group.SourceKey },
    [pscustomobject]@{ Label = "Address-list visibility"; Before = $(if ($Existing) { $(if ([bool]$Existing.HiddenFromAddressListsEnabled) { "Hidden" } else { "Visible" }) } else { $beforeMissing }); After = "Visible" }
  )
  $changes = @()
  foreach ($field in $fields) {
    $before = $(if (Clean-Text $field.Before) { Clean-Text $field.Before } else { "(blank)" })
    $after = $(if (Clean-Text $field.After) { Clean-Text $field.After } else { "(blank)" })
    if ($Created -or $before -cne $after) { $changes += "$($field.Label): $before -> $after" }
  }
  return $changes
}

function Test-ExchangeRecreateEligibleError($Message) {
  $text = Clean-Text $Message
  return $text -match "(?i)(ManagementObjectNotFoundException|object[^.]*could not be found|object[^.]*couldn't be found|object[^.]*does not exist|invalid (recipient )?object|recipient object is invalid)"
}

function Upsert-ExchangeMailContact($Contact, [hashtable]$Stats, [bool]$SkipNoOpWrites = $false, $ExistingHint = $null, [bool]$UseExistingHint = $false, $ExistingProfileHint = $null) {
  Renew-ExchangeSyncLockIfDue
  if (-not $Contact) {
    Increment-Stat $Stats "skippedQueueRows"
    return
  }

  $email = Normalize-Email $Contact.ExternalEmailAddress
  if (-not (Test-ValidEmail $email)) { throw "Invalid Exchange email address '$email' for $($Contact.DisplayName)." }
  $sourceKey = Clean-Text $Contact.SourceKey
  $escapedSourceKey = Escape-ExchangeFilterValue $sourceKey
  $escapedEmail = Escape-ExchangeFilterValue $email
  $existing = $null
  if ($UseExistingHint) {
    $existing = $ExistingHint
  } else {
    $sourceMatches = @()
    if ($sourceKey) {
      $sourceMatches = @(Get-MailContact -Filter "CustomAttribute2 -eq '$escapedSourceKey'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
    }
    $emailMatches = @(Get-MailContact -Filter "ExternalEmailAddress -eq '$escapedEmail'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
    Renew-ExchangeSyncLockIfDue
    $existing = Resolve-ExchangeMailContactCandidates $Contact $sourceMatches $emailMatches
  }

  if ($existing -and -not (Get-ExchangeStrongCommandIdentity $existing)) {
    throw "Existing Exchange contact $email has no immutable identity, so the update was blocked without mutation."
  }
  if (-not $existing) {
    $ExistingProfileHint = $null
  } elseif ($ExistingProfileHint) {
    $correlatedProfileHint = Resolve-ExchangeContactProfileHint $existing (New-ExchangeContactProfileLookup @($ExistingProfileHint))
    $ExistingProfileHint = $correlatedProfileHint
  }
  if ($existing -and -not $ExistingProfileHint) {
    $ExistingProfileHint = Resolve-ExchangeContactProfileForMailContact $existing "Exchange contact $email" 1
  }
  $existingBeforeMutation = $existing
  $profileBeforeMutation = $ExistingProfileHint
  $fullMutationAction = ""
  if ($existing -and $SkipNoOpWrites -and (Test-ExchangeMailContactMatches $existing $Contact $ExistingProfileHint)) {
    Increment-Stat $Stats "verifiedQueueRows"
    return
  } elseif ($existing) {
    $fullMutationAction = "Update contact"
    $identity = Get-ExchangeStrongCommandIdentity $existing
    if (-not $identity) { throw "Existing Exchange contact $email has no immutable identity, so the update was blocked without mutation." }
    $profileIdentity = Get-ExchangeContactProfileCommandIdentity $ExistingProfileHint
    try {
      Renew-ExchangeSyncLockIfDue
      Set-MailContact -Identity $identity -ExternalEmailAddress $email -Alias $Contact.Alias -CustomAttribute1 $ManagedMarker -CustomAttribute2 $sourceKey -HiddenFromAddressListsEnabled $false -ErrorAction Stop
      Renew-ExchangeSyncLockIfDue
      Set-ExchangeContactProfile $profileIdentity $Contact
    } catch {
      $updateError = Clean-Text $_.Exception.Message
      if ((Clean-Text $existing.CustomAttribute1) -ne $ManagedMarker -or -not (Test-ExchangeRecreateEligibleError $updateError)) { throw }

      Renew-ExchangeSyncLockIfDue
      $rereadMatches = @(Get-MailContact -Filter "CustomAttribute2 -eq '$escapedSourceKey'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
      Renew-ExchangeSyncLockIfDue
      if ($rereadMatches.Count -gt 1) { throw "Managed contact recreation was blocked because more than one object now has source key $sourceKey. Original error: $updateError" }
      if ($rereadMatches.Count -eq 1) {
        $reread = $rereadMatches[0]
        if (-not (Test-ExchangeObjectsShareImmutableIdentity $existing $reread)) {
          throw "Managed contact recreation was blocked because source-key ownership changed after the update error. Original error: $updateError"
        }
        if ($updateError -notmatch "(?i)(invalid (recipient )?object|recipient object is invalid)") {
          throw "Managed contact recreation was blocked because the immutable contact still exists; the update will retry without deletion. Original error: $updateError"
        }
        $removeIdentity = Get-ExchangeStrongCommandIdentity $reread
        if (-not $removeIdentity) { throw "Managed contact recreation was blocked because the invalid object's immutable identity could not be verified. Original error: $updateError" }
        Remove-MailContact -Identity $removeIdentity -Confirm:$false -ErrorAction Stop
        Renew-ExchangeSyncLockIfDue
      }
      Write-Warning ("Existing managed Exchange contact {0} is absent or narrowly confirmed invalid; recreating it. Original error: {1}" -f $email, $updateError)
      $newContact = New-MailContact -Name (Get-ExchangeContactDirectoryName $Contact) -DisplayName $Contact.DisplayName -ExternalEmailAddress $email -Alias $Contact.Alias -ErrorAction Stop
      Renew-ExchangeSyncLockIfDue
      $identity = Get-ExchangeStrongCommandIdentity $newContact
      if (-not $identity) { throw "Recreated Exchange contact $email did not return an immutable identity, so profile/marker mutation was blocked." }
      Set-MailContact -Identity $identity -CustomAttribute1 $ManagedMarker -CustomAttribute2 $sourceKey -HiddenFromAddressListsEnabled $false -ErrorAction Stop
      Renew-ExchangeSyncLockIfDue
      $recreatedContact = Get-ManagedExchangeMailContactBySourceKey $sourceKey $email "Recreated Exchange contact $email" 4
      $recreatedProfile = Resolve-ExchangeContactProfileForMailContact $recreatedContact "Recreated Exchange contact $email" 4
      Set-ExchangeContactProfile (Get-ExchangeContactProfileCommandIdentity $recreatedProfile) $Contact
      $fullMutationAction = "Recreate contact"
    }
    Increment-Stat $Stats "updatedContacts"
  } else {
    $fullMutationAction = "Create contact"
    Renew-ExchangeSyncLockIfDue
    $newContact = New-MailContact -Name (Get-ExchangeContactDirectoryName $Contact) -DisplayName $Contact.DisplayName -ExternalEmailAddress $email -Alias $Contact.Alias -ErrorAction Stop
    Renew-ExchangeSyncLockIfDue
    $contactIdentity = Get-ExchangeStrongCommandIdentity $newContact
    if (-not $contactIdentity) { throw "New Exchange contact $email did not return an immutable identity, so profile/marker mutation was blocked." }
    Set-MailContact -Identity $contactIdentity -CustomAttribute1 $ManagedMarker -CustomAttribute2 $sourceKey -HiddenFromAddressListsEnabled $false -ErrorAction Stop
    Renew-ExchangeSyncLockIfDue
    $createdContact = Get-ManagedExchangeMailContactBySourceKey $sourceKey $email "New Exchange contact $email" 4
    $createdProfile = Resolve-ExchangeContactProfileForMailContact $createdContact "New Exchange contact $email" 4
    Set-ExchangeContactProfile (Get-ExchangeContactProfileCommandIdentity $createdProfile) $Contact
    Increment-Stat $Stats "createdContacts"
  }

  $verified = $null
  $verifiedProfile = $null
  $verificationMismatches = @("mail contact is missing")
  for ($attempt = 1; $attempt -le 4; $attempt += 1) {
    if ($attempt -gt 1) { Start-Sleep -Seconds 2 }
    Renew-ExchangeSyncLockIfDue
    $verifiedMatches = @(Get-MailContact -Filter "CustomAttribute2 -eq '$escapedSourceKey'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
    Renew-ExchangeSyncLockIfDue
    if ($verifiedMatches.Count -gt 1) { throw "Exchange contact $email final verification found $($verifiedMatches.Count) objects with source key $sourceKey." }
    if ($verifiedMatches.Count -eq 0) {
      $verified = $null
      $verifiedProfile = $null
      $verificationMismatches = @("mail contact is missing")
      continue
    }

    $verified = $verifiedMatches[0]
    $verifiedProfile = $null
    try {
      $verifiedProfile = Resolve-ExchangeContactProfileForMailContact $verified "Exchange contact $email after upsert" 1
    } catch {
      if ($_.Exception.Message -notmatch "profile resolution failed after 1 attempt") { throw }
    }
    $verificationMismatches = @(Get-ExchangeMailContactMismatches $verified $Contact $verifiedProfile)
    if ($verificationMismatches.Count -eq 0) { break }
  }
  if (-not $verified -or -not $verifiedProfile -or $verificationMismatches.Count -gt 0) {
    throw "Exchange contact $email differs after bounded verification for: $($verificationMismatches -join ', ')."
  }
  Get-ExchangeContactProfileCommandIdentity $verifiedProfile | Out-Null
  if ($SkipNoOpWrites -and $fullMutationAction) {
    $created = $fullMutationAction -eq "Create contact"
    Add-FullSyncMutationDetail `
      $Stats `
      $fullMutationAction `
      "Contact" `
      $Contact.DisplayName `
      $email `
      $sourceKey `
      $(if (Get-ExchangeStrongCommandIdentity $verified) { Get-ExchangeStrongCommandIdentity $verified } else { Clean-Text $verified.Identity }) `
      "$fullMutationAction completed and the final Exchange contact/profile was verified." `
      (Get-FullContactMutationFieldChanges $existingBeforeMutation $profileBeforeMutation $Contact $created)
  }
  Increment-Stat $Stats "verifiedQueueRows"
}

function Confirm-ExchangeMailContactDeletion($Existing, $Email, $SourceKey) {
  $email = Normalize-Email $Email
  $sourceKey = Clean-Text $SourceKey
  $deleteIdentity = Get-ExchangeStrongCommandIdentity $Existing
  if (-not $deleteIdentity) { throw "The deleted Exchange contact had no immutable identity for verification." }
  $deletionVerified = $false
  $verificationFailure = "the exact immutable Exchange contact still exists"
  for ($attempt = 1; $attempt -le 4; $attempt += 1) {
    if ($attempt -gt 1) { Start-Sleep -Seconds 2 }
    Renew-ExchangeSyncLockIfDue
    $verifiedByIdentity = $null
    try {
      $verifiedByIdentity = Get-MailContact -Identity $deleteIdentity -ErrorAction Stop
    } catch {
      if (-not (Test-ExchangeIdentityNotFoundError $_)) { throw }
    }
    $verifiedBySource = @()
    if ($sourceKey) {
      $verifiedBySource = @(Get-MailContact -Filter "CustomAttribute2 -eq '$(Escape-ExchangeFilterValue $sourceKey)'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
    }
    $verifiedByEmail = @()
    if ($email) {
      $verifiedByEmail = @(Get-MailContact -Filter "ExternalEmailAddress -eq '$(Escape-ExchangeFilterValue $email)'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
    }
    Renew-ExchangeSyncLockIfDue
    $exactObjectStillExists = $verifiedByIdentity -and (Test-ExchangeObjectsShareImmutableIdentity $Existing $verifiedByIdentity)
    if (-not $exactObjectStillExists) {
      $exactObjectStillExists = @($verifiedByEmail | Where-Object { Test-ExchangeObjectsShareImmutableIdentity $Existing $_ }).Count -gt 0
    }
    if ($exactObjectStillExists) {
      $verificationFailure = "the exact immutable Exchange contact still exists"
      continue
    }
    if ($verifiedBySource.Count -gt 0) {
      $verificationFailure = "source key $sourceKey is still present"
      continue
    }
    $unsafeEmailSurvivors = @($verifiedByEmail | Where-Object {
      $survivorOwner = Clean-Text $_.CustomAttribute2
      -not $survivorOwner -or ($sourceKey -and $survivorOwner -eq $sourceKey)
    })
    if ($unsafeEmailSurvivors.Count -gt 0) {
      $verificationFailure = "the same email remains on a contact without a demonstrably different non-empty source owner"
      continue
    }
    $deletionVerified = $true
    break
  }
  if (-not $deletionVerified) { throw "Could not verify deletion of Exchange contact $email because $verificationFailure." }
}

function Remove-ManagedExchangeMailContact($Email, $Alias, [hashtable]$Stats, $SourceContactId = "", $ExpectedDisplayName = "", [bool]$AllowUntaggedExactDelete = $false) {
  Renew-ExchangeSyncLockIfDue
  $email = Normalize-Email $Email
  $aliasText = Clean-Text $Alias
  $existing = $null
  $sourceKey = Get-ContactSourceKey $SourceContactId
  if ($sourceKey) {
    $escapedSourceKey = Escape-ExchangeFilterValue $sourceKey
    $matches = @(Get-MailContact -Filter "CustomAttribute2 -eq '$escapedSourceKey'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
    if ($matches.Count -gt 1) { throw "More than one Exchange contact is tagged with source key $sourceKey." }
    if ($matches.Count -eq 1) { $existing = $matches[0] }
  }
  if ($email) {
    $escapedEmail = Escape-ExchangeFilterValue $email
    $emailMatches = @(Get-MailContact -Filter "ExternalEmailAddress -eq '$escapedEmail'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
    if ($emailMatches.Count -gt 1) { throw "More than one Exchange contact uses $email." }
    if (-not $existing -and $emailMatches.Count -eq 1) { $existing = $emailMatches[0] }
  }
  if (-not $existing -and -not $email -and $aliasText) {
    try {
      $existing = Get-MailContact -Identity $aliasText -ErrorAction Stop
    } catch {
      if (-not (Test-ExchangeIdentityNotFoundError $_)) { throw }
    }
  }
  Renew-ExchangeSyncLockIfDue
  if (-not $existing) {
    Increment-Stat $Stats "verifiedQueueRows"
    return
  }
  $existingOwnerKey = Clean-Text $existing.CustomAttribute2
  if ($sourceKey -and $existingOwnerKey -and $existingOwnerKey -ne $sourceKey) {
    throw "Exchange contact $($existing.DisplayName) is owned by source key $existingOwnerKey, not $sourceKey, so it was not deleted."
  }
  $actualName = Clean-Text $existing.DisplayName
  $expectedName = Clean-Text $ExpectedDisplayName
  $actualEmail = Normalize-Email (Get-RecipientEmail $existing)
  if (-not $sourceKey) {
    $exactMatch = $AllowUntaggedExactDelete -and $email -and $actualEmail -eq $email -and $expectedName -and $actualName -eq $expectedName
    if (-not $exactMatch) {
      throw "Exchange contact $($existing.DisplayName) was not deleted because the queue does not authorize that exact email and display name."
    }
  } elseif ((Clean-Text $existing.CustomAttribute1) -ne $ManagedMarker) {
    $exactMatch = $AllowUntaggedExactDelete -and $email -and $actualEmail -eq $email -and $expectedName -and $actualName -eq $expectedName
    if (-not $exactMatch) {
      throw "Exchange contact $($existing.DisplayName) was not deleted because it is not tagged with $ManagedMarker and the queue does not authorize an exact legacy deletion."
    }
  }

  $deleteIdentity = Get-ExchangeStrongCommandIdentity $existing
  if (-not $deleteIdentity) {
    throw "Exchange contact $($existing.DisplayName) was not deleted because its immutable Exchange identity could not be resolved for exact verification."
  }

  Renew-ExchangeSyncLockIfDue
  Remove-MailContact -Identity $deleteIdentity -Confirm:$false -ErrorAction Stop
  Renew-ExchangeSyncLockIfDue
  Confirm-ExchangeMailContactDeletion $existing $email $sourceKey
  Increment-Stat $Stats "removedContacts"
  Increment-Stat $Stats "verifiedQueueRows"
}

function Upsert-ExchangeDistributionGroup($Group, [hashtable]$Stats, [bool]$SkipNoOpWrites = $false, $ExistingHint = $null, [bool]$UseExistingHint = $false, $ExistingProfileHint = $null) {
  Renew-ExchangeSyncLockIfDue
  $alias = Clean-Text $Group.Alias
  if (-not $alias) {
    Increment-Stat $Stats "skippedQueueRows"
    return
  }

  $sourceKey = Clean-Text $Group.SourceKey
  $escapedSourceKey = Escape-ExchangeFilterValue $sourceKey
  $existing = $null
  if ($UseExistingHint) {
    $existing = $ExistingHint
  } else {
    $sourceMatches = @()
    if ($sourceKey) {
      $sourceMatches = @(Get-DistributionGroup -Filter "CustomAttribute2 -eq '$escapedSourceKey'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
      if ($sourceMatches.Count -gt 1) { throw "More than one Exchange group is tagged with source key $sourceKey." }
    }
    $existing = if ($sourceMatches.Count -eq 1) { $sourceMatches[0] } else { $null }
    if (-not $existing) {
      try {
        $existing = Get-DistributionGroup -Identity $alias -ErrorAction Stop
      } catch {
        if (-not (Test-ExchangeIdentityNotFoundError $_)) { throw }
      }
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
  }
  Renew-ExchangeSyncLockIfDue
  if ($existing -and $SkipNoOpWrites -and -not $ExistingProfileHint) {
    $profileIdentity = Get-ExchangeStrongCommandIdentity $existing
    if (-not $profileIdentity) { $profileIdentity = Clean-Text $existing.Identity }
    if ($profileIdentity) {
      $ExistingProfileHint = Get-Group -Identity $profileIdentity -ErrorAction Stop
      Renew-ExchangeSyncLockIfDue
    }
  }
  $existingBeforeMutation = $existing
  $profileBeforeMutation = $ExistingProfileHint
  $fullMutationAction = ""
  if ($existing -and $SkipNoOpWrites -and (Test-ExchangeDistributionGroupMatches $existing $Group $ExistingProfileHint)) {
    Increment-Stat $Stats "verifiedQueueRows"
    return
  } elseif ($existing) {
    $fullMutationAction = "Update group"
    $groupIdentity = Get-ExchangeStrongCommandIdentity $existing
    if (-not $groupIdentity) { throw "Existing Exchange group $alias has no immutable identity, so the update was blocked without mutation." }
    Set-DistributionGroup -Identity $groupIdentity -Alias $alias -Name $Group.GroupName -DisplayName $Group.GroupName -CustomAttribute1 $ManagedMarker -CustomAttribute2 $sourceKey -HiddenFromAddressListsEnabled $false -ErrorAction Stop
    Renew-ExchangeSyncLockIfDue
    Set-Group -Identity $groupIdentity -Notes $Group.Description -ErrorAction Stop
    Renew-ExchangeSyncLockIfDue
    Increment-Stat $Stats "updatedGroups"
  } else {
    $fullMutationAction = "Create group"
    $newGroup = New-DistributionGroup -Name $Group.GroupName -Alias $alias -ErrorAction Stop
    Renew-ExchangeSyncLockIfDue
    $newGroupIdentity = Get-ExchangeStrongCommandIdentity $newGroup
    if (-not $newGroupIdentity) { throw "New Exchange group $alias did not return an immutable identity, so Notes/marker mutation was blocked." }
    Set-DistributionGroup -Identity $newGroupIdentity -CustomAttribute1 $ManagedMarker -CustomAttribute2 $sourceKey -HiddenFromAddressListsEnabled $false -ErrorAction Stop
    Renew-ExchangeSyncLockIfDue
    Set-Group -Identity $newGroupIdentity -Notes $Group.Description -ErrorAction Stop
    Renew-ExchangeSyncLockIfDue
    Increment-Stat $Stats "createdGroups"
  }

  $verified = $null
  $verifiedProfile = $null
  $verificationMismatches = @("distribution group is missing")
  for ($attempt = 1; $attempt -le 4; $attempt += 1) {
    if ($attempt -gt 1) { Start-Sleep -Seconds 2 }
    Renew-ExchangeSyncLockIfDue
    $verifiedMatches = @(Get-DistributionGroup -Filter "CustomAttribute2 -eq '$escapedSourceKey'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
    Renew-ExchangeSyncLockIfDue
    if ($verifiedMatches.Count -ne 1) {
      $verified = $null
      $verifiedProfile = $null
      $verificationMismatches = @("expected one source-key group; found $($verifiedMatches.Count)")
      continue
    }
    $verified = $verifiedMatches[0]
    $verifiedIdentity = $(if (Clean-Text $verified.Guid) { Clean-Text $verified.Guid } else { $verified.Identity })
    $verifiedProfile = Get-Group -Identity $verifiedIdentity -ErrorAction Stop
    Renew-ExchangeSyncLockIfDue
    $verificationMismatches = @(Get-ExchangeDistributionGroupMismatches $verified $Group $verifiedProfile)
    if ($verificationMismatches.Count -eq 0) { break }
  }
  if (-not $verified -or $verificationMismatches.Count -gt 0) {
    throw "Exchange group $($Group.GroupName) differs after bounded verification for: $($verificationMismatches -join ', ')."
  }
  if ($SkipNoOpWrites -and $fullMutationAction) {
    $created = $fullMutationAction -eq "Create group"
    Add-FullSyncMutationDetail `
      $Stats `
      $fullMutationAction `
      "Group" `
      $Group.GroupName `
      $alias `
      $sourceKey `
      $(if (Get-ExchangeStrongCommandIdentity $verified) { Get-ExchangeStrongCommandIdentity $verified } else { Clean-Text $verified.Identity }) `
      "$fullMutationAction completed and the final Exchange group metadata/Notes were verified." `
      (Get-FullGroupMutationFieldChanges $existingBeforeMutation $profileBeforeMutation $Group $created)
  }
  Increment-Stat $Stats "verifiedQueueRows"
}

function Confirm-ExchangeDistributionGroupDeletion($Existing, $Alias, $SourceKey) {
  $aliasText = Clean-Text $Alias
  $sourceKey = Clean-Text $SourceKey
  $deleteIdentity = Get-ExchangeStrongCommandIdentity $Existing
  if (-not $deleteIdentity) { throw "The deleted Exchange group had no immutable identity for verification." }
  $deletionVerified = $false
  $verificationFailure = "the exact immutable Exchange group still exists"
  for ($attempt = 1; $attempt -le 4; $attempt += 1) {
    if ($attempt -gt 1) { Start-Sleep -Seconds 2 }
    Renew-ExchangeSyncLockIfDue
    $verifiedByIdentity = $null
    try {
      $verifiedByIdentity = Get-DistributionGroup -Identity $deleteIdentity -ErrorAction Stop
    } catch {
      if (-not (Test-ExchangeIdentityNotFoundError $_)) { throw }
    }
    $verifiedByAlias = $null
    if ($aliasText) {
      try {
        $verifiedByAlias = Get-DistributionGroup -Identity $aliasText -ErrorAction Stop
      } catch {
        if (-not (Test-ExchangeIdentityNotFoundError $_)) { throw }
      }
    }
    $verifiedBySource = @()
    if ($sourceKey) {
      $verifiedBySource = @(Get-DistributionGroup -Filter "CustomAttribute2 -eq '$(Escape-ExchangeFilterValue $sourceKey)'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
    }
    Renew-ExchangeSyncLockIfDue
    if ($verifiedByIdentity -and (Test-ExchangeObjectsShareImmutableIdentity $Existing $verifiedByIdentity)) {
      $verificationFailure = "the exact immutable Exchange group still exists"
      continue
    }
    if ($verifiedByAlias) {
      $aliasOwner = Clean-Text $verifiedByAlias.CustomAttribute2
      $aliasIsDeletedObject = Test-ExchangeObjectsShareImmutableIdentity $Existing $verifiedByAlias
      if ($aliasIsDeletedObject -or -not $aliasOwner -or ($sourceKey -and $aliasOwner -eq $sourceKey)) {
        $verificationFailure = "alias $aliasText is still present without a demonstrably different non-empty source owner"
        continue
      }
    }
    if ($verifiedBySource.Count -gt 0) {
      $verificationFailure = "source key $sourceKey is still present"
      continue
    }
    $deletionVerified = $true
    break
  }
  if (-not $deletionVerified) { throw "Could not verify deletion of Exchange group $aliasText because $verificationFailure." }
}

function Remove-ManagedExchangeDistributionGroup($Alias, [hashtable]$Stats, $SourceGroupId = "", $ExpectedDisplayName = "", [bool]$AllowUntaggedExactDelete = $false) {
  Renew-ExchangeSyncLockIfDue
  $aliasText = Clean-Text $Alias
  $sourceKey = Get-GroupSourceKey $SourceGroupId
  if (-not $aliasText -and -not $sourceKey) {
    Increment-Stat $Stats "skippedQueueRows"
    return
  }

  $existing = $null
  if ($sourceKey) {
    $matches = @(Get-DistributionGroup -Filter "CustomAttribute2 -eq '$(Escape-ExchangeFilterValue $sourceKey)'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
    if ($matches.Count -gt 1) { throw "More than one Exchange group is tagged with source key $sourceKey." }
    if ($matches.Count -eq 1) { $existing = $matches[0] }
  }
  if (-not $existing -and $aliasText) {
    try {
      $existing = Get-DistributionGroup -Identity $aliasText -ErrorAction Stop
    } catch {
      if (-not (Test-ExchangeIdentityNotFoundError $_)) { throw }
    }
  }
  Renew-ExchangeSyncLockIfDue
  if (-not $existing) {
    Increment-Stat $Stats "verifiedQueueRows"
    return
  }
  $existingOwnerKey = Clean-Text $existing.CustomAttribute2
  $existingIsManaged = (Clean-Text $existing.CustomAttribute1) -eq $ManagedMarker
  if ($sourceKey -and $existingOwnerKey -and $existingOwnerKey -ne $sourceKey) {
    throw "Exchange group $($existing.DisplayName) is owned by source key $existingOwnerKey, not $sourceKey, so it was not deleted."
  }
  if (-not $sourceKey -or -not $existingIsManaged -or -not $existingOwnerKey) {
    $exactMatch = $AllowUntaggedExactDelete -and $aliasText -and (Clean-Text $existing.Alias).ToLowerInvariant() -eq $aliasText.ToLowerInvariant() -and (Clean-Text $ExpectedDisplayName) -and (Clean-Text $existing.DisplayName) -eq (Clean-Text $ExpectedDisplayName)
    if (-not $exactMatch) {
      throw "Exchange group $($existing.DisplayName) was not deleted because the queue does not authorize that exact legacy alias and display name."
    }
  }

  $deleteIdentity = Get-ExchangeStrongCommandIdentity $existing
  if (-not $deleteIdentity) {
    throw "Exchange group $($existing.DisplayName) was not deleted because its immutable Exchange identity could not be resolved for exact verification."
  }

  Renew-ExchangeSyncLockIfDue
  Remove-DistributionGroup -Identity $deleteIdentity -Confirm:$false -ErrorAction Stop
  Renew-ExchangeSyncLockIfDue
  Confirm-ExchangeDistributionGroupDeletion $existing $aliasText $sourceKey
  Increment-Stat $Stats "removedGroups"
  Increment-Stat $Stats "verifiedQueueRows"
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

function Sync-ExchangeGroupMembers($Group, $Members, [hashtable]$Stats, [bool]$SkipNoOpWrites = $false, $ExistingGroupHint = $null, [bool]$UseExistingGroupHint = $false, $ExistingGroupProfileHint = $null) {
  Renew-ExchangeSyncLockIfDue
  $pendingFullMembershipDetails = @()
  Upsert-ExchangeDistributionGroup $Group $Stats $SkipNoOpWrites $ExistingGroupHint $UseExistingGroupHint $ExistingGroupProfileHint
  Renew-ExchangeSyncLockIfDue

  $groupSourceKey = Clean-Text $Group.SourceKey
  if (-not $groupSourceKey) { throw "Exchange group membership mutation was blocked because the FCUNO group source key is missing." }
  $resolvedGroups = @(Get-DistributionGroup -Filter "CustomAttribute2 -eq '$(Escape-ExchangeFilterValue $groupSourceKey)'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
  Renew-ExchangeSyncLockIfDue
  if ($resolvedGroups.Count -ne 1) {
    throw "Exchange group membership mutation was blocked because source key $groupSourceKey resolved to $($resolvedGroups.Count) groups after upsert."
  }
  $resolvedGroup = $resolvedGroups[0]
  $groupIdentity = Get-ExchangeStrongCommandIdentity $resolvedGroup
  if (-not $groupIdentity) {
    throw "Exchange group membership mutation was blocked because source key $groupSourceKey has no immutable Exchange identity."
  }

  $desiredMembers = @{}
  foreach ($member in @($Members)) {
    $email = Normalize-Email $member.MemberEmail
    if ($email) { $desiredMembers[$email] = $true }
  }

  $currentMembers = @()
  $currentMembershipState = @{ EmailCounts = @{}; UnresolvedMembers = @() }
  if ($SkipNoOpWrites) {
    Renew-ExchangeSyncLockIfDue
    $currentMembers = @(Get-DistributionGroupMember -Identity $groupIdentity -ResultSize Unlimited -ErrorAction Stop)
    Renew-ExchangeSyncLockIfDue
    $currentMembershipState = Get-ExchangeGroupMembershipState $currentMembers
    $initialMissingEmails = @($desiredMembers.Keys | Where-Object { -not (Has-MapKey $currentMembershipState.EmailCounts $_) })
    $initialUnexpectedEmails = @($currentMembershipState.EmailCounts.Keys | Where-Object { -not (Has-MapKey $desiredMembers $_) })
    $initialDuplicateEmails = @($currentMembershipState.EmailCounts.Keys | Where-Object { [int]$currentMembershipState.EmailCounts[$_] -gt 1 })
    if ($initialMissingEmails.Count -le 0 -and $initialUnexpectedEmails.Count -le 0 -and $initialDuplicateEmails.Count -le 0 -and @($currentMembershipState.UnresolvedMembers).Count -le 0) {
      return
    }
  }

  foreach ($email in $desiredMembers.Keys) {
    if ($SkipNoOpWrites -and (Has-MapKey $currentMembershipState.EmailCounts $email)) { continue }
    try {
      Renew-ExchangeSyncLockIfDue
      Add-DistributionGroupMember -Identity $groupIdentity -Member $email -ErrorAction Stop
      Renew-ExchangeSyncLockIfDue
      Increment-Stat $Stats "addedMembers"
      $Stats["addedMemberEmails"] = @($Stats["addedMemberEmails"]) + $email
      if ($SkipNoOpWrites) {
        $detailStats = @{ changeDetails = @() }
        Add-FullSyncMutationDetail `
          $detailStats `
          "Add group member" `
          "Group membership" `
          $Group.GroupName `
          "$($Group.Alias) / $email" `
          "$(Clean-Text $Group.SourceKey):$email" `
          $groupIdentity `
          "Added $email to the Exchange group; final membership certification follows." `
          @("Member: (absent) -> $email")
        $pendingFullMembershipDetails += @($detailStats.changeDetails)
      }
    } catch {
      if ($_.Exception.Message -notmatch "already a member") {
        throw ("Could not add {0} to {1}: {2}" -f $email, $Group.GroupName, $_.Exception.Message)
      }
    } finally {
      Renew-ExchangeSyncLockIfDue
    }
  }

  if (-not $SkipNoOpWrites) {
    Renew-ExchangeSyncLockIfDue
    $currentMembers = @(Get-DistributionGroupMember -Identity $groupIdentity -ResultSize Unlimited -ErrorAction Stop)
    Renew-ExchangeSyncLockIfDue
    $currentMembershipState = Get-ExchangeGroupMembershipState $currentMembers
  }
  foreach ($currentMember in $currentMembers) {
    $currentEmail = Get-RecipientEmail $currentMember
    if ($currentEmail -and -not (Has-MapKey $desiredMembers $currentEmail)) {
      $currentIdentity = Get-ExchangeStrongCommandIdentity $currentMember
      if (-not $currentIdentity) {
        $emailCount = if (Has-MapKey $currentMembershipState.EmailCounts $currentEmail) { [int]$currentMembershipState.EmailCounts[$currentEmail] } else { 0 }
        if (-not (Test-ValidEmail $currentEmail) -or $emailCount -ne 1) {
          throw "Could not remove unexpected member $currentEmail from $($Group.GroupName) because its immutable or unique SMTP identity could not be proven from the current membership snapshot."
        }
        $currentIdentity = $currentEmail
      }
      Renew-ExchangeSyncLockIfDue
      Remove-DistributionGroupMember -Identity $groupIdentity -Member $currentIdentity -Confirm:$false -ErrorAction Stop
      Renew-ExchangeSyncLockIfDue
      Increment-Stat $Stats "removedMembers"
      $Stats["removedMemberEmails"] = @($Stats["removedMemberEmails"]) + $currentEmail
      if ($SkipNoOpWrites) {
        $detailStats = @{ changeDetails = @() }
        Add-FullSyncMutationDetail `
          $detailStats `
          "Remove group member" `
          "Group membership" `
          $Group.GroupName `
          "$($Group.Alias) / $currentEmail" `
          "$(Clean-Text $Group.SourceKey):$currentEmail" `
          $groupIdentity `
          "Removed $currentEmail from the Exchange group; final membership certification follows." `
          @("Member: $currentEmail -> (absent)")
        $pendingFullMembershipDetails += @($detailStats.changeDetails)
      }
    }
  }

  $missingEmails = @()
  $unexpectedEmails = @()
  $duplicateEmails = @()
  $unresolvedMembers = @()
  $membershipVerified = $false
  $verificationReadError = ""
  try {
    for ($verificationAttempt = 1; $verificationAttempt -le 4; $verificationAttempt += 1) {
      if ($verificationAttempt -gt 1) { Start-Sleep -Seconds 2 }
      Renew-ExchangeSyncLockIfDue
      $verifiedMembers = @(Get-DistributionGroupMember -Identity $groupIdentity -ResultSize Unlimited -ErrorAction Stop)
      Renew-ExchangeSyncLockIfDue
      $verifiedState = Get-ExchangeGroupMembershipState $verifiedMembers
      $missingEmails = @($desiredMembers.Keys | Where-Object { -not (Has-MapKey $verifiedState.EmailCounts $_) } | Sort-Object)
      $unexpectedEmails = @($verifiedState.EmailCounts.Keys | Where-Object { -not (Has-MapKey $desiredMembers $_) } | Sort-Object)
      $duplicateEmails = @($verifiedState.EmailCounts.Keys | Where-Object { [int]$verifiedState.EmailCounts[$_] -gt 1 } | Sort-Object)
      $unresolvedMembers = @($verifiedState.UnresolvedMembers | Sort-Object)
      if ($missingEmails.Count -le 0 -and $unexpectedEmails.Count -le 0 -and $duplicateEmails.Count -le 0 -and $unresolvedMembers.Count -le 0) {
        $membershipVerified = $true
        break
      }
    }
  } catch {
    $verificationReadError = Clean-Text $_.Exception.Message
  }
  if (-not $membershipVerified) {
    $verificationParts = @()
    if ($verificationReadError) { $verificationParts += "verification read failed: $verificationReadError" }
    if ($missingEmails.Count -gt 0) { $verificationParts += "missing after verification retries: $($missingEmails -join ', ')" }
    if ($unexpectedEmails.Count -gt 0) { $verificationParts += "unexpected after verification retries: $($unexpectedEmails -join ', ')" }
    if ($duplicateEmails.Count -gt 0) { $verificationParts += "duplicate resolved emails after verification retries: $($duplicateEmails -join ', ')" }
    if ($unresolvedMembers.Count -gt 0) { $verificationParts += "unresolved member identities after verification retries: $($unresolvedMembers -join ', ')" }
    $verificationMessage = "Exchange group membership verification failed for $($Group.GroupName) ($($verificationParts -join '; '))."
    Publish-FullSyncMutationDetails $Stats $pendingFullMembershipDetails $false $verificationMessage
    throw $verificationMessage
  }
  Publish-FullSyncMutationDetails $Stats $pendingFullMembershipDetails $true
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
    Renew-ExchangeSyncLockIfDue
    Sync-ExchangeGroupState $groupId "" $Stats
    Renew-ExchangeSyncLockIfDue
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

function Copy-ExchangeContactWithAllowedOwnerSourceKey($Contact, $AdditionalSourceKey) {
  if (-not $Contact) { return $null }
  $clone = [pscustomobject]@{}
  foreach ($property in @($Contact.PSObject.Properties)) {
    $clone | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
  }
  $allowedOwnerSourceKeys = @($Contact.AllowedOwnerSourceKeys | ForEach-Object { Clean-Text $_ } | Where-Object { $_ })
  $additionalKey = Clean-Text $AdditionalSourceKey
  if ($additionalKey -and $allowedOwnerSourceKeys -notcontains $additionalKey) {
    $allowedOwnerSourceKeys += $additionalKey
  }
  $clone | Add-Member -NotePropertyName AllowedOwnerSourceKeys -NotePropertyValue @($allowedOwnerSourceKeys | Select-Object -Unique) -Force
  return $clone
}

function Reconcile-ExchangeContactEmail($Email, $Row, [hashtable]$Stats, [bool]$UseQueuedSourceKeyForDelete, [bool]$AllowQueuedHistoricalOwner = $false) {
  $email = Normalize-Email $Email
  if (-not $email) { return }
  $rows = Get-CanonicalExchangeRows
  $desiredContact = if (Has-MapKey $rows.ContactByEmail $email) { $rows.ContactByEmail[$email] } else { $null }
  if ($desiredContact -and -not (Is-InternalContact $desiredContact $email)) {
    $contactForUpsert = $desiredContact
    if ($AllowQueuedHistoricalOwner -and (Get-QueueAuditAuthorized $Row)) {
      $contactForUpsert = Copy-ExchangeContactWithAllowedOwnerSourceKey $desiredContact (Get-ContactSourceKey $Row.entity_id)
    }
    Upsert-ExchangeMailContact $contactForUpsert $Stats
    return
  }
  if ($desiredContact -and (Is-InternalContact $desiredContact $email)) {
    Remove-ManagedExchangeMailContact `
      $email `
      (Clean-Text $desiredContact.Alias) `
      $Stats `
      (Clean-Text $desiredContact.SourceContactId) `
      (Clean-Text $desiredContact.DisplayName) `
      $false
    return
  }

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
  $beforeDisplayName = Get-QueueExpectedContactName $Row
  $currentDisplayName = if ($sourceContact) { Clean-Text $sourceContact.display_name } else { "" }
  $currentSourceKey = Get-ContactSourceKey $Row.entity_id
  $beforeBaseAlias = Get-QueueContactBeforeBaseAlias $Row
  $currentDependencyRow = $null
  if ($sourceContact) {
    $canonicalRows = Get-CanonicalExchangeRows
    if (Has-MapKey $canonicalRows.ContactById (Clean-Text $Row.entity_id)) {
      $currentDependencyRow = $canonicalRows.ContactById[(Clean-Text $Row.entity_id)]
    }
  }
  $currentIsInternal = $currentDependencyRow -and (Is-InternalContact $currentDependencyRow $currentDependencyRow.ExternalEmailAddress)
  $currentRow = if ($currentDependencyRow -and -not $currentIsInternal) { $currentDependencyRow } else { $null }
  $currentBaseAlias = if ($currentDependencyRow) { Clean-Text $currentDependencyRow.BaseAlias } else { "" }
  $beforeEmailReconciled = $false

  if ($beforeEmail -and $beforeEmail -ne $currentEmail) {
    Reconcile-ExchangeContactEmail $beforeEmail $Row $Stats (-not $sourceContact) (Get-QueueAuditAuthorized $Row)
    $beforeEmailReconciled = $true
  }
  if ($currentBaseAlias) { Sync-ExchangeAliasPeers $currentBaseAlias $Stats ([bool]$currentIsInternal) ([bool]$currentIsInternal) }
  if ($currentDisplayName) {
    Sync-ExchangeDirectoryNamePeers $currentDisplayName $Stats $currentSourceKey $false
  }
  if ($beforeDisplayName -and (
    -not $currentRow -or
    -not $beforeDisplayName.Equals($currentDisplayName, [StringComparison]::OrdinalIgnoreCase)
  )) {
    Sync-ExchangeDirectoryNamePeers $beforeDisplayName $Stats $currentSourceKey $true
  }
  if ($currentEmail) {
    Reconcile-ExchangeContactEmail $currentEmail $Row $Stats $false $false
  } elseif ($beforeEmail -and -not $beforeEmailReconciled) {
    Reconcile-ExchangeContactEmail $beforeEmail $Row $Stats $true (Get-QueueAuditAuthorized $Row)
  }

  foreach ($email in @($beforeEmail, $currentEmail) | Where-Object { $_ } | Select-Object -Unique) {
    Sync-ExchangeGroupsForEmail $email $Stats
  }
  if ($beforeBaseAlias -and -not $beforeBaseAlias.Equals($currentBaseAlias, [StringComparison]::OrdinalIgnoreCase)) {
    Sync-ExchangeAliasPeers $beforeBaseAlias $Stats $true $true
  }
}

function Get-QueueGroupBeforeBaseAlias($Row) {
  $seed = Get-QueuePayloadValue $Row "beforeGroup" "nickname"
  if (-not $seed) { $seed = Get-QueuePayloadValue $Row "beforeGroup" "name" }
  if (-not $seed) { return Clean-Text $Row.entity_alias }
  return Get-ExchangeAlias $seed ("group-" + (Clean-Text $Row.entity_id))
}

function Get-CanonicalExchangeGroupByAlias($Alias) {
  $aliasText = Clean-Text $Alias
  if (-not $aliasText) { return $null }
  $matches = @((Get-CanonicalExchangeRows).Groups | Where-Object {
    (Clean-Text $_.Alias).Equals($aliasText, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($matches.Count -gt 1) { throw "More than one canonical FCUNO group uses Exchange alias $aliasText." }
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}

function Sync-ExchangeGroupQueueState($Row, [hashtable]$Stats) {
  $sourceGroup = Load-SingleRow "shared_addressbook_groups" "id" $Row.entity_id
  $beforeBaseAlias = Get-QueueGroupBeforeBaseAlias $Row
  $currentRows = if ($sourceGroup) { Get-GroupExchangeRowsFromSource $Row.entity_id } else { $null }
  $currentGroup = if ($currentRows -and @($currentRows.Groups).Count -gt 0) { @($currentRows.Groups)[0] } else { $null }
  $currentBaseAlias = if ($currentGroup) { Clean-Text $currentGroup.BaseAlias } else { "" }

  if (-not $sourceGroup) {
    $queuedAlias = Clean-Text $Row.entity_alias
    $currentAliasOwner = Get-CanonicalExchangeGroupByAlias $queuedAlias
    if ($currentAliasOwner -and (Clean-Text $currentAliasOwner.SourceGroupId) -ne (Clean-Text $Row.entity_id)) {
      $existingAliasOwner = $null
      try {
        $existingAliasOwner = Get-DistributionGroup -Identity $queuedAlias -ErrorAction Stop
      } catch {
        if (-not (Test-ExchangeIdentityNotFoundError $_)) { throw }
      }
      $currentOwnerKey = Clean-Text $currentAliasOwner.SourceKey
      $existingOwnerKey = if ($existingAliasOwner) { Clean-Text $existingAliasOwner.CustomAttribute2 } else { "" }
      $existingIsCurrentOwner = $existingAliasOwner -and (
        ($existingOwnerKey -and $existingOwnerKey -eq $currentOwnerKey) -or
        (-not $existingOwnerKey -and (Clean-Text $existingAliasOwner.DisplayName) -eq (Clean-Text $currentAliasOwner.GroupName))
      )
      $oldSourceKey = Get-GroupSourceKey $Row.entity_id
      $oldSourceMatches = @()
      if ($oldSourceKey) {
        $oldSourceMatches = @(Get-DistributionGroup -Filter "CustomAttribute2 -eq '$(Escape-ExchangeFilterValue $oldSourceKey)'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
        if ($oldSourceMatches.Count -gt 1) { throw "More than one Exchange group is tagged with obsolete source key $oldSourceKey." }
      }
      if ($oldSourceMatches.Count -eq 1 -or -not $existingIsCurrentOwner) {
        Remove-ManagedExchangeDistributionGroup `
          $queuedAlias `
          $Stats `
          $Row.entity_id `
          (Get-QueueExpectedGroupName $Row) `
          (Get-QueueAuditAuthorized $Row)
      }
      Sync-ExchangeGroupState $currentAliasOwner.SourceGroupId "" $Stats
      return
    }
  }

  if ($currentBaseAlias) { Sync-ExchangeAliasPeers $currentBaseAlias $Stats }
  Sync-ExchangeGroupState `
    $Row.entity_id `
    $Row.entity_alias `
    $Stats `
    (Get-QueueExpectedGroupName $Row) `
    $(if ($sourceGroup) { $false } else { Get-QueueAuditAuthorized $Row })
  if ($beforeBaseAlias -and -not $beforeBaseAlias.Equals($currentBaseAlias, [StringComparison]::OrdinalIgnoreCase)) {
    Sync-ExchangeAliasPeers $beforeBaseAlias $Stats $true $true
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
    backlogRows = 0
    skippedQueueRows = 0
    supersededQueueRows = 0
    resolvedTerminalQueueRows = 0
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
    Renew-ExchangeSyncLockIfDue -Force
    $batchRows = Claim-ExchangeQueueRows 200
    if (@($batchRows).Count -le 0) { break }
    Increment-Stat $stats "queuedRows" @($batchRows).Count
    $script:CanonicalExchangeRows = $null

  foreach ($row in $batchRows) {
    $rowId = Clean-Text $row.id
    if (-not $rowId) { continue }
    $beforeCounters = $null
    $failureTransition = $null
    $failurePersisted = $false
    try {
      Increment-Stat $stats "processedQueueRows"
      Renew-ExchangeSyncLockIfDue
      Write-Host ("Processing Exchange queue row {0}: {1} {2}" -f $rowId, (Clean-Text $row.action), (Clean-Text $row.display_name))
      $supersededForRow = Get-QueueSupersededSaveCount $row
      if ($supersededForRow -gt 0) {
        Increment-Stat $stats "supersededQueueRows" $supersededForRow
        Increment-Stat $stats "skippedQueueRows" $supersededForRow
      }
      $beforeCounters = Get-QueueCounterSnapshot $stats
      Process-ExchangeQueueRow $row $stats
      Renew-ExchangeSyncLockIfDue
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
        $completionResult = Complete-VerifiedExchangeQueueRow $rowId
        $completionWasIdempotent = [bool](Get-MapValue $completionResult "idempotent")
        $completionConfirmation = if ($completionWasIdempotent) {
          "Durable queue completion was confirmed by an idempotent replay of the same row/run after an ambiguous prior response."
        } else {
          "Durable queue completion and Exchange verification were committed atomically."
        }
        $resultMessage = "$resultMessage $completionConfirmation"
        Increment-Stat $stats "completedQueueRows"
        Add-SyncChange $stats $row
        Add-SyncChangeDetail $stats $row "completed" $resultMessage
        Add-ExchangeResolvedTerminalQueueDetails $stats $completionResult "incremental"
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
        $failureTransition = Get-ExchangeQueueFailureTransition $row $rowError
        Update-ExchangeQueueRow $rowId $failureTransition.Fields
        $failurePersisted = $true
        $failureResult += " Queue status: failed. Retry state: $($failureTransition.RetryState)"
      } catch {
        $statusError = Clean-Text $_.Exception.Message
        $failureResult += " Queue status persistence also failed: $statusError"
        Write-Warning ("Could not persist failed status for Exchange queue row {0}: {1}" -f $rowId, $statusError)
      }
      Increment-Stat $stats "failedQueueRows"
      if ($failurePersisted -and $failureTransition) {
        $retryState = [pscustomobject]@{
          Label = $failureTransition.RetryState
          Retryable = -not [bool]$failureTransition.Terminal
          Terminal = [bool]$failureTransition.Terminal
        }
        Add-SyncChangeDetail $stats $row "failed" $failureResult "failed" $retryState $failureTransition.NextAttemptAt $script:CurrentQueueRunId
      } else {
        $processingState = [pscustomobject]@{
          Label = "Queue status persistence was not confirmed; the authoritative queue row must be re-read before any retry is assumed."
          Retryable = $false
          Terminal = $false
        }
        Add-SyncChangeDetail $stats $row "processing" $failureResult "processing" $processingState "" $row.run_id
      }
      Write-Warning ("Exchange queue row {0} failed: {1}" -f $rowId, $rowError)
    }
  }
  }

  $backlogQueueRows = @(Get-ExchangeQueueBacklogRows)
  $stats["backlogRows"] = $backlogQueueRows.Count
  Add-ExchangeQueueBacklogDetails $stats $backlogQueueRows

  return $stats
}

function Get-WebhookPayload($WebhookData) {
  if ($null -eq $WebhookData) { return @{} }

  $root = $WebhookData
  if ($root -is [string]) {
    $text = Clean-Text $root
    if (-not $text) { return @{} }
    try {
      $root = $text | ConvertFrom-Json
    } catch {
      return @{}
    }
  }

  if (Has-MapKey $root "syncMode") { return $root }

  $body = Get-MapValue $root "RequestBody"
  if ($null -eq $body) { return @{} }
  if (-not ($body -is [string])) {
    if (Has-MapKey $body "syncMode") { return $body }
    return @{}
  }

  try {
    return $body | ConvertFrom-Json
  } catch {
    return @{}
  }
}

function Get-ExchangeQueueRunId($Payload) {
  $reservationText = Clean-Text (Get-MapValue $Payload "reservationId")
  [Guid]$reservationId = [Guid]::Empty
  if ($reservationText -and [Guid]::TryParse($reservationText, [ref]$reservationId)) {
    return $reservationId.ToString()
  }
  return [Guid]::NewGuid().ToString()
}

function Initialize-WebhookPayload($WebhookData, $FallbackRequestedAt = $null) {
  $payload = Get-WebhookPayload $WebhookData
  $requestedAt = ConvertTo-UtcTimestamp (Get-MapValue $payload "requestedAt")
  if (-not $requestedAt) {
    $requestedAt = ConvertTo-UtcTimestamp $FallbackRequestedAt
    if (-not $requestedAt) {
      $requestedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
  }

  if ($payload -is [System.Collections.IDictionary]) {
    $payload["requestedAt"] = $requestedAt
  } else {
    $payload | Add-Member -NotePropertyName "requestedAt" -NotePropertyValue $requestedAt -Force
  }
  return $payload
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
    "queuedRows" { return "Claimed this run" }
    "processedQueueRows" { return "Processed changes" }
    "completedQueueRows" { return "Completed changes" }
    "failedQueueRows" { return "Failed changes" }
    "backlogRows" { return "Unresolved queue backlog" }
    "retryableBacklogRows" { return "Retryable backlog changes" }
    "terminalBacklogRows" { return "Terminal backlog changes" }
    "activeBacklogRows" { return "Active processing backlog" }
    "skippedQueueRows" { return "Skipped changes (including superseded saves)" }
    "supersededQueueRows" { return "Earlier saves superseded" }
    "resolvedTerminalQueueRows" { return "Terminal queue failures resolved" }
    "verifiedQueueRows" { return "Verified operations" }
    "fullCertificationCommitted" { return "Durable full certification" }
    "fullCertificationIdempotent" { return "Certification replay confirmed" }
    "fullCertificationAt" { return "Certified at" }
    "contacts" { return "Contacts processed" }
    "groups" { return "Groups processed" }
    "groupMembers" { return "Group members processed" }
    "createdContacts" { return "Contacts created" }
    "updatedContacts" { return "Contacts updated" }
    "removedContacts" { return "Contacts removed" }
    "preservedInvalidContacts" { return "Invalid-source contacts preserved" }
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
  $backlogRows = [int](Get-DetailValue $Details "backlogRows")
  $retryableBacklogRows = [int](Get-DetailValue $Details "retryableBacklogRows")
  $terminalBacklogRows = [int](Get-DetailValue $Details "terminalBacklogRows")
  $activeBacklogRows = [int](Get-DetailValue $Details "activeBacklogRows")
  $skippedRows = [int](Get-DetailValue $Details "skippedQueueRows")
  $supersededRows = [int](Get-DetailValue $Details "supersededQueueRows")
  $resolvedTerminalRows = [int](Get-DetailValue $Details "resolvedTerminalQueueRows")
  $actionableSkippedRows = [Math]::Max(0, $skippedRows - $supersededRows - $resolvedTerminalRows)
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
    } elseif ($changeStatus -eq "pending") {
      $changeStatusText = "Pending"
      $changeStatusColor = "#854d0e"
      $changeStatusBackground = "#fef9c3"
      $rowBackground = "#fffdf2"
    } elseif ($changeStatus -eq "processing") {
      $changeStatusText = "Processing"
      $changeStatusColor = "#1e40af"
      $changeStatusBackground = "#dbeafe"
      $rowBackground = "#eff6ff"
    } elseif ($changeStatus -eq "skipped") {
      $changeStatusText = "Skipped"
      $changeStatusColor = "#854d0e"
      $changeStatusBackground = "#fef9c3"
      $rowBackground = "#fffdf2"
    } elseif ($changeStatus -eq "superseded") {
      $changeStatusText = "Resolved"
      $changeStatusColor = "#1e40af"
      $changeStatusBackground = "#dbeafe"
      $rowBackground = "#eff6ff"
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
    $queueStatus = Clean-Text (Get-DetailValue $change "queueStatus")
    $retryState = Clean-Text (Get-DetailValue $change "retryState")
    $nextRetryAt = Clean-Text (Get-DetailValue $change "nextRetryAt")
    $runId = Clean-Text (Get-DetailValue $change "runId")
    $stableId = Clean-Text (Get-DetailValue $change "stableId")
    $exchangeIdentity = Clean-Text (Get-DetailValue $change "exchangeIdentity")
    $supersededByQueueRowId = Clean-Text (Get-DetailValue $change "supersededByQueueRowId")
    $supersededByRunId = Clean-Text (Get-DetailValue $change "supersededByRunId")
    $supersededByFullRunId = Clean-Text (Get-DetailValue $change "supersededByFullRunId")

    $identifierHtml = ""
    if ($identifier) {
      $identifierHtml = "<div style='margin-top:3px;color:#475569;font-size:12px;'>$(Escape-Html $identifier)</div>"
    }
    $fieldChangesHtml = ""
    $fieldChanges = @(Get-DetailValue $change "fieldChanges")
    if ($fieldChanges.Count -gt 0) {
      $fieldItems = @($fieldChanges | ForEach-Object { "<li style='margin:2px 0;'>$(Escape-Html $_)</li>" }) -join ""
      $fieldChangesHtml = "<div style='margin-top:7px;color:#334155;font-size:11px;font-weight:800;'>Exact change</div><ul style='margin:3px 0 0 17px;padding:0;color:#475569;font-size:11px;'>$fieldItems</ul>"
    }
    $errorHistoryHtml = ""
    $errorHistory = @(Get-DetailValue $change "errorHistory" | Where-Object { $null -ne $_ })
    if ($errorHistory.Count -gt 0) {
      $historyItems = @($errorHistory | ForEach-Object {
        $historyJson = $_ | ConvertTo-Json -Depth 8 -Compress
        "<li style='margin:3px 0;word-break:break-word;'><code>$(Escape-Html $historyJson)</code></li>"
      }) -join ""
      $errorHistoryHtml = "<div style='margin-top:7px;color:#334155;font-size:11px;font-weight:800;'>Durable queue error history</div><ul style='margin:3px 0 0 17px;padding:0;color:#475569;font-size:10px;'>$historyItems</ul>"
    }
    $queueMetadata = @()
    if ($rowRequestedBy) { $queueMetadata += "Requested by $(Escape-Html $rowRequestedBy)" }
    if ($actorId -and $actorId -ne $rowRequestedBy) { $queueMetadata += "Actor $(Escape-Html $actorId)" }
    if ($rowQueuedAt) { $queueMetadata += "Queued $(Escape-Html $rowQueuedAt)" }
    if ($rowAttempt -gt 0) { $queueMetadata += "Attempt $(Escape-Html $rowAttempt)" }
    elseif ($queueStatus -eq "pending") { $queueMetadata += "Not attempted" }
    if ($queueStatus) { $queueMetadata += "Queue status $(Escape-Html $queueStatus)" }
    if ($nextRetryAt) { $queueMetadata += "Next retry $(Escape-Html $nextRetryAt)" }
    if ($runId) { $queueMetadata += "Run $(Escape-Html $runId)" }
    if ($retryState) { $queueMetadata += "Retry state $(Escape-Html $retryState)" }
    if ($stableId) { $queueMetadata += "FCUNO stable ID $(Escape-Html $stableId)" }
    if ($exchangeIdentity) { $queueMetadata += "Exchange identity $(Escape-Html $exchangeIdentity)" }
    if ($eventId) { $queueMetadata += "Event $(Escape-Html $eventId)" }
    if ($auditLogIds.Count -gt 0) { $queueMetadata += "Audit log$(if ($auditLogIds.Count -gt 1) { 's' } else { '' }) $(Escape-Html (($auditLogIds | Select-Object -First 5) -join ', '))" }
    if ($changeSetIds.Count -gt 0) { $queueMetadata += "Change set$(if ($changeSetIds.Count -gt 1) { 's' } else { '' }) $(Escape-Html (($changeSetIds | Select-Object -First 5) -join ', '))" }
    if ($supersededByQueueRowId) { $queueMetadata += "Superseded by queue row $(Escape-Html $supersededByQueueRowId)" }
    if ($supersededByRunId) { $queueMetadata += "Superseding run $(Escape-Html $supersededByRunId)" }
    if ($supersededByFullRunId) { $queueMetadata += "Superseding full run $(Escape-Html $supersededByFullRunId)" }
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
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;">$(Escape-Html $result)$errorHistoryHtml$queueRowHtml</td>
</tr>
"@
    $changeIndex += 1
  }

  $changeCount = @($changeDetails).Count
  $changeResultsTitle = $(if ($backlogRows -gt 0) { "Queue change and backlog results" } elseif (-not $hasQueueStats) { "Full reconciliation results" } else { "Change results" })
  if (-not $changeRows) {
    $fallbackAction = if ($backlogRows -gt 0) { "Queue backlog" } elseif ($hasQueueStats) { "Incremental sync" } else { "Full sync" }
    $fallbackItem = if ($backlogRows -gt 0) { "$backlogRows unresolved queue change(s)" } elseif ($hasQueueStats -and $queuedRows -le 0) { "No pending changes" } elseif (-not $hasQueueStats -and $Status -eq "completed") { "No Exchange mutations required" } else { "Address book sync" }
    $fallbackResult = if (-not $hasQueueStats -and $Status -eq "completed") { "All eligible FCUNO contacts, groups, profiles, and memberships already matched Exchange and final certification completed without mutation." } else { $Message }
    $fallbackStatus = if ($Status -eq "completed") { "Completed" } else { "Failed" }
    $fallbackStatusColor = if ($Status -eq "completed") { "#166534" } else { "#991b1b" }
    $fallbackStatusBackground = if ($Status -eq "completed") { "#dcfce7" } else { "#fee2e2" }
    $changeRows = @"
<tr>
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;"><span style="display:inline-block;padding:3px 8px;border-radius:999px;background:$fallbackStatusBackground;color:$fallbackStatusColor;font-size:11px;font-weight:800;">$(Escape-Html $fallbackStatus)</span></td>
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-weight:700;">$(Escape-Html $fallbackAction)</td>
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-weight:700;">$(Escape-Html $fallbackItem)</td>
  <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;">$(Escape-Html $fallbackResult)</td>
</tr>
"@
  } elseif ($changeCount -gt $changeIndex) {
    $remainingChanges = $changeCount - $changeIndex
    $changeRows += "<tr><td colspan='4' style='padding:10px 8px;color:#64748b;background:#f8fafc;'>$(Escape-Html "$remainingChanges additional result(s) were omitted from this email.")</td></tr>"
  }

  $detailsRows = ""
  if ($Details) {
    foreach ($key in @("syncMode", "queuedRows", "processedQueueRows", "completedQueueRows", "failedQueueRows", "backlogRows", "retryableBacklogRows", "terminalBacklogRows", "activeBacklogRows", "skippedQueueRows", "supersededQueueRows", "resolvedTerminalQueueRows", "verifiedQueueRows", "fullCertificationCommitted", "fullCertificationIdempotent", "fullCertificationAt", "contacts", "groups", "groupMembers", "createdContacts", "updatedContacts", "removedContacts", "preservedInvalidContacts", "createdGroups", "updatedGroups", "removedGroups", "addedMembers", "removedMembers")) {
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
  if ($failedRows -gt 0 -or $backlogRows -gt 0 -or $Status -ne "completed") {
    $followUpText = "Review each error below."
    if ($retryableBacklogRows -gt 0) { $followUpText += " $retryableBacklogRows backlog change(s) remain automatically retryable as shown." }
    if ($terminalBacklogRows -gt 0) { $followUpText += " $terminalBacklogRows backlog change(s) are terminal and will not retry automatically; correct the cause and requeue them manually." }
    if ($activeBacklogRows -gt 0) { $followUpText += " $activeBacklogRows backlog change(s) are still processing under an active lease." }
    if ($backlogRows -le 0) { $followUpText += " Retryable failures show their next run time; terminal validation or retry-limit failures require correction in FCUNO or Exchange." }
    $followUpHtml = "<div style='margin:16px 0 0;padding:12px 14px;border:1px solid #fdba74;border-radius:10px;background:#fff7ed;color:#9a3412;'><strong>Action required:</strong> $(Escape-Html $followUpText)</div>"
  } elseif ($actionableSkippedRows -gt 0) {
    $followUpHtml = "<div style='margin:16px 0 0;padding:12px 14px;border:1px solid #fde047;border-radius:10px;background:#fefce8;color:#854d0e;'><strong>Note:</strong> Skipped changes made no Exchange update. Each skipped reason is shown below.</div>"
  } elseif ($resolvedTerminalRows -gt 0) {
    $followUpHtml = "<div style='margin:16px 0 0;padding:12px 14px;border:1px solid #bfdbfe;border-radius:10px;background:#eff6ff;color:#1e40af;'><strong>Resolved:</strong> $resolvedTerminalRows terminal queue failure(s) were superseded only after later Exchange-verified processing of the current FCUNO state or source-fenced full certification. Their exact prior errors and durable histories are listed below.</div>"
  } elseif ($supersededRows -gt 0) {
    $followUpHtml = "<div style='margin:16px 0 0;padding:12px 14px;border:1px solid #bfdbfe;border-radius:10px;background:#eff6ff;color:#1e40af;'><strong>Note:</strong> $supersededRows earlier save(s) were safely superseded by the final value and are not listed as separate changes below.</div>"
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

      <h3 style="margin:22px 0 8px;font-size:16px;">$(Escape-Html $changeResultsTitle)</h3>
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
      <p style="margin:18px 0 0;color:#94a3b8;font-size:10px;">Sync result statuses and Exchange verification details are recorded for audit and troubleshooting.</p>
    </div>
  </div>
</div>
"@

  try {
    $subject = "Exchange address book sync: $statusText"
    if ($hasQueueStats) {
      $subject += " - $completedRows completed, $failedRows failed, $actionableSkippedRows skipped"
      if ($resolvedTerminalRows -gt 0) { $subject += ", $resolvedTerminalRows terminal resolved" }
      if ($backlogRows -gt 0) { $subject += ", $backlogRows backlog ($retryableBacklogRows retryable, $terminalBacklogRows terminal, $activeBacklogRows processing)" }
    }
    Send-ExchangeSmtpMail $from @($recipients) $subject $html
  } catch {
    Write-Warning ("Exchange sync notification email failed: {0}" -f $_.Exception.Message)
  }
}

function Get-IncrementalSyncOutcome($Details) {
  $Details = Get-StatsObject $Details
  $failedRows = [int](Get-DetailValue $Details "failedQueueRows")
  $completedRows = [int](Get-DetailValue $Details "completedQueueRows")
  $backlogRows = [int](Get-DetailValue $Details "backlogRows")
  $retryableBacklogValue = Get-DetailValue $Details "retryableBacklogRows"
  $terminalBacklogValue = Get-DetailValue $Details "terminalBacklogRows"
  $activeBacklogValue = Get-DetailValue $Details "activeBacklogRows"
  $skippedRows = [int](Get-DetailValue $Details "skippedQueueRows")
  $supersededRows = [int](Get-DetailValue $Details "supersededQueueRows")
  $resolvedTerminalRows = [int](Get-DetailValue $Details "resolvedTerminalQueueRows")
  $actionableSkippedRows = [Math]::Max(0, $skippedRows - $supersededRows - $resolvedTerminalRows)
  $queuedRows = [int](Get-DetailValue $Details "queuedRows")

  if ($failedRows -gt 0) {
    return [pscustomobject]@{
      Status = "failed"
      Message = "Exchange incremental sync failed for $failedRows change(s); $completedRows other change(s) completed and were verified."
      AlwaysNotify = $true
    }
  }
  if ($backlogRows -gt 0) {
    $backlogState = ""
    if ($null -ne $retryableBacklogValue -or $null -ne $terminalBacklogValue -or $null -ne $activeBacklogValue) {
      $backlogState = " Of these, $([int]$retryableBacklogValue) are automatically retryable, $([int]$terminalBacklogValue) are terminal and require manual correction/requeue, and $([int]$activeBacklogValue) remain under an active processing lease."
    }
    return [pscustomobject]@{
      Status = "failed"
      Message = "Exchange incremental sync could not finish because $backlogRows unresolved queue change(s) remain pending, processing, or failed.$backlogState Review each row's exact queue status, retry state, run, and latest error below."
      AlwaysNotify = $true
    }
  }
  if ($queuedRows -le 0) {
    return [pscustomobject]@{
      Status = "completed"
      Message = "Exchange incremental sync completed. No pending changes were queued."
      AlwaysNotify = $false
    }
  }
  if ($actionableSkippedRows -gt 0) {
    return [pscustomobject]@{
      Status = "failed"
      Message = "Exchange incremental sync failed because $actionableSkippedRows requested change(s) were skipped."
      AlwaysNotify = $true
    }
  }
  return [pscustomobject]@{
    Status = "completed"
    Message = $(if ($resolvedTerminalRows -gt 0) { "Exchange incremental sync completed; $resolvedTerminalRows terminal queue failure(s) were resolved by later Exchange-verified processing of the current FCUNO state." } else { "Exchange incremental sync completed." })
    AlwaysNotify = $true
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

function Complete-FullExchangeQueueCertificationIfEligible([hashtable]$Stats, $InitialQueueHighWater, $InitialProjectionFingerprint, $SourceDrift) {
  if ([int]$Stats.failedQueueRows -gt 0 -or @($SourceDrift).Count -gt 0) { return $null }
  try {
    $certificationResult = Commit-FullExchangeQueueCertification $InitialQueueHighWater $InitialProjectionFingerprint
    $Stats["fullCertificationCommitted"] = $true
    $Stats["fullCertificationIdempotent"] = [bool](Get-MapValue $certificationResult "idempotent")
    $Stats["fullCertificationAt"] = Clean-Text (Get-MapValue $certificationResult "certifiedAt")
    Add-ExchangeResolvedTerminalQueueDetails $Stats $certificationResult "full"
    return $certificationResult
  } catch {
    Add-FullSyncFailure `
      $Stats `
      "Full address book" `
      "Durable full certification" `
      "queue $InitialQueueHighWater" `
      ("Final Exchange projection verification succeeded, but the source-fenced durable queue certification was not confirmed: " + $_.Exception.Message)
    return $null
  }
}

function New-FullSyncLockFailureDetails($Message) {
  $stats = @{
    syncMode = "full"
    contacts = 0
    groups = 0
    groupMembers = 0
    failedQueueRows = 0
    skippedQueueRows = 0
    resolvedTerminalQueueRows = 0
    verifiedQueueRows = 0
    fullCertificationCommitted = $false
    fullCertificationIdempotent = $false
    changeDetails = @()
    createdContacts = 0
    updatedContacts = 0
    removedContacts = 0
    preservedInvalidContacts = 0
    createdGroups = 0
    updatedGroups = 0
    removedGroups = 0
    addedMembers = 0
    removedMembers = 0
  }
  Add-FullSyncFailure $stats "Full address book" "Full reconciliation lock" "addressbook mutation lease" $Message
  return $stats
}

function Get-ExchangeSyncLockDenial($SyncMode) {
  $mode = (Clean-Text $SyncMode).ToLowerInvariant()
  $message = "Exchange address book sync did not start because another full or incremental sync currently holds the mutation lease."
  if ($mode -eq "full") {
    return [pscustomobject]@{
      Fatal = $true
      Message = "$message Full certification was not performed; retry the scheduled full reconciliation after the active job finishes."
    }
  }
  return [pscustomobject]@{
    Fatal = $false
    Message = "$message Durable queue rows remain pending for the next incremental run."
  }
}

function Confirm-FinalExchangeProjection($ExchangeRows, $MailContacts, $ContactProfiles, $DistributionGroups, $GroupProfiles, [hashtable]$Stats) {
  $mailContactLookup = New-ExchangeMailContactLookup $MailContacts
  $contactProfileLookup = New-ExchangeContactProfileLookup $ContactProfiles
  $distributionGroupLookup = New-ExchangeDistributionGroupLookup $DistributionGroups
  $groupProfileLookup = New-ExchangeGroupProfileLookup $GroupProfiles
  $desiredContactSourceKeys = @{}
  $desiredGroupSourceKeys = @{}

  foreach ($contact in @($ExchangeRows.Contacts)) {
    Renew-ExchangeSyncLockIfDue
    $sourceKey = Clean-Text $contact.SourceKey
    if ($sourceKey) { $desiredContactSourceKeys[$sourceKey] = $true }
    $sourceMatches = if ($sourceKey) { @($mailContactLookup.BySourceKey[$sourceKey]) } else { @() }
    $email = Normalize-Email $contact.ExternalEmailAddress
    $emailMatches = if ($email) { @($mailContactLookup.ByEmail[$email]) } else { @() }
    if ($sourceMatches.Count -ne 1) {
      Add-FullSyncFailure $Stats "Contact" $contact.DisplayName $sourceKey "Final Exchange certification expected exactly one contact with this source key; found $($sourceMatches.Count)."
      continue
    }
    if ($emailMatches.Count -ne 1 -or -not (Test-ExchangeObjectsRepresentSameRecipient $sourceMatches[0] $emailMatches[0])) {
      Add-FullSyncFailure $Stats "Contact" $contact.DisplayName $sourceKey "Final Exchange certification found that the expected source key and email do not resolve to the same unique contact."
      continue
    }

    $profile = $null
    try {
      $profile = Resolve-ExchangeContactProfileHint $sourceMatches[0] $contactProfileLookup
    } catch {
      Add-FullSyncFailure $Stats "Contact" $contact.DisplayName $sourceKey ("Final Exchange certification could not resolve one authoritative contact profile: " + $_.Exception.Message)
      continue
    }
    if (-not $profile) {
      Add-FullSyncFailure $Stats "Contact" $contact.DisplayName $sourceKey "Final Exchange certification could not resolve an authoritative contact profile."
      continue
    }
    $mismatches = @(Get-ExchangeMailContactMismatches $sourceMatches[0] $contact $profile)
    if ($mismatches.Count -gt 0) {
      Add-FullSyncFailure $Stats "Contact" $contact.DisplayName $sourceKey ("Final Exchange metadata differs for: " + ($mismatches -join ", ") + ".")
    }
  }

  foreach ($group in @($ExchangeRows.Groups)) {
    Renew-ExchangeSyncLockIfDue
    $sourceKey = Clean-Text $group.SourceKey
    if ($sourceKey) { $desiredGroupSourceKeys[$sourceKey] = $true }
    $sourceMatches = if ($sourceKey) { @($distributionGroupLookup.BySourceKey[$sourceKey]) } else { @() }
    $alias = (Clean-Text $group.Alias).ToLowerInvariant()
    $aliasMatches = if ($alias) { @($distributionGroupLookup.ByAlias[$alias]) } else { @() }
    if ($sourceMatches.Count -ne 1) {
      Add-FullSyncFailure $Stats "Group" $group.GroupName $sourceKey "Final Exchange certification expected exactly one group with this source key; found $($sourceMatches.Count)."
      continue
    }
    if ($aliasMatches.Count -ne 1 -or -not (Test-ExchangeObjectsRepresentSameRecipient $sourceMatches[0] $aliasMatches[0])) {
      Add-FullSyncFailure $Stats "Group" $group.GroupName $sourceKey "Final Exchange certification found that the expected source key and alias do not resolve to the same unique group."
      continue
    }
    $profile = $null
    try {
      $profile = Resolve-ExchangeGroupProfileHint $sourceMatches[0] $groupProfileLookup
    } catch {
      Add-FullSyncFailure $Stats "Group" $group.GroupName $sourceKey ("Final Exchange certification could not resolve one authoritative group profile: " + $_.Exception.Message)
      continue
    }
    if (-not $profile) {
      Add-FullSyncFailure $Stats "Group" $group.GroupName $sourceKey "Final Exchange certification could not resolve an authoritative group profile via immutable identity."
      continue
    }
    $mismatches = @(Get-ExchangeDistributionGroupMismatches $sourceMatches[0] $group $profile)
    if ($mismatches.Count -gt 0) {
      Add-FullSyncFailure $Stats "Group" $group.GroupName $sourceKey ("Final Exchange metadata differs for: " + ($mismatches -join ", ") + ".")
    }
  }

  $managedContacts = @($MailContacts | Where-Object { (Clean-Text $_.CustomAttribute1) -eq $ManagedMarker })
  $managedGroups = @($DistributionGroups | Where-Object { (Clean-Text $_.CustomAttribute1) -eq $ManagedMarker })
  foreach ($managedContact in $managedContacts) {
    Renew-ExchangeSyncLockIfDue
    $sourceKey = Clean-Text $managedContact.CustomAttribute2
    if (-not $sourceKey -or -not (Has-MapKey $desiredContactSourceKeys $sourceKey)) {
      Add-FullSyncFailure $Stats "Contact" $managedContact.DisplayName $sourceKey "Final Exchange certification found an unexpected managed contact."
    }
  }
  foreach ($managedGroup in $managedGroups) {
    Renew-ExchangeSyncLockIfDue
    $sourceKey = Clean-Text $managedGroup.CustomAttribute2
    if (-not $sourceKey -or -not (Has-MapKey $desiredGroupSourceKeys $sourceKey)) {
      Add-FullSyncFailure $Stats "Group" $managedGroup.DisplayName $sourceKey "Final Exchange certification found an unexpected managed group."
    }
  }

  $Stats["verifiedManagedContacts"] = $managedContacts.Count
  $Stats["verifiedManagedGroups"] = $managedGroups.Count
  if ($managedContacts.Count -ne @($ExchangeRows.Contacts).Count) {
    Add-FullSyncFailure $Stats "Full address book" "Managed contacts" "$($managedContacts.Count) in Exchange / $(@($ExchangeRows.Contacts).Count) in FCUNO" "Final managed-contact count does not match the canonical FCUNO projection."
  }
  if ($managedGroups.Count -ne @($ExchangeRows.Groups).Count) {
    Add-FullSyncFailure $Stats "Full address book" "Managed groups" "$($managedGroups.Count) in Exchange / $(@($ExchangeRows.Groups).Count) in FCUNO" "Final managed-group count does not match the canonical FCUNO projection."
  }
}

function Confirm-FinalExchangeGroupMemberships($ExchangeRows, [hashtable]$Stats) {
  $membersByGroupId = @{}
  foreach ($member in @($ExchangeRows.Members)) {
    $groupId = Clean-Text $member.SourceGroupId
    if (-not (Has-MapKey $membersByGroupId $groupId)) { $membersByGroupId[$groupId] = @() }
    $membersByGroupId[$groupId] = @($membersByGroupId[$groupId]) + @($member)
  }

  $groupPosition = 0
  foreach ($group in @($ExchangeRows.Groups)) {
    $groupPosition += 1
    Renew-ExchangeSyncLockIfDue
    try {
      $sourceKey = Clean-Text $group.SourceKey
      if (-not $sourceKey) { throw "The FCUNO group source key is missing." }
      $resolvedGroups = @(Get-DistributionGroup -Filter "CustomAttribute2 -eq '$(Escape-ExchangeFilterValue $sourceKey)'" -ResultSize Unlimited -ErrorAction Stop | Where-Object { $null -ne $_ })
      if ($resolvedGroups.Count -ne 1) { throw "Source key $sourceKey resolved to $($resolvedGroups.Count) Exchange groups." }
      $groupIdentity = Get-ExchangeStrongCommandIdentity $resolvedGroups[0]
      if (-not $groupIdentity) { throw "Source key $sourceKey has no immutable Exchange group identity." }
      $actualMembers = @(Get-DistributionGroupMember -Identity $groupIdentity -ResultSize Unlimited -ErrorAction Stop)
      Renew-ExchangeSyncLockIfDue
      $desiredMembers = if (Has-MapKey $membersByGroupId (Clean-Text $group.SourceGroupId)) { @($membersByGroupId[(Clean-Text $group.SourceGroupId)]) } else { @() }
      $mismatches = @(Get-ExchangeGroupMembershipMismatches $desiredMembers $actualMembers)
      if ($mismatches.Count -gt 0) {
        Add-FullSyncFailure $Stats "Group membership" $group.GroupName $group.Alias ("Final Exchange membership differs: " + ($mismatches -join "; ") + ".")
      }
    } catch {
      Add-FullSyncFailure $Stats "Group membership" $group.GroupName $group.Alias ("Final Exchange membership certification failed: " + $_.Exception.Message)
    }
  }
}

function Remove-StaleManagedExchangeContacts($ManagedContacts, $ExchangeRows, [hashtable]$Stats) {
  $desiredContactSourceKeys = @{}
  $desiredContactEmails = @{}
  $protectedInvalidContactSourceKeys = @{}
  foreach ($contact in @($ExchangeRows.Contacts)) {
    $sourceKey = Clean-Text $contact.SourceKey
    $email = Normalize-Email $contact.ExternalEmailAddress
    if ($sourceKey) { $desiredContactSourceKeys[$sourceKey] = $true }
    if ($email) { $desiredContactEmails[$email] = $true }
  }
  foreach ($invalid in @($ExchangeRows.InvalidContacts)) {
    $invalidSourceKey = Get-ContactSourceKey $invalid.SourceContactId
    if ($invalidSourceKey) { $protectedInvalidContactSourceKeys[$invalidSourceKey] = $true }
  }

  foreach ($managedContact in @($ManagedContacts)) {
    Renew-ExchangeSyncLockIfDue
    $sourceKey = Clean-Text $managedContact.CustomAttribute2
    $email = Get-RecipientEmail $managedContact
    if ($sourceKey -and (Has-MapKey $protectedInvalidContactSourceKeys $sourceKey)) {
      Increment-Stat $Stats "preservedInvalidContacts"
      continue
    }
    $isDesired = ($sourceKey -and (Has-MapKey $desiredContactSourceKeys $sourceKey)) -or ($email -and (Has-MapKey $desiredContactEmails $email))
    if ($isDesired) { continue }
    try {
      $deleteIdentity = Get-ExchangeStrongCommandIdentity $managedContact
      if (-not $deleteIdentity) { throw "The stale managed contact has no immutable Exchange identity, so deletion was blocked." }
      Remove-MailContact -Identity $deleteIdentity -Confirm:$false -ErrorAction Stop
      Renew-ExchangeSyncLockIfDue
      Confirm-ExchangeMailContactDeletion $managedContact $email $sourceKey
      Increment-Stat $Stats "removedContacts"
      Add-FullSyncMutationDetail `
        $Stats `
        "Delete stale contact" `
        "Contact" `
        $managedContact.DisplayName `
        $email `
        $sourceKey `
        $(if (Get-ExchangeStrongCommandIdentity $managedContact) { Get-ExchangeStrongCommandIdentity $managedContact } else { Clean-Text $managedContact.Identity }) `
        "Deleted the stale managed Exchange contact and verified that its identity is absent." `
        @(
          "Display name: $(Clean-Text $managedContact.DisplayName) -> (missing)",
          "Email: $email -> (missing)",
          "Alias: $(Clean-Text $managedContact.Alias) -> (missing)"
        )
    } catch {
      Add-FullSyncFailure $Stats "Contact" $managedContact.DisplayName $email ("Could not remove stale managed contact: " + $_.Exception.Message)
    }
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
    resolvedTerminalQueueRows = 0
    verifiedQueueRows = 0
    fullCertificationCommitted = $false
    fullCertificationIdempotent = $false
    changeDetails = @()
    addedMemberEmails = @()
    removedMemberEmails = @()
    createdContacts = 0
    updatedContacts = 0
    removedContacts = 0
    preservedInvalidContacts = 0
    createdGroups = 0
    updatedGroups = 0
    removedGroups = 0
    addedMembers = 0
    removedMembers = 0
  }

  Renew-ExchangeSyncLockIfDue -Force
  $initialQueueHighWater = Get-ExchangeQueueHighWater
  $script:CanonicalExchangeRows = $null
  $exchangeRows = Get-CanonicalExchangeRows
  $initialProjectionFingerprint = Get-CanonicalExchangeProjectionFingerprint $exchangeRows
  $stats["contacts"] = @($exchangeRows.Contacts).Count
  $stats["groups"] = @($exchangeRows.Groups).Count
  $stats["groupMembers"] = @($exchangeRows.Members).Count

  foreach ($invalid in @($exchangeRows.InvalidContacts)) {
    $invalidSourceKey = Get-ContactSourceKey $invalid.SourceContactId
    Add-FullSyncFailure $stats "Contact" $invalid.DisplayName $invalid.Email "FCUNO validation failed: $($invalid.Reason). Any existing managed Exchange contact with source key $invalidSourceKey is preserved but uncertified; no Exchange mutation was attempted for this row."
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
      Sync-ExchangeAliasPeers $baseAlias $stats $true
    } catch {
      Add-FullSyncFailure $stats "Alias collision" $baseAlias $baseAlias $_.Exception.Message
    }
  }

  Renew-ExchangeSyncLockIfDue -Force
  $exchangeMailContacts = @(Get-MailContact -ResultSize Unlimited -ErrorAction Stop)
  Renew-ExchangeSyncLockIfDue
  $exchangeContactProfiles = @(Get-Contact -ResultSize Unlimited -ErrorAction Stop)
  Renew-ExchangeSyncLockIfDue
  $exchangeDistributionGroups = @(Get-DistributionGroup -ResultSize Unlimited -ErrorAction Stop)
  Renew-ExchangeSyncLockIfDue
  $exchangeGroupProfiles = @(Get-Group -ResultSize Unlimited -ErrorAction Stop)
  Renew-ExchangeSyncLockIfDue
  $mailContactLookup = New-ExchangeMailContactLookup $exchangeMailContacts
  $contactProfileLookup = New-ExchangeContactProfileLookup $exchangeContactProfiles
  $distributionGroupLookup = New-ExchangeDistributionGroupLookup $exchangeDistributionGroups
  $groupProfileLookup = New-ExchangeGroupProfileLookup $exchangeGroupProfiles
  $contactLookupSnapshotCurrent = $true
  $groupLookupSnapshotCurrent = $true

  $contactPosition = 0
  foreach ($contact in @($exchangeRows.Contacts)) {
    $contactPosition += 1
    try {
      Renew-ExchangeSyncLockIfDue
      $existingHint = Resolve-ExchangeMailContactHint $contact $mailContactLookup
      $existingProfileHint = if ($null -ne $existingHint) { Resolve-ExchangeContactProfileHint $existingHint $contactProfileLookup } else { $null }
      $useExistingHint = $null -ne $existingHint -and $null -ne $existingProfileHint -and (Test-ExchangeMailContactMatches $existingHint $contact $existingProfileHint)
      if (-not $useExistingHint) { $contactLookupSnapshotCurrent = $false }
      Upsert-ExchangeMailContact $contact $stats $true $existingHint $useExistingHint $existingProfileHint
      if ($contactPosition % 100 -eq 0) { Write-Host ("Reconciled {0} of {1} FCUNO contacts." -f $contactPosition, @($exchangeRows.Contacts).Count) }
    } catch {
      $contactLookupSnapshotCurrent = $false
      Add-FullSyncFailure $stats "Contact" $contact.DisplayName $contact.ExternalEmailAddress $_.Exception.Message
      Write-Warning ("Full reconciliation failed for contact {0}: {1}" -f $contact.DisplayName, $_.Exception.Message)
    }
  }

  $groupPosition = 0
  foreach ($group in @($exchangeRows.Groups)) {
    $groupPosition += 1
    try {
      Renew-ExchangeSyncLockIfDue
      $existingHint = Resolve-ExchangeDistributionGroupHint $group $distributionGroupLookup
      $existingProfileHint = if ($null -ne $existingHint) { Resolve-ExchangeGroupProfileHint $existingHint $groupProfileLookup } else { $null }
      $useExistingHint = $null -ne $existingHint -and $null -ne $existingProfileHint -and (Test-ExchangeDistributionGroupMatches $existingHint $group $existingProfileHint)
      if (-not $useExistingHint) { $groupLookupSnapshotCurrent = $false }
      $members = @($exchangeRows.Members | Where-Object { (Clean-Text $_.SourceGroupId) -eq (Clean-Text $group.SourceGroupId) })
      Sync-ExchangeGroupMembers $group $members $stats $true $existingHint $useExistingHint $existingProfileHint
    } catch {
      $groupLookupSnapshotCurrent = $false
      Add-FullSyncFailure $stats "Group" $group.GroupName $group.Alias $_.Exception.Message
      Write-Warning ("Full reconciliation failed for group {0}: {1}" -f $group.GroupName, $_.Exception.Message)
    }
  }

  $managedContacts = if ($contactLookupSnapshotCurrent) {
    @($exchangeMailContacts | Where-Object { (Clean-Text $_.CustomAttribute1) -eq $ManagedMarker })
  } else {
    @(Get-MailContact -ResultSize Unlimited -Filter "CustomAttribute1 -eq '$ManagedMarker'" -ErrorAction Stop)
  }
  Remove-StaleManagedExchangeContacts $managedContacts $exchangeRows $stats

  $desiredGroupSourceKeys = @{}
  $desiredGroupAliases = @{}
  foreach ($group in @($exchangeRows.Groups)) {
    $desiredGroupSourceKeys[(Clean-Text $group.SourceKey)] = $true
    $desiredGroupAliases[(Clean-Text $group.Alias).ToLowerInvariant()] = $true
  }
  $managedGroups = if ($groupLookupSnapshotCurrent) {
    @($exchangeDistributionGroups | Where-Object { (Clean-Text $_.CustomAttribute1) -eq $ManagedMarker })
  } else {
    @(Get-DistributionGroup -ResultSize Unlimited -Filter "CustomAttribute1 -eq '$ManagedMarker'" -ErrorAction Stop)
  }
  $reuseManagedGroupsForFinalCount = $true
  foreach ($managedGroup in $managedGroups) {
    Renew-ExchangeSyncLockIfDue
    $sourceKey = Clean-Text $managedGroup.CustomAttribute2
    $alias = (Clean-Text $managedGroup.Alias).ToLowerInvariant()
    $isDesired = ($sourceKey -and (Has-MapKey $desiredGroupSourceKeys $sourceKey)) -or ($alias -and (Has-MapKey $desiredGroupAliases $alias))
    if ($isDesired) { continue }
    $reuseManagedGroupsForFinalCount = $false
    try {
      $deleteIdentity = Get-ExchangeStrongCommandIdentity $managedGroup
      if (-not $deleteIdentity) { throw "The stale managed group has no immutable Exchange identity, so deletion was blocked." }
      Remove-DistributionGroup -Identity $deleteIdentity -Confirm:$false -ErrorAction Stop
      Renew-ExchangeSyncLockIfDue
      Confirm-ExchangeDistributionGroupDeletion $managedGroup $alias $sourceKey
      Increment-Stat $stats "removedGroups"
      Add-FullSyncMutationDetail `
        $stats `
        "Delete stale group" `
        "Group" `
        $managedGroup.DisplayName `
        $alias `
        $sourceKey `
        $(if (Get-ExchangeStrongCommandIdentity $managedGroup) { Get-ExchangeStrongCommandIdentity $managedGroup } else { Clean-Text $managedGroup.Identity }) `
        "Deleted the stale managed Exchange group and verified that its identity is absent." `
        @(
          "Group name: $(Clean-Text $managedGroup.DisplayName) -> (missing)",
          "Alias: $alias -> (missing)"
        )
    } catch {
      Add-FullSyncFailure $stats "Group" $managedGroup.DisplayName $alias ("Could not remove stale managed group: " + $_.Exception.Message)
    }
  }

  Renew-ExchangeSyncLockIfDue -Force
  $finalMailContacts = @(Get-MailContact -ResultSize Unlimited -ErrorAction Stop)
  Renew-ExchangeSyncLockIfDue
  $finalContactProfiles = @(Get-Contact -ResultSize Unlimited -ErrorAction Stop)
  Renew-ExchangeSyncLockIfDue
  $finalDistributionGroups = @(Get-DistributionGroup -ResultSize Unlimited -ErrorAction Stop)
  Renew-ExchangeSyncLockIfDue
  $finalGroupProfiles = @(Get-Group -ResultSize Unlimited -ErrorAction Stop)
  Renew-ExchangeSyncLockIfDue
  Confirm-FinalExchangeProjection $exchangeRows $finalMailContacts $finalContactProfiles $finalDistributionGroups $finalGroupProfiles $stats
  Confirm-FinalExchangeGroupMemberships $exchangeRows $stats

  Renew-ExchangeSyncLockIfDue -Force
  $script:CanonicalExchangeRows = $null
  $latestExchangeRows = Get-CanonicalExchangeRows
  $latestProjectionFingerprint = Get-CanonicalExchangeProjectionFingerprint $latestExchangeRows
  $latestQueueHighWater = Get-ExchangeQueueHighWater
  $sourceDrift = @(Get-ExchangeSourceCertificationDrift $initialProjectionFingerprint $initialQueueHighWater $latestProjectionFingerprint $latestQueueHighWater)
  if ($sourceDrift.Count -gt 0) {
    Add-FullSyncFailure `
      $stats `
      "Full address book" `
      "FCUNO changed during reconciliation" `
      "queue $initialQueueHighWater -> $latestQueueHighWater" `
      ("Final certification was not accepted because " + ($sourceDrift -join " and ") + ". Durable queue changes remain available for the next incremental run; rerun full reconciliation after FCUNO editing has stopped.")
  }

  Complete-FullExchangeQueueCertificationIfEligible $stats $initialQueueHighWater $initialProjectionFingerprint $sourceDrift | Out-Null

  return $stats
}

if ($LibraryOnly) { return }

$webhookPayload = Initialize-WebhookPayload $WebhookData
$script:CurrentSyncRequestedAt = Clean-Text (Get-MapValue $webhookPayload "requestedAt")
$syncMode = (Clean-Text $webhookPayload.syncMode).ToLowerInvariant()
if (-not $syncMode) { $syncMode = "incremental" }
$script:CurrentQueueRunId = Get-ExchangeQueueRunId $webhookPayload
$details = $null

try {
  if (-not (Acquire-ExchangeSyncLock $syncMode)) {
    $lockDenial = Get-ExchangeSyncLockDenial $syncMode
    if ([bool]$lockDenial.Fatal) {
      $details = New-FullSyncLockFailureDetails $lockDenial.Message
      throw $lockDenial.Message
    }
    Write-Output $lockDenial.Message
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
  Renew-ExchangeSyncLockIfDue -Force

  if ($syncMode -ne "full") {
    $details = Get-StatsObject (Invoke-IncrementalExchangeSync)
    Write-Output ("Exchange incremental sync summary: {0}" -f ($details | ConvertTo-Json -Compress))
    $outcome = Get-IncrementalSyncOutcome $details
    Save-SyncStatus $outcome.Status $outcome.Message $details
    if ([bool]$outcome.AlwaysNotify -or $WebhookData) {
      Send-ExchangeSyncNotification $outcome.Status $outcome.Message $details $webhookPayload
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
    Save-SyncStatus "failed" $syncError.Exception.Message $details
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
