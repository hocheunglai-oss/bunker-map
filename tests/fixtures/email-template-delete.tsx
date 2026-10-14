import React from "react"
import { createRoot } from "react-dom/client"
import EmailTemplatesAdminPage from "../../app/admin/emailtemplates/page"

const template = (id: string, title: string) => ({
  id, title, subject: `${title} subject`, folder: "Outgoing / Bunker", sourcePath: "", from: "",
  to: "synthetic@example.test", cc: "", bcc: "", bodyHtml: "<p>Synthetic body</p>", bodyText: "Synthetic body",
  tags: ["Outgoing", "Bunker"], slug: id, isActive: true, placeholders: [], recipientResolution: {},
  updatedAt: "2026-10-14T00:00:00.000Z", revision: 1,
})
const harness = {
  templates: [template("synthetic-a", "Synthetic A"), template("synthetic-b", "Synthetic B"), template("synthetic-c", "Synthetic C")],
  requests: [] as { action?: string; id?: string; template?: ReturnType<typeof template>; expectedRevision?: number }[],
  failSaveIds: new Set<string>(), failDelete: false, deferSave: false, releaseSave: null as null | (() => void),
  concurrentDelete: false, conflictSave: false,
}
Object.assign(window, { __templateDeleteHarness: harness })
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.origin !== location.origin || url.pathname !== "/api/admin/email-templates") throw Error(`Unexpected fixture request: ${url.pathname}`)
  if ((init.method || "GET") === "GET") {
    const id = url.searchParams.get("id")
    if (id) { const row = harness.templates.find(row => row.id === id); return Response.json(row ? { template: row } : { message: "Template not found." }, { status: row ? 200 : 404 }) }
    if (url.searchParams.get("mode") === "recipients") return Response.json({ contacts: [], groups: [] })
    return Response.json({ templates: harness.templates, lastImportedAt: null, lastUpdatedAt: null, revision: "a".repeat(64) })
  }
  const body = JSON.parse(String(init.body))
  harness.requests.push(body)
  if (body.action === "save-template") {
    if (harness.deferSave) { harness.deferSave = false; await new Promise<void>(resolve => { harness.releaseSave = () => { harness.releaseSave = null; resolve() } }) }
    if (harness.failSaveIds.has(body.template.id)) return Response.json({ message: "Template action failed." }, { status: 500 })
    const row = harness.templates.find(row => row.id === body.template.id)
    if (harness.conflictSave && row) { row.revision += 1; row.title = "Concurrent server change"; return Response.json({ code: "EMAIL_TEMPLATE_CONFLICT", message: "Template changed during save." }, { status: 409 }) }
    if (!row || row.revision !== body.expectedRevision) return Response.json({ code: "EMAIL_TEMPLATE_CONFLICT", message: "Template changed." }, { status: 409 })
    Object.assign(row, body.template, { revision: row.revision + 1, updatedAt: new Date().toISOString() })
    return Response.json({ template: row, lastUpdatedAt: row.updatedAt })
  }
  if (body.action === "delete-template") {
    const row = harness.templates.find(row => row.id === body.id)
    if (harness.failDelete) return Response.json({ message: "Synthetic deletion failure. Please retry." }, { status: 500 })
    if (harness.concurrentDelete && row) { row.revision += 1; row.title = "Concurrent server change" }
    if (row && row.revision !== body.expectedRevision) return Response.json({ code: "EMAIL_TEMPLATE_CONFLICT", message: "Template changed before deletion." }, { status: 409 })
    harness.templates = harness.templates.filter(row => row.id !== body.id)
    return Response.json({ id: body.id, lastUpdatedAt: new Date().toISOString() })
  }
  throw Error(`Unexpected fixture action: ${body.action}`)
}
createRoot(document.getElementById("root")!).render(<EmailTemplatesAdminPage />)
