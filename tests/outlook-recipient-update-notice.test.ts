import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import { parse, type DefaultTreeAdapterMap } from "parse5"

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")

function inlineScript(html: string): string {
  const visit = (node: DefaultTreeAdapterMap["node"]): string | undefined => {
    if ("tagName" in node && node.tagName === "script" && !node.attrs.some((attr) => attr.name === "src")) {
      return node.childNodes.map((child) => "value" in child ? child.value : "").join("")
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) {
        const script = visit(child)
        if (script !== undefined) return script
      }
    }
  }
  const script = visit(parse(html))
  assert.ok(script, "the actual taskpane must include its inline script")
  return script
}

test("the fixture parses HTML script tags rather than filtering markup with a regexp", () => {
  assert.equal(inlineScript('<script src="office.js"></script><SCRIPT data-test="x">const ready = true;</SCRIPT >'), "const ready = true;")
})

function taskpaneResolver() {
  const htmlTemplate = source("app/api/outlook-addin/taskpane/route.ts").match(
    /const html = `([\s\S]*?)`\n\n  return new NextResponse\(html,/,
  )
  assert.ok(htmlTemplate)
  const templateBody = htmlTemplate[1].replace(/\$\{JSON\.stringify\([^)]+\)\}/g, '"https://fcuno.test/api"')
  const html = Function(`return \`${templateBody}\`;`)() as string
  const script = inlineScript(html)
  const functions = ["splitRecipientText", "addParsedRecipient", "resolveStoredRecipientRefs"].map((name) => {
    const match = script.match(new RegExp(`function ${name}\\([\\s\\S]*?\\) \\{[\\s\\S]*?\\n        \\}`))
    assert.ok(match, `${name} must come from the actual taskpane`)
    return match[0]
  }).join("\n")
  const state = {
    recipientMapLoaded: true,
    recipientMapFromNetwork: true,
    recipientMapExpiresAt: Date.now() + 60_000,
    recipientCertification: { sourceFingerprint: "a".repeat(64) },
    recipientsBySourceKey: {
      "contact:stable-id": { kind: "contact", sourceId: "stable-id", displayName: "Updated Person", emailAddress: "updated@example.invalid" },
    } as Record<string, unknown>,
  }
  const resolve = Function("state", `${functions}; return resolveStoredRecipientRefs;`)(state) as (template: unknown, field: string) => unknown
  const now = new Date().toISOString()
  const ref = { field: "to", position: 0, literal: "Updated Person", displayName: "Updated Person", sourceValue: "updated@example.invalid", kind: "contact", sourceId: "stable-id", resolvedAddress: "updated@example.invalid" as string | null, status: "resolved" }
  const template = {
    to: "Updated Person", cc: "", bcc: "",
    recipientResolution: {
      schema: "fcuno.outlook-template-recipient-resolution/v1", certificationRunId: "synthetic-run", certifiedAt: now, resolvedAt: now, sourceFingerprint: "a".repeat(64),
      refs: { to: [ref], cc: [], bcc: [] }, counts: { total: 1, resolved: 1, external: 0, ambiguous: 0, missing: 0 },
    },
  }
  return { state, template, ref, resolve }
}

test("pending contact edits explain synchronization without deleting or rebinding the recipient", () => {
  const f = taskpaneResolver()
  f.ref.status = "missing"
  f.ref.resolvedAddress = null
  f.template.recipientResolution.counts.resolved = 0
  f.template.recipientResolution.counts.missing = 1
  const before = structuredClone(f.template)
  assert.throws(() => f.resolve(f.template, "to"), /Wait for the address-book sync/)
  assert.deepEqual(f.template, before)
  assert.equal(f.ref.sourceId, "stable-id")
})

test("an absent projection is not reported as a deleted source and does not mutate the template", () => {
  const f = taskpaneResolver()
  delete f.state.recipientsBySourceKey["contact:stable-id"]
  const before = structuredClone(f.template)
  assert.throws(() => f.resolve(f.template, "to"), /cannot be verified.*Wait for synchronization/)
  assert.deepEqual(f.template, before)
})

test("a verified updated source is inserted under the same permanent identity", () => {
  const f = taskpaneResolver()
  assert.deepEqual(f.resolve(f.template, "to"), [{ displayName: "Updated Person", emailAddress: "updated@example.invalid" }])
  assert.equal(f.ref.sourceId, "stable-id")
  f.template.recipientResolution.counts.ambiguous = 1
  assert.throws(() => f.resolve(f.template, "to"), /needs verification/)
})

test("quoted names ending in a backslash do not consume the next bound recipient", () => {
  const f = taskpaneResolver()
  const name = 'Updated, "Quoted"; Name\\'
  const quoted = `"${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  f.ref.literal = `${quoted} <updated@example.invalid>`
  f.template.to = `${f.ref.literal}; Other Person <other@example.invalid>`
  f.template.recipientResolution.refs.to.push({ ...f.ref, position: 1, literal: "Other Person <other@example.invalid>", displayName: "Other Person", sourceId: "other-id", sourceValue: "other@example.invalid", resolvedAddress: "other@example.invalid" })
  f.template.recipientResolution.counts.total = 2
  f.template.recipientResolution.counts.resolved = 2
  f.state.recipientsBySourceKey["contact:other-id"] = { kind: "contact", sourceId: "other-id", displayName: "Other Person", emailAddress: "other@example.invalid" }
  assert.deepEqual(f.resolve(f.template, "to"), [
    { displayName: "Updated Person", emailAddress: "updated@example.invalid" },
    { displayName: "Other Person", emailAddress: "other@example.invalid" },
  ])
})

test("actual save API gives only a narrowly recognized source-sync conflict a safe 409", async () => {
  const controls: { error: unknown } = { error: null }
  class Conflict extends Error { code = "EMAIL_TEMPLATE_CONFLICT" }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "@/lib/emailTemplates": { EmailTemplateConflictError: Conflict, saveEmailTemplate: async () => { throw controls.error } },
    "@/lib/adminAudit": { createAdminAuditContext: () => ({ username: "synthetic" }) },
    "@/lib/adminAuth": { requireAdminPagePermission: async () => ({ username: "synthetic" }) },
    "@/lib/sharedAddressBookServer": {},
  }
  const fixtureModule = { exports: {} as { POST: (request: Request) => Promise<Response> } }
  const code = transformSync(source("app/api/admin/email-templates/route.ts"), { loader: "ts", format: "cjs", target: "node24" }).code
  Function("require", "module", "exports", code)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), name)
    return modules[name]
  }, fixtureModule, fixtureModule.exports)
  for (const [error, status] of [
    [{ code: "P0001", message: "OUTLOOK_TEMPLATE_SOURCE_SYNC_PENDING" }, 409],
    [{ code: "P0001", message: "OUTLOOK_TEMPLATE_SOURCE_SYNC_PENDING: private-source-id" }, 409],
    [{ code: "P0001", message: "OUTLOOK_TEMPLATE_SOURCE_SYNC_PENDING_OTHER: private-source-id" }, 500],
    [{ code: "40001", message: "OUTLOOK_TEMPLATE_SOURCE_SYNC_PENDING" }, 500],
    [{ code: "P0001", message: "OUTLOOK_TEMPLATE_RECIPIENT_EVIDENCE_STALE: private-source-id" }, 409],
    [{ code: "P0001", message: "OUTLOOK_TEMPLATE_RECIPIENT_EVIDENCE_STALE_OTHER: private-source-id" }, 500],
    [{ code: "P0001", message: "OTHER_ERROR: private-source-id" }, 500],
    [new Error("Unauthorized"), 401], [new Error("Forbidden"), 403],
    [new Conflict("Reload Outlook Templates"), 409],
  ] as const) {
    controls.error = error
    const response = await fixtureModule.exports.POST(new Request("https://fcuno.test/api/admin/email-templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save-template", template: { id: "synthetic-template" }, expectedRevision: 1 }) }))
    assert.equal(response.status, status)
    const body = await response.json()
    assert.doesNotMatch(JSON.stringify(body), /private-source-id|P0001|40001/)
    if (status === 409 && !(error instanceof Conflict)) {
      if (error.message.startsWith("OUTLOOK_TEMPLATE_RECIPIENT_EVIDENCE_STALE:")) {
        assert.equal(body.code, "OUTLOOK_TEMPLATE_RECIPIENT_EVIDENCE_STALE")
        assert.match(body.message, /verification changed/)
      } else {
        assert.equal(body.code, "OUTLOOK_TEMPLATE_SOURCE_SYNC_PENDING")
        assert.match(body.message, /waiting for address-book synchronization/)
      }
    }
  }
})
