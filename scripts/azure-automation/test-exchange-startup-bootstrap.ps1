param()

$ErrorActionPreference = "Stop"
# Join-Path belongs to Management. Load it before disabling all implicit imports
# so this regression isolates the HTTP exception's explicit Utility bootstrap.
Import-Module Microsoft.PowerShell.Management -NoClobber -ErrorAction Stop
$PSModuleAutoLoadingPreference = "None"

function global:Invoke-RestMethod { throw "TEST GUARD: unexpected network request" }
function global:Invoke-WebRequest { throw "TEST GUARD: unexpected network request" }
function global:Connect-ExchangeOnline { throw "TEST GUARD: unexpected Exchange connection" }
function global:Disconnect-ExchangeOnline { throw "TEST GUARD: unexpected Exchange connection" }
function global:Get-AutomationVariable { throw "TEST GUARD: no live Automation settings" }
function global:Send-MailMessage { throw "TEST GUARD: unexpected email delivery" }

$script:UtilityBootstrapImports = 0
function global:Import-Module {
  [CmdletBinding()]
  param([string[]]$Name, [switch]$NoClobber)

  if ($Name.Count -ne 1 -or $Name[0] -ne "Microsoft.PowerShell.Utility") {
    throw "FAILED: the startup fixture requested an unexpected module"
  }
  if (-not $NoClobber) { throw "FAILED: explicit Utility loading must preserve the network guards" }

  $restGuard = (Get-Command Invoke-RestMethod -CommandType Function).ScriptBlock
  $webGuard = (Get-Command Invoke-WebRequest -CommandType Function).ScriptBlock
  Microsoft.PowerShell.Core\Import-Module @PSBoundParameters
  if (-not [object]::ReferenceEquals($restGuard, (Get-Command Invoke-RestMethod -CommandType Function).ScriptBlock) -or
      -not [object]::ReferenceEquals($webGuard, (Get-Command Invoke-WebRequest -CommandType Function).ScriptBlock)) {
    throw "FAILED: explicit Utility loading replaced a network guard"
  }
  $script:UtilityBootstrapImports++
}

# Run all existing startup assertions unchanged in this fresh, non-autoloading
# process. Counting the import also catches a missing bootstrap on runtimes that
# eagerly load the Utility assembly before a script starts (including this Mac).
. ([System.IO.Path]::Combine($PSScriptRoot, "test-exchange-startup-retry.ps1"))
if ($script:UtilityBootstrapImports -ne 1) {
  throw "FAILED: the startup fixture must explicitly load Utility exactly once"
}
if ($null -eq ("Microsoft.PowerShell.Commands.HttpResponseException" -as [type])) {
  throw "FAILED: the real PowerShell HTTP exception type is unavailable"
}
Write-Output "PASS: Exchange startup explicitly loads the real HTTP exception with autoloading disabled and preserves network guards."
