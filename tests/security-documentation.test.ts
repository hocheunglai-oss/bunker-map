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
  for (const lifecycleFact of [
    "SPC system incident lifecycle",
    "Received",
    "Triaged",
    "Contained",
    "Eradicated and recovered",
    "Vulnerability lifecycle",
    "Independently retested",
    "Technical change evidence record",
    "both production `/api/deploy-info` revisions",
  ]) {
    assert.match(
      runbook,
      new RegExp(lifecycleFact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    )
  }
  assert.match(runbook, /No incident SLA, accountable owner or evidence-retention period is created/)
  assert.match(runbook, /No remediation SLA, fixed severity owner or evidence-retention period is created/)
  assert.match(runbook, /does not assign an owner, approve risk, promise a deadline or create a retention rule/)
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
    "Meta / WhatsApp Cloud API",
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
  assert.match(checklist, /Actions SHA pinning is required/)
  assert.match(checklist, /blocks force pushes\/deletion/)
  assert.match(checklist, /CodeQL default setup is enabled, its initial multi-language analysis completed successfully/)
  assert.match(checklist, /every initial alert was triaged/)
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

test("restricted generated NIS2 evidence is ignored without broadly ignoring output", async () => {
  const gitignore = await read(".gitignore")

  assert.match(gitignore, /^\/output\/pdf\/nis2-security-evidence-\*\/$/m)
  assert.doesNotMatch(gitignore, /^\/output\/?$/m)
})

test("security evidence index maps every signed finding and workbook package without self-approval", async () => {
  const evidenceIndex = normalized(
    await read("docs/spc-security-evidence-index.md"),
  )

  for (const finding of [
    "W-01",
    "W-02",
    "B-01",
    "B-02",
    "B-03",
    "B-04",
    "B-05",
    "B-06",
    "B-07",
    "B-08",
    "W-03",
  ]) {
    assert.match(evidenceIndex, new RegExp(`\\b${finding}\\b`))
  }
  for (const evidencePackage of [
    "E-01",
    "E-02",
    "E-03",
    "E-04",
    "E-05",
    "E-06",
    "E-07",
    "E-08",
    "E-09",
    "E-10",
    "E-11",
    "E-12",
    "E-13",
    "E-14",
    "E-15",
    "E-16",
  ]) {
    assert.match(evidenceIndex, new RegExp(`\\b${evidencePackage}\\b`))
  }
  assert.match(evidenceIndex, /Collection UTC/)
  assert.match(evidenceIndex, /full deployed commit SHA/)
  assert.match(evidenceIndex, /Technical reviewer/)
  assert.match(evidenceIndex, /Group Information Security reviewer/)
  assert.match(evidenceIndex, /Appointed assessor/)
  assert.match(evidenceIndex, /Pending risk and decision register/)
  assert.match(evidenceIndex, /R-08 \| Independent authenticated W-01\/W-02 retest and signed closure \| Open \| Pending \| Pending \| Pending/)
  assert.match(evidenceIndex, /Neither repository tests, a deployment, this index nor the service-owner workbook can provide that approval/)
  assert.match(evidenceIndex, /only the appointed assessor can close the corresponding signed-report finding/)
})

test("sanitized SPC system inventory records confirmed boundaries and pending ownership", async () => {
  const inventory = normalized(await read("docs/spc-system-inventory.md"))

  for (const fact of [
    "https://fcuno.com",
    "https://spc.fcuno.com",
    "Next.js 16",
    "React 19",
    "Node.js 24",
    "PostgreSQL 17.6.1",
    "ap-south-1",
    "ADMIN",
    "spc-user-management",
    "35-day managed window",
    "no project log drain was observed",
  ]) {
    assert.ok(inventory.toLowerCase().includes(fact.toLowerCase()))
  }
  assert.match(inventory, /contains no credential values, user records, message content/)
  assert.match(inventory, /Service owner \| Pending management confirmation/)
  assert.match(inventory, /Technical owner \| Pending management confirmation/)
  assert.match(inventory, /do not silently convert a `Pending` item into an approved fact/)
})
