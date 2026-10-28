param(
  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path,
  [string]$OutputPath = '',
  [switch]$Check
)

# Offline deterministic assembly, not Azure publication. Whitelist exact pure
# AST definitions, never dot-source/evaluate the sync worker or its LibraryOnly
# mode (which would expose mutation/certification/notification helpers).
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath($RepositoryRoot)
$sourcePath=Join-Path $repo 'scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1'
$checkerPath=Join-Path $repo 'scripts/azure-automation/check-fcuno-outlook-addressbook.ps1'
$baselinePath=Join-Path $repo 'scripts/azure-automation/exchange-publication-baseline.json'
$configPath=Join-Path $repo 'config/fcunoConnections.ts'
if(-not $OutputPath) {$OutputPath=$checkerPath}
$baseline=Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json -AsHashtable
$sourceHash=(Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
if($baseline.sourcePath -cne 'scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1' -or
   $baseline.sourceSha256 -cne $sourceHash) {throw 'Worker bytes do not match the pinned publication baseline.'}
$configHash=(Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
$configUrl=[Uri]::new($configPath).AbsoluteUri
$nodeCode='import(process.argv[1]).then(m=>process.stdout.write(JSON.stringify(m.validateFcunoConnectionPolicy()))).catch(()=>process.exit(2))'
$configJson=& node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON -e $nodeCode $configUrl
if($LASTEXITCODE -ne 0) {throw 'Canonical connection policy could not be imported and validated.'}
$policy=$configJson | ConvertFrom-Json -AsHashtable
$exchange=$policy.exchangeAddressBook
if($null -eq $exchange -or $policy.supabase.projectRef -cne $baseline.supabaseProject -or
  $policy.vercel.productionOrigins[0] -cne $baseline.productionOrigin -or $exchange.tenantId -cne $baseline.azure.tenantId -or
  $exchange.runtimeVersion -cne $baseline.azure.runtimeVersion -or $exchange.exchangeModuleVersion -cne $baseline.azure.exchangeModuleVersion -or
  $exchange.appId -notmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or
  $exchange.organization -cne 'cosulich1.onmicrosoft.com' -or $exchange.addressBookDomain -cne $exchange.organization) {
  throw 'Canonical Exchange policy is incomplete or contradicts the verified publication identity.'
}
$parseErrors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count) {throw 'Worker source does not parse.'}
$defs=@{}
foreach($definition in $ast.FindAll({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  if($defs.ContainsKey($definition.Name)) {throw 'Worker has duplicate function definitions.'}
  $defs[$definition.Name]=$definition
}
$names=@(
  'Add-ExchangeLookupEntry','Build-ExchangeRows','Clean-Text','Get-CanonicalExchangeProjectionCounts','Get-CanonicalExchangeProjectionJson',
  'Get-CanonicalExchangeProjectionPayload','Get-ContactSourceKey','Get-EmbeddedContactValidEmails','Get-ExchangeAlias',
  'Get-ExchangeContactDirectoryName','Get-ExchangeContactProfileImmutableJoinKeys','Get-ExchangeDirectoryNameBase',
  'Get-ExchangeDistributionGroupMismatches','Get-ExchangeGroupDirectoryName','Get-ExchangeGroupMembershipMismatches',
  'Get-ExchangeGroupMembershipState','Get-ExchangeImmutableGroupJoinKeys','Get-ExchangeMailContactMismatches','Get-ExchangeStrongCommandIdentity',
  'Get-ExpectedExchangeGroupSmtpAddress','Get-GroupSourceKey','Get-MapValue','Get-NormalizedExchangeAddressBookDomain',
  'Get-RecipientEmail','Get-RequiredExchangeAddressBookDomain','Get-StableExchangeHash','Get-UniqueAlias','Get-UniqueExchangeDirectoryName',
  'Has-MapKey','Is-InternalContact','Is-InternalEmail','New-ExchangeContactProfileLookup','New-ExchangeDistributionGroupLookup',
  'New-ExchangeGroupProfileLookup','New-ExchangeMailContactLookup','Normalize-Email','Resolve-ExchangeContactProfileHint',
  'Resolve-ExchangeGroupProfileHint','Test-ExchangeDirectoryNameRequiresStableSuffix','Test-GuidText','Test-ValidEmail'
)
$builtins=@('Add-Member','ConvertTo-Json','ForEach-Object','Select-Object','Sort-Object','Where-Object','Write-Output')
$safeTypes=@('BitConverter','bool','DateTimeOffset','Guid','hashtable','Math','regex','string','StringComparison','System.Collections.IDictionary','System.Net.Mail.MailAddress','System.Security.Cryptography.SHA256','Text.Encoding')
$safeMethods=@('ComputeHash','Contains','ContainsKey','Create','Dispose','EndsWith','Equals','GetBytes','Matches','Min','new','Replace','Split','StartsWith','Substring','ToLowerInvariant','ToString','Trim','TrimEnd','TrimStart','TryParse')
$parts=[Collections.Generic.List[string]]::new()
foreach($name in ($names | Sort-Object)) {
  if(-not $defs.ContainsKey($name)) {throw "Allowlisted pure helper is missing: $name"}
  $definition=$defs[$name]
  foreach($command in $definition.FindAll({param($a) $a -is [Management.Automation.Language.CommandAst]},$true)) {
    $called=$command.GetCommandName()
    if(-not $called -or ($called -cnotin $names -and $called -cnotin $builtins)) {throw "Unapproved helper dependency in $name"}
    if($command.InvocationOperator -ne [Management.Automation.Language.TokenKind]::Unknown) {throw "Dynamic helper invocation in $name"}
  }
  foreach($type in $definition.FindAll({param($a) $a -is [Management.Automation.Language.TypeExpressionAst]},$true)) {
    if($type.TypeName.FullName -cnotin $safeTypes) {throw "Unapproved type in pure helper $name"}
  }
  foreach($method in $definition.FindAll({param($a) $a -is [Management.Automation.Language.InvokeMemberExpressionAst]},$true)) {
    if($method.Member -isnot [Management.Automation.Language.StringConstantExpressionAst] -or $method.Member.Value -cnotin $safeMethods) {throw "Unapproved method in pure helper $name"}
  }
  foreach($variable in $definition.FindAll({param($a) $a -is [Management.Automation.Language.VariableExpressionAst]},$true)) {
    if($variable.VariablePath.IsScript -and $variable.VariablePath.UserPath -cne 'script:ExchangeAddressBookDomain') {throw "Unapproved shared state in pure helper $name"}
  }
  # No AST helper should acquire hidden provider access via scriptblock execution,
  # script: credential state, I/O, reflection or runspace creation.
  if($definition.Extent.Text -match '(?i)\b(?:Invoke-Expression|ScriptBlock\]::Create|Start-Process|Invoke-WebRequest|Invoke-RestMethod|Get-Automation|System\.IO|\[IO\.|Runspace|Reflection|Add-Type)\b') {
    throw "Unsafe code in allowlisted helper $name"
  }
  $parts.Add($definition.Extent.Text)
}
$collisionAssignments=@($ast.EndBlock.Statements | Where-Object {
  $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -ceq '$ExchangeDirectoryNameCollisionSourceKeys'
})
if($collisionAssignments.Count -ne 1 -or $collisionAssignments[0].Right.Extent.Text -notmatch '(?s)^@\(\s*(?:"FCUNO_CONTACT:[a-z0-9]+"\s*)*\)$') {
  throw 'Worker directory-collision pin is not an allowlisted literal array.'
}
$generated=@(
  '# BEGIN GENERATED CURRENT CHECK HELPERS',
  '# Offline AST-selected pure helpers; exact bodies retain worker projection semantics.',
  ('$CurrentCheckVersion = ''fcuno-current-addressbook-check/2026-10-28.1'''),
  ('$CurrentCheckWorkerSourceSha256 = '''+$sourceHash+''''),
  ('$CurrentCheckConfigSha256 = '''+$configHash+''''),
  ('$CurrentCheckSupabaseOrigin = ''https://'+$policy.supabase.projectRef+'.supabase.co'''),
  ('$CurrentCheckExpectedAppId = '''+$exchange.appId+''''),
  ('$CurrentCheckTenantId = '''+$exchange.tenantId+''''),
  ('$CanonicalExchangeAddressBookDomain = '''+$exchange.addressBookDomain+''''),
  ('$ManagedMarker = ''FCUNO_SHARED_ADDRESSBOOK'''),
  $collisionAssignments[0].Extent.Text,
  ($parts -join "`n`n"),
  '# END GENERATED CURRENT CHECK HELPERS'
) -join "`n"
$template=[IO.File]::ReadAllText($checkerPath)
$pattern='(?s)# BEGIN GENERATED CURRENT CHECK HELPERS\r?\n.*?# END GENERATED CURRENT CHECK HELPERS'
if([regex]::Matches($template,$pattern).Count -ne 1) {throw 'Checker must contain exactly one generated helper marker pair.'}
$bundle=[regex]::Replace($template,$pattern,[Text.RegularExpressions.MatchEvaluator]{param($m) $generated}).Replace("`r`n","`n")
$bundleErrors=$null
[void][Management.Automation.Language.Parser]::ParseInput($bundle,[ref]$null,[ref]$bundleErrors)
if($bundleErrors.Count) {throw 'Generated checker does not parse.'}
if($Check) {
  if(-not [IO.File]::Exists($OutputPath) -or [IO.File]::ReadAllText($OutputPath) -cne $bundle) {throw 'Current checker bundle is stale or altered.'}
} else {
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath),$bundle,[Text.UTF8Encoding]::new($false))
}
Write-Output ('Current checker bundle verified: '+(Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant())
