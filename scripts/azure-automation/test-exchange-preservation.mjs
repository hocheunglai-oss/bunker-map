import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// Explicit test entrypoint, not an Azure publisher. Every PowerShell fixture
// imports -LibraryOnly and replaces external Exchange/database/SMTP boundaries.
const executable = process.env.FCUNO_PWSH_PATH || "pwsh"
const probe = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 15000 })
if (probe.error || probe.status !== 0) {
  throw new Error("PowerShell is required for the Exchange regression gate. Install pwsh or set FCUNO_PWSH_PATH to a trusted PowerShell executable; tests were not skipped.", { cause: probe.error })
}
const version = probe.stdout.trim()
if (!/^7\./.test(version)) throw new Error(`Exchange regression tests require PowerShell 7; found ${version}`)
console.log(`Isolated Exchange regression fixtures using PowerShell ${version}`)
const guardedFixture = `
$ErrorActionPreference = 'Stop'
function global:Invoke-RestMethod { throw 'TEST GUARD: unexpected network request' }
function global:Invoke-WebRequest { throw 'TEST GUARD: unexpected network request' }
function global:Connect-ExchangeOnline { throw 'TEST GUARD: unexpected Exchange connection' }
function global:Disconnect-ExchangeOnline { throw 'TEST GUARD: unexpected Exchange connection' }
function global:Get-AutomationVariable { throw 'TEST GUARD: no live Automation settings' }
function global:Send-MailMessage { throw 'TEST GUARD: unexpected email delivery' }
. $env:FCUNO_EXCHANGE_TEST_FILE
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`
for (const file of [
  "test-exchange-startup-retry.ps1",
  "test-exchange-connection-retry.ps1",
  "test-exchange-email-content.ps1",
  "test-exchange-alert-policy.ps1",
  "test-sync-fcuno-outlook-addressbook.ps1",
]) {
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(guardedFixture, "utf16le").toString("base64")], {
    stdio: "inherit",
    timeout: 60000,
    env: { ...process.env, FCUNO_EXCHANGE_TEST_FILE: fileURLToPath(new URL(file, import.meta.url)) },
  })
  if (result.error || result.status !== 0) throw new Error(`Exchange regression fixture failed: ${file}`, { cause: result.error })
}
