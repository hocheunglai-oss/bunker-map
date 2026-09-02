import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  DEFAULT_BUYER_LOST_REASONS,
  DEFAULT_SUPPLIER_LOST_REASONS,
} from "../lib/spcLostReasons"
import {
  getDefaultSpcPermissionsForRole,
  getDefaultSpcLandingPath,
  SPC_PAGE_DEFINITIONS,
} from "../lib/spcPages"
import { firstPreviousSpcIdentityMatch } from "../lib/spcTodayEnquiries"

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

const migration = source("../supabase/migrations/20260831101207_add_spc_lost_reason_options.sql")
const baseline = source("../supabase/spc_schema.sql")
const lostPage = source("../app/spc/lost-record/page.tsx")
const lostLibrary = source("../lib/spcLostReasons.ts")
const enquiriesPage = source("../app/spc/enquiries/page.tsx")
const enquiriesRoute = source("../app/api/spc/enquiries/route.ts")
const todayPage = source("../app/spc/today-enquiries/page.tsx")
const todayLibrary = source("../lib/spcTodayEnquiries.ts")
const vesselIdentityLibrary = source("../lib/spcVesselIdentity.ts")
const todayRoute = source("../app/api/spc/today-enquiries/route.ts")

test("lost reason defaults preserve the approved buyer and supplier dictionaries", () => {
  assert.deepEqual([...DEFAULT_BUYER_LOST_REASONS], [
    "MINIMUM MARGIN",
    "CREDIT OR PAYMENT TERMS",
    "COVERAGE (SUPPLIER NOT COVERED)",
    "COVERAGE (LIMITED BY CUSTOMER)",
    "NOT TIMELY OFFERED",
    "DOUBLE TRADING",
    "T&C",
    "UNKNOWN",
  ])
  assert.deepEqual([...DEFAULT_SUPPLIER_LOST_REASONS], [
    "SUPPLIER NO AVAILS",
    "SUPPLIER LATE RESPONSE",
    "LIMITED SUPPLIER POOL - SIZE",
    "LIMITED SUPPLIER POOL - SPECS",
    "LIMITED SUPPLIER POOL - SPECIAL REQUIREMENTS",
    "UNABLE TO MEET REQUIRED OFFER TIMING",
    "SUPPLIER WITHDREW",
    "CREDIT OR COMPLIANCE",
    "OTHER",
  ])
})

test("lost reason storage is private, atomic, audited, and backup fenced", () => {
  for (const sql of [migration, baseline]) {
    assert.match(sql, /create table if not exists public\.spc_lost_reason_options/)
    assert.match(sql, /create or replace function public\.replace_spc_lost_reason_options/)
    assert.match(sql, /security invoker/)
    assert.match(sql, /Supplier lost reasons must include OTHER/)
    assert.match(sql, /alter table public\.spc_lost_reason_options enable row level security/)
    assert.match(sql, /revoke all(?: privileges)? on table public\.spc_lost_reason_options\s+from public, anon, authenticated/)
    assert.match(sql, /grant execute on function public\.replace_spc_lost_reason_options\(text, text\[\]\)[\s\S]*?to service_role/)
    assert.match(sql, /audit_enable_table\('public\.spc_lost_reason_options'/)
    assert.match(sql, /bunker_map_backup_epoch_fence[\s\S]*?on public\.spc_lost_reason_options/)
  }
  assert.match(source("../app/api/backups/bunker-map-drive/route.ts"), /key: "spcLostReasonOptions"[\s\S]*?table: "spc_lost_reason_options"/)
  assert.match(source("../lib/systemHealth.ts"), /key: "spcLostReasonOptions"[\s\S]*?table: "spc_lost_reason_options"/)
  assert.match(source("../scripts/validate-backup.mjs"), /key: "spcLostReasonOptions"[\s\S]*?table: "spc_lost_reason_options"[\s\S]*?introducedAt: SPC_LOST_REASON_OPTIONS_MIGRATION_HEAD/)
})

test("lost record enforces separate role-aware review and comments", () => {
  assert.match(lostPage, /EDIT LOST REASONS/)
  assert.match(lostPage, /BUYER LOST REASON/)
  assert.match(lostPage, /SUPPLIER LOST REASON/)
  assert.match(lostPage, /SPC COMMENTS/)
  assert.match(lostPage, /value="">BUYER REASON ACCEPTED<\/option>/)
  assert.match(lostPage, /draft\.supplierLostReason === "OTHER"/)
  assert.match(lostPage, /normalizedRole === "ADMIN" && canAccessSpcPage\(permissions, "spc-lost-record", "edit"\)/)
  assert.match(lostLibrary, /role !== "SUPPLIER TRADER" && role !== "ADMIN"/)
  assert.match(lostLibrary, /supplierLostReason === "OTHER" && !supplierLostReasonDetails/)
  assert.match(lostLibrary, /\.eq\("updated_at", existing\.updated_at\)/)
  assert.match(lostLibrary, /changed while you were editing/)
})

test("buyer outcome validation and SPC quick controls use the managed contracts", () => {
  assert.match(enquiriesRoute, /listSpcLostReasons\(session, request, "BUYER TRADER"\)/)
  assert.match(enquiriesRoute, /Select a valid buyer lost reason/)
  assert.match(enquiriesPage, /const vlsfoRemarkOptions: VlsfoMaxRemark\[\] = \["80cst min", "120cst max", "180cst max"\]/)
  assert.match(enquiriesPage, /"COQ REQUIRED", "30D QUALITY TIME BAR"/)
  assert.doesNotMatch(enquiriesPage, /const vlsfoRemarkOptions[^\n]*"80cst max"/)
})

test("Daily Briefing is restricted to supplier traders and admins", () => {
  const enquiryPage = SPC_PAGE_DEFINITIONS.find((definition) => definition.id === "spc-buyer-enquiries")
  const page = SPC_PAGE_DEFINITIONS.find((definition) => definition.id === "spc-today-enquiries")
  assert.equal(enquiryPage?.label, "NEW ENQUIRY")
  assert.equal(page?.label, "DAILY BRIEFING")
  assert.equal(page?.path, "/spc/today-enquiries")
  assert.match(enquiriesPage, /SPC NEW ENQUIRY/)
  assert.match(todayPage, /SPC DAILY BRIEFING/)

  const supplierPermissions = getDefaultSpcPermissionsForRole("SUPPLIER TRADER")
  const adminPermissions = getDefaultSpcPermissionsForRole("ADMIN")
  const buyerPermissions = getDefaultSpcPermissionsForRole("BUYER TRADER")
  assert.equal(supplierPermissions["spc-today-enquiries"], "edit")
  assert.equal(adminPermissions["spc-today-enquiries"], "edit")
  assert.equal(buyerPermissions["spc-today-enquiries"], "none")
  assert.equal(getDefaultSpcLandingPath(supplierPermissions), "/spc/today-enquiries")
  assert.match(todayRoute, /role !== "SUPPLIER TRADER" && role !== "ADMIN"/)
})

test("Daily Briefing is chronological, matches IMO before vessel, and supports bulk copy", () => {
  assert.match(todayLibrary, /\.gte\("created_at", start\)[\s\S]*?\.order\("created_at", \{ ascending: true \}\)/)
  assert.match(vesselIdentityLibrary, /return \[cleanImo \? `imo:\$\{cleanImo\}` : "", vessel \? `vessel:\$\{vessel\}` : ""\]/)
  assert.match(todayLibrary, /previousFixture: firstPreviousSpcIdentityMatch\(fixtureByIdentity, keys, row\.created_at\)/)
  assert.match(todayLibrary, /previousLost: firstPreviousSpcIdentityMatch\(lostByIdentity, keys, row\.created_at\)/)
  assert.match(vesselIdentityLibrary, /candidate\.at < beforeTime/)
  assert.doesNotMatch(todayLibrary, /\.lt\("created_at", start\)/)
  assert.match(todayPage, /COPY SELECTED/)
  assert.match(todayPage, /selectedEnquiries\.map\(\(enquiry\) => enquiry\.formattedText\)\.join\("\\n\\n"\)/)
  assert.match(todayPage, /PREVIOUS FIXTURE/)
  assert.match(todayPage, /PREVIOUS LOST RECORD/)
  assert.match(todayPage, /Asia\/Hong_Kong/)
})

test("Daily Briefing prefers an earlier IMO match over a newer vessel-name match", () => {
  const matches = new Map([
    ["imo:1234567", [{ at: Date.parse("2026-08-20T01:00:00Z"), value: "IMO MATCH" }]],
    ["vessel:test vessel", [{ at: Date.parse("2026-08-20T02:00:00Z"), value: "VESSEL MATCH" }]],
  ])
  assert.equal(
    firstPreviousSpcIdentityMatch(
      matches,
      ["imo:1234567", "vessel:test vessel"],
      "2026-08-20T03:00:00Z",
    ),
    "IMO MATCH",
  )
  assert.equal(
    firstPreviousSpcIdentityMatch(matches, ["imo:7654321", "vessel:test vessel"], "2026-08-20T03:00:00Z"),
    "VESSEL MATCH",
  )
})
