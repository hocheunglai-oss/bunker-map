import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

async function read(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
}

function normalized(value: string) {
  return value.replace(/\s+/g, " ")
}

test("repository security reporting uses the published contact without making an SLA commitment", async () => {
  const [securityPolicy, securityTxt] = await Promise.all([
    read("SECURITY.md"),
    read("public/.well-known/security.txt"),
  ])
  const publishedContact = securityTxt.match(/^Contact: mailto:(.+)$/m)?.[1]

  assert.equal(publishedContact, "info@cosulich.it")
  assert.match(securityPolicy, /`info@cosulich\.it`/)
  assert.match(securityPolicy, /Do not include passwords, session tokens, private keys/)
  assert.match(
    securityPolicy,
    /does not promise a response time, remediation deadline, safe-harbour/,
  )
  assert.match(
    securityPolicy,
    /Only Group Information Security[\s\S]*may approve closure or risk acceptance/,
  )
})

test("SPC operations runbook preserves technical facts and leaves policy decisions open", async () => {
  const runbook = normalized(await read("docs/spc-security-operations-runbook.md"))

  for (const fact of [
    "Automatic 30-day retention",
    "Fixed 12-hour validity",
    "35-day managed window",
    "fewer than 90 days remain",
    "targeted authenticated retest",
  ]) {
    assert.match(runbook, new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))
  }
  for (const openControl of [
    "MFA",
    "public trial portal",
    "GDPR deletion/DSR",
    "SIEM/log drains",
    "WAF/bot policy",
  ]) {
    assert.match(runbook, new RegExp(openControl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))
  }
  assert.match(runbook, /Deletion\/retention period is not approved/)
  assert.match(runbook, /Summarise outcomes by control theme/)
})

test("provider checklist separates observed controls from external validation", async () => {
  const checklist = await read("docs/spc-provider-security-validation.md")

  for (const provider of [
    "Vercel",
    "Supabase",
    "GitHub",
    "Name.com",
    "Google Workspace / Drive",
    "Microsoft 365 / Graph / Exchange",
    "Azure Automation",
    "OpenAI API",
    "Google AI / Gemini",
    "MapTiler / OpenStreetMap",
    "ICE",
    "TradingView",
  ]) {
    assert.match(
      checklist,
      new RegExp(provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    )
  }
  assert.match(checklist, /Firewall\/WAF rules/)
  assert.match(checklist, /Attack Mode/)
  assert.match(checklist, /RLS status, table grants, function execution grants/)
  assert.match(checklist, /Not verified[\s\S]*must not be interpreted as either compliant or non-compliant/)
})

test("audit documentation records rich SPC evidence without inventing retention", async () => {
  const auditDocumentation = normalized(await read("docs/audit-log-system.md"))

  for (const field of [
    "authenticated actor and role",
    "trusted source IP",
    "controlled action",
    "target",
    "outcome",
    "correlation ID",
    "platform request ID",
    "credential material are redacted",
    "append-only",
  ]) {
    assert.match(
      auditDocumentation,
      new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    )
  }
  assert.match(auditDocumentation, /does not establish an approved audit-retention period/)
})
