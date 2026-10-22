param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'sync-fcuno-outlook-addressbook.ps1') -LibraryOnly

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "FAILED: $Message" }
}
function Get-AutomationSetting($Name) {
  if ($Name -eq 'NEXT_PUBLIC_SUPABASE_URL') { return 'https://synthetic.invalid' }
  if ($Name -eq 'SUPABASE_SERVICE_ROLE_KEY') { return $script:SyntheticKey }
  throw 'Unexpected synthetic setting'
}
function Invoke-RestMethod($Method, $Uri, $Headers, $Body, $ConnectionTimeoutSeconds, $OperationTimeoutSeconds) {
  $script:Requests.Add([pscustomobject]@{
    Method = $Method; Uri = $Uri; Headers = $Headers; Body = $Body
    Connection = $ConnectionTimeoutSeconds; Operation = $OperationTimeoutSeconds
  })
  return [pscustomobject]@{ ok = $true }
}
$script:SyntheticKey = 'synthetic-legacy-key-not-real'
$script:Requests = [System.Collections.Generic.List[object]]::new()
Invoke-SupabaseRest -Method GET -Path 'synthetic' | Out-Null
Invoke-SupabaseRest -Method POST -Path 'rpc/synthetic' -Body @{ value = 1 } | Out-Null
Invoke-SupabaseRest -Method PATCH -Path 'synthetic?id=eq.fixture' -Body @{ value = 2 } | Out-Null
foreach ($request in $script:Requests) {
  Assert-True ($request.Connection -eq 60 -and $request.Operation -eq 60) 'Both REST paths must have conservative finite60s connection and idle-read defaults'
  Assert-True ($request.Uri.StartsWith('https://synthetic.invalid/rest/v1/')) 'The REST origin/path contract must remain unchanged'
  Assert-True ($request.Headers.apikey -ceq $script:SyntheticKey) 'The same synthetic key must remain in apikey'
  Assert-True ($request.Headers.Authorization -ceq "Bearer $script:SyntheticKey") 'Legacy authentication must remain unchanged'
  Assert-True ($request.Headers.'User-Agent' -ceq 'fcuno-azure-automation-runbook/1.0') 'The existing user-agent must remain unchanged'
}
Assert-True ($script:Requests[1].Headers.Prefer -ceq 'resolution=merge-duplicates') 'POST idempotency preference must remain unchanged'
Assert-True ($script:Requests[2].Headers.Prefer -ceq 'return=representation') 'PATCH acknowledgement preference must remain unchanged'
Assert-True (($script:Requests[1].Body | ConvertFrom-Json).value -eq 1) 'The body must retain the existing JSON serialization'

$script:SyntheticKey = 'sb_secret_synthetic-not-real'
Invoke-SupabaseRest -Method GET -Path 'synthetic' -ConnectionTimeoutSeconds 1 -OperationTimeoutSeconds 2 | Out-Null
$last = $script:Requests[$script:Requests.Count - 1]
Assert-True ($last.Connection -eq 1 -and $last.Operation -eq 2) 'Only explicit internal test/caller limits may shorten the defaults'
Assert-True (-not $last.Headers.ContainsKey('Authorization')) 'Modern secret-key authentication must not gain a Bearer header'
Write-Output 'PASS: Supabase REST has finite connection and idle-read limits without changing origin, authentication, JSON or acknowledgement headers.'
