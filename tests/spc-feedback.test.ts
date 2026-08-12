import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { getDefaultSpcPermissionsForRole, SPC_PAGE_DEFINITIONS } from "../lib/spcPages"

test("SPC feedback is available for submission to every built-in role", () => {
  const feedback = SPC_PAGE_DEFINITIONS.find((page) => page.id === "spc-feedback")
  assert.deepEqual(feedback, {
    id: "spc-feedback",
    label: "FEEDBACK",
    group: "trading",
    path: "/spc/feedback",
    matchPrefixes: ["/feedback", "/spc/feedback"],
  })
  assert.equal(getDefaultSpcPermissionsForRole("ADMIN")["spc-feedback"], "edit")
  assert.equal(getDefaultSpcPermissionsForRole("BUYER TRADER")["spc-feedback"], "edit")
  assert.equal(getDefaultSpcPermissionsForRole("SUPPLIER TRADER")["spc-feedback"], "edit")
})

test("SPC feedback page, API, audit map, and schema remain connected", () => {
  const page = readFileSync(new URL("../app/spc/feedback/page.tsx", import.meta.url), "utf8")
  const route = readFileSync(new URL("../app/api/spc/feedback/route.ts", import.meta.url), "utf8")
  const audit = readFileSync(new URL("../lib/spcAudit.ts", import.meta.url), "utf8")
  const migration = readFileSync(new URL("../supabase/migrations/20260812095000_create_spc_feedback.sql", import.meta.url), "utf8")

  assert.match(page, /Send Feedback/)
  assert.match(page, /All Feedback/)
  assert.match(route, /hasSpcPagePermission\(session, "spc-feedback", "edit"\)/)
  assert.match(audit, /"spc-feedback": "SPC FEEDBACK"/)
  assert.match(migration, /enable row level security/)
  assert.match(migration, /audit_enable_table\('public\.spc_feedback'/)
})
