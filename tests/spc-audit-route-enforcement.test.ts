import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const passwordRoute = readFileSync(
  new URL("../app/api/spc/password/route.ts", import.meta.url),
  "utf8",
)
const auditRoute = readFileSync(
  new URL("../app/api/spc/audit-logs/route.ts", import.meta.url),
  "utf8",
)

test("authenticated self-password failures append constrained evidence without credentials", () => {
  const contextIndex = passwordRoute.indexOf("auditContext = createSpcAuditContext")
  const bodyIndex = passwordRoute.indexOf("await request.json()")

  assert.ok(contextIndex > 0)
  assert.ok(bodyIndex > contextIndex)
  assert.match(passwordRoute, /action: "change-password"/)
  assert.match(passwordRoute, /targetUsername: session\.username/)
  assert.match(passwordRoute, /passwordChanged: true/)
  assert.match(passwordRoute, /outcome: "failed"/)
  assert.match(passwordRoute, /recordSpcUserManagementAuditEvent/)
  assert.doesNotMatch(
    passwordRoute,
    /(?:errorCode|targetId|targetUsername|approvalReference):\s*password\b/,
  )
})

test("SPC user-management undo records denied and failed outcomes and sends rich audit headers", () => {
  assert.match(auditRoute, /if \(!hasSpcPagePermission\(session, "spc-audit-log", "edit"\)\)/)
  assert.match(auditRoute, /action: "undo-user-management-audit"/)
  assert.match(auditRoute, /outcome: "denied"/)
  assert.match(auditRoute, /outcome: "failed"/)
  assert.match(auditRoute, /errorCode: "not_undoable"/)
  assert.match(auditRoute, /recordSpcUserManagementAuditEvent/)
  assert.match(
    auditRoute,
    /undoAuditLog\([\s\S]*?auditContext \|\| undefined,\s*\)/,
  )
})

test("SPC audit responses gate user-management investigation identifiers on ADMIN", () => {
  assert.match(auditRoute, /const viewerIsAdmin = hasSpcRole\(session, "ADMIN"\)/)
  assert.match(auditRoute, /redactSpcUserManagementInvestigation/)
  assert.match(
    auditRoute,
    /presentAuditLogForClient\(presented, true, viewerIsAdmin\)/,
  )
})

test("retired WhatsApp test history remains discoverable only to ADMIN audit viewers", () => {
  assert.match(auditRoute, /"spc-mfa-test": \["spc_mfa_test_events"\]/)
  assert.match(auditRoute, /record\.pageId !== "spc-mfa-test"/)
  assert.match(
    auditRoute,
    /viewerIsAdmin \? RETIRED_ADMIN_AUDIT_PAGES : \[\]/,
  )
})
