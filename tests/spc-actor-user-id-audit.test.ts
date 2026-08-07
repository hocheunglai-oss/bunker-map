import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const baseline = readFileSync(
  new URL("../supabase/audit_log.sql", import.meta.url),
  "utf8",
)
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260807090000_add_stable_spc_audit_actor_ids.sql",
    import.meta.url,
  ),
  "utf8",
)
const pgTap = readFileSync(
  new URL("../supabase/tests/spc_actor_user_id_audit_test.sql", import.meta.url),
  "utf8",
)
const auditSource = readFileSync(
  new URL("../lib/spcAudit.ts", import.meta.url),
  "utf8",
)
const auditModel = readFileSync(
  new URL("../lib/auditLog.ts", import.meta.url),
  "utf8",
)
const spcAuditRoute = readFileSync(
  new URL("../app/api/spc/audit-logs/route.ts", import.meta.url),
  "utf8",
)
const speedBoardRoute = readFileSync(
  new URL("../app/api/spc/chrome-extension/notify/route.ts", import.meta.url),
  "utf8",
)
const supplierSource = readFileSync(
  new URL("../lib/spcSuppliers.ts", import.meta.url),
  "utf8",
)

for (const [name, sql] of [
  ["baseline", baseline],
  ["forward migration", migration],
] as const) {
  test(`${name} captures and protects stable SPC audit actor ids`, () => {
    assert.match(sql, /actor_user_id uuid/)
    assert.match(sql, /x-bunker-audit-actor-user-id/)
    assert.match(sql, /create trigger capture_spc_audit_actor_user_id/)
    assert.match(sql, /create trigger protect_audit_actor_user_id/)
    assert.match(sql, /Audit actor user id is immutable\./)
    assert.doesNotMatch(sql, /actor_user_id uuid references public\.spc_users/)
  })
}

test("SPC audited writes propagate only the server-session UUID", () => {
  assert.match(auditSource, /actorUserId: requireAuditActorUserId\(session\.userId\)/)
  assert.match(auditSource, /"x-bunker-audit-actor-user-id": context\.actorUserId/)
  assert.match(auditSource, /actor_user_id: context\.actorUserId/)
  assert.match(speedBoardRoute, /actor_user_id: context\.actorUserId/)
  assert.match(supplierSource, /actor_user_id: context\.actorUserId/)
})

test("the SPC audit API returns stable attribution without replacing legacy actor fields", () => {
  assert.match(auditModel, /"actor_user_id"/)
  assert.match(auditModel, /actorUserId: row\.actor_user_id/)
  assert.match(spcAuditRoute, /actorUserId: visibleRecord\.actorUserId/)
  assert.match(spcAuditRoute, /actorId: visibleRecord\.actorId/)
  assert.match(spcAuditRoute, /actorName: visibleRecord\.actorName/)
})

test("pgTAP covers trusted capture, mismatch rejection, and immutability", () => {
  assert.match(pgTap, /has_column\([\s\S]*actor_user_id/)
  assert.match(pgTap, /the trusted request header becomes stable audit attribution/)
  assert.match(pgTap, /an explicit value cannot contradict the server-trusted session identity/)
  assert.match(pgTap, /stable audit attribution cannot be modified/)
})
