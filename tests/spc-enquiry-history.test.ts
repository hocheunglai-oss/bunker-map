import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  spcVesselIdentitiesMatch,
  spcVesselIdentityKeysFromValues,
} from "../lib/spcVesselIdentity"

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

const historyRoute = source("../app/api/spc/enquiry-history/route.ts")
const historyLibrary = source("../lib/spcVesselHistory.ts")
const enquiriesPage = source("../app/spc/enquiries/page.tsx")
const fixturesPage = source("../app/spc/fixtures/page.tsx")
const fixturesLibrary = source("../lib/spcFixtures.ts")
const globalStyles = source("../app/globals.css")
const techStack = source("../app/spc/techstack/page.tsx")
const fixtureImoMigration = source("../supabase/migrations/20260902044945_add_spc_fixture_vessel_imo.sql")
const baselineSchema = source("../supabase/spc_schema.sql")

test("vessel history uses IMO first and normalized vessel fallback for legacy fixtures", () => {
  const target = spcVesselIdentityKeysFromValues("Cabo-Fuji", "9730878")

  assert.equal(
    spcVesselIdentitiesMatch(target, spcVesselIdentityKeysFromValues("RENAMED VESSEL", "9730878")),
    true,
  )
  assert.equal(
    spcVesselIdentitiesMatch(target, spcVesselIdentityKeysFromValues("CABO FUJI", "1234567")),
    false,
  )
  assert.equal(
    spcVesselIdentitiesMatch(target, spcVesselIdentityKeysFromValues("  cabo   fuji  ", "")),
    true,
  )
  assert.equal(
    spcVesselIdentitiesMatch(target, spcVesselIdentityKeysFromValues("CABO LUNA", "")),
    false,
  )
})

test("history endpoint is buyer-authorized, audited, and respects record-page permissions", () => {
  assert.match(historyRoute, /requireSpcPagePermission\("spc-buyer-enquiries", "view"\)/)
  assert.match(historyRoute, /spcPrivateJson/)
  assert.doesNotMatch(historyRoute, /NextResponse\.json/)
  assert.match(historyLibrary, /createSpcAuditContext\(session, request, "spc-buyer-enquiries"/)
  assert.match(historyLibrary, /action: "lookup-vessel-history"/)
  assert.match(historyLibrary, /hasSpcPagePermission\(session, "spc-fixtures", "view"\)/)
  assert.match(historyLibrary, /hasSpcPagePermission\(session, "spc-lost-record", "view"\)/)
})

test("history reads completed fixtures and lost enquiries instead of the current user's 200-row feed", () => {
  assert.match(historyLibrary, /\.from\("spc_fixtures"\)[\s\S]*?\.eq\("fixture_status", "completed"\)/)
  assert.match(historyLibrary, /\.from\("spc_enquiries"\)[\s\S]*?\.in\("status", \["quoted", "cancelled"\]\)/)
  assert.match(historyLibrary, /row\.status === "cancelled"/)
  assert.match(historyLibrary, /spcVesselIdentitiesMatch\(targetKeys/)
  assert.match(historyLibrary, /SUPPLIER NOT SET/)
  assert.match(historyLibrary, /collectCandidatePages/)
  assert.match(historyLibrary, /\.range\(from, to\)/)
  assert.doesNotMatch(historyLibrary, /\.limit\(100\)/)
  assert.doesNotMatch(enquiriesPage, /draftPreviousMatches/)
})

test("lost history identifies the buyer trader who marked the enquiry lost", () => {
  assert.match(historyLibrary, /created_by_username,/)
  assert.match(historyLibrary, /created_by_display_name,/)
  assert.match(
    historyLibrary,
    /operator: row\.created_by_display_name \|\| row\.created_by_username \|\| "UNKNOWN OPERATOR"/,
  )
  assert.match(
    enquiriesPage,
    /displayHistoryDate\(record\.date\)} · \{record\.operator} · \{record\.reason}/,
  )
})

test("future fixtures snapshot IMO while legacy fixtures remain on vessel-name fallback", () => {
  for (const sql of [fixtureImoMigration, baselineSchema]) {
    assert.match(sql, /vessel_imo text/)
    assert.match(sql, /vessel_imo is null or vessel_imo ~ '\^\[0-9\]\{7\}\$'/)
    assert.match(sql, /spc_fixtures_vessel_imo_idx/)
  }
  assert.doesNotMatch(fixtureImoMigration, /\bupdate\s+public\.spc_fixtures\b/i)
  assert.match(fixturesLibrary, /vessel_imo: cleanSpcImo\(meta\.imo \|\| parsed\.imo\) \|\| existingFixture\?\.vessel_imo \|\| null/)
  assert.match(fixturesLibrary, /vesselImo: row\.vessel_imo/)
  assert.match(historyLibrary, /\.eq\("vessel_imo", imo\)/)
  assert.match(historyLibrary, /spcVesselIdentityKeysFromValues\([\s\S]*?row\.vessel_imo,[\s\S]*?\)/)
  assert.doesNotMatch(historyLibrary, /row\.vessel_imo \|\| readSpcEnquiryMeta/)
  assert.match(fixturesPage, /<th>VESSEL<\/th>[\s\S]*?<th>IMO<\/th>/)
  assert.match(fixturesPage, /<td>\{fixture\.vesselImo \|\| "-"\}<\/td>/)
  assert.match(techStack, /FIXTURE IMO SNAPSHOT/)
})

test("new enquiry debounces and cancels stale vessel-history lookups", () => {
  assert.match(enquiriesPage, /api\/spc\/enquiry-history\?\$\{params\.toString\(\)\}/)
  assert.match(enquiriesPage, /new AbortController\(\)/)
  assert.match(enquiriesPage, /window\.setTimeout\(async \(\) => \{[\s\S]*?\}, 300\)/)
  assert.match(enquiriesPage, /controller\.abort\(\)/)
  assert.match(enquiriesPage, /sequence !== vesselHistoryLoadSequence\.current/)
  assert.match(enquiriesPage, /vesselHistoryLookupKey === currentVesselHistoryLookupKey/)
})

test("prominent fixed and lost history cards render beside NEW ENQUIRY", () => {
  assert.match(
    enquiriesPage,
    /spc-panel-header spc-enquiry-entry-header[\s\S]*?New Enquiry[\s\S]*?spc-vessel-history-summary/,
  )
  assert.match(enquiriesPage, /role="status" aria-live="polite"/)
  assert.match(enquiriesPage, /PREVIOUSLY FIXED/)
  assert.match(enquiriesPage, /PREVIOUSLY LOST/)
  assert.match(enquiriesPage, /NO PREVIOUS FIXED \/ LOST RECORD/)
  assert.match(globalStyles, /\.spc-vessel-history-card\.is-fixed[\s\S]*?background: #e8f7f1;[\s\S]*?color: #006b4f;/)
  assert.match(globalStyles, /\.spc-vessel-history-card\.is-lost,[\s\S]*?background: #fff0ef;[\s\S]*?color: #b42318;/)
  assert.match(globalStyles, /@media \(max-width: 760px\)[\s\S]*?\.spc-vessel-history-summary[\s\S]*?flex-direction: column;/)
})

test("AI FIX, REPORT, and SEND have larger distinct accessible icon controls", () => {
  assert.match(enquiriesPage, /spc-enquiry-command-button is-ai[\s\S]*?EnquiryCommandIcon kind="ai"[\s\S]*?<span>AI FIX<\/span>/)
  assert.match(enquiriesPage, /is-report[\s\S]*?EnquiryCommandIcon kind=\{reportButtonState/)
  assert.match(enquiriesPage, /is-send[\s\S]*?EnquiryCommandIcon kind="send"/)
  assert.match(enquiriesPage, /aria-hidden="true" focusable="false"/)
  assert.match(globalStyles, /\.spc-enquiry-command-row button \{[\s\S]*?min-height: 42px;[\s\S]*?font-size: 13px;/)
  assert.match(globalStyles, /\.spc-enquiry-command-button\.is-ai[\s\S]*?background: #e7f3ff;/)
  assert.match(globalStyles, /\.spc-enquiry-command-button\.is-report[\s\S]*?background: #fff8e6;/)
  assert.match(globalStyles, /\.spc-enquiry-command-row button:focus-visible/)
})

test("SPC Tech Stack documents the permission-aware vessel history endpoint", () => {
  assert.match(techStack, /PERMISSION-AWARE IMO-FIRST PREVIOUS FIXED \+ LOST LOOKUP/)
  assert.match(techStack, /API\/SPC\/ENQUIRY-HISTORY/)
})
