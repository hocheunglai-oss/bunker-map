import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { HOLIDAY_COUNTRIES } from "../data/publicHolidays"
import type { OfficeCalendarEvent } from "../data/eventCalendar"
import { getVerifiedPublicHolidays, parseHolidayRequest, type HolidayCalendarEvent } from "../lib/holidayCalendar"
import { planHolidayReconciliation } from "../lib/eventCalendarImport"

const reference = getVerifiedPublicHolidays([2026, 2027], [...HOLIDAY_COUNTRIES])
function legacy(country: string, date: string, title?: string): OfficeCalendarEvent {
  const label = { HK: "HONG KONG", US: "USA", SG: "SINGAPORE", TW: "TAIWAN" }[country]
  return { id: `public-holiday-${country.toLowerCase()}-${date}`, startDate: date, endDate: date,
    title: title || `PUBLIC HOLIDAY - ${label}`, people: [], uncertainPeople: [], tags: ["public-holiday", country], eventType: "Public Holiday" }
}
function plan(events: OfficeCalendarEvent[], deletedEventIds: string[] = []) {
  return planHolidayReconciliation(events, reference.events, { coverage: reference.coverage, deletedEventIds })
}
function apply(current: OfficeCalendarEvent[], changes: ReturnType<typeof plan>) {
  const next = current.filter((event) => !changes.removals.includes(event.id)).map((event) => changes.updates.find((next) => next.id === event.id) || event)
  return [...next, ...changes.additions]
}

test("reviewed coverage is explicit for every country/year, with unique stable identities", () => {
  assert.equal(reference.complete, true)
  assert.deepEqual(reference.coverage.map((row) => [row.country, row.year, row.eventCount]), [
    ["HK", 2026, 17], ["SG", 2026, 11], ["TW", 2026, 22], ["US", 2026, 11],
    ["HK", 2027, 17], ["SG", 2027, 11], ["TW", 2027, 24], ["US", 2027, 11],
  ])
  assert.equal(new Set(reference.events.map((event) => event.id)).size, reference.events.length)
  for (const event of reference.events) {
    assert.equal(new Date(`${event.startDate}T00:00:00Z`).toISOString().slice(0, 10), event.startDate)
    assert.equal(event.startDate, event.endDate)
    assert.ok(event.holidaySource.sourceUrls.length)
    assert.ok(!event.id.endsWith(event.startDate))
  }
})

test("unknown coverage stays unavailable and malformed selections never default to every country", () => {
  const result = getVerifiedPublicHolidays([2027, 2028], ["TW", "SG"])
  assert.equal(result.complete, false)
  assert.equal(result.coverage.filter((item) => item.status === "unavailable").length, 2)
  assert.ok(result.events.every((event) => event.startDate.startsWith("2027")))
  assert.throws(() => parseHolidayRequest("2026", "XX"), /Choose Hong Kong/)
  assert.throws(() => parseHolidayRequest([], ["HK"]), /valid calendar years/)
  assert.throws(() => parseHolidayRequest("2026,not-a-year", "US"), /valid calendar years/)
  assert.deepEqual(parseHolidayRequest(null, "HK", new Date("2026-12-31T17:00:00Z")).years, [2027, 2028])
})

test("US Bank calendar follows Federal Reserve Saturday and Sunday rules and excludes regional extras", () => {
  const usa = reference.events.filter((event) => event.holidaySource.country === "US")
  for (const date of ["2026-02-12", "2026-04-03", "2026-05-08", "2027-02-12", "2027-03-26", "2027-05-08", "2026-07-03", "2027-06-18", "2027-12-24", "2027-12-31"]) {
    assert.ok(!usa.some((event) => event.startDate === date))
  }
  for (const date of ["2026-10-12", "2027-10-11", "2026-07-04", "2027-06-19", "2027-07-05", "2027-12-25"]) {
    assert.ok(usa.some((event) => event.startDate === date))
  }
  assert.ok(usa.every((event) => event.title.startsWith("BANK HOLIDAY - USA (FEDERAL RESERVE)")))
  assert.ok(usa.every((event) => event.holidaySource.sourceUrls.includes("https://www.federalreserve.gov/aboutthefed/k8.htm")))
})

test("bank scope moves former federal-office imports in place and honors old-date deletions", () => {
  const current = [legacy("US", "2026-07-03"), legacy("US", "2027-06-18"), legacy("US", "2027-12-24")]
  const changes = plan(current)
  assert.deepEqual(changes.updates.filter((event) => current.some((old) => old.id === event.id)).map((event) => event.startDate), ["2026-07-04", "2027-06-19", "2027-12-25"])
  const suppressed = plan([], current.map((event) => event.id))
  assert.ok(!suppressed.additions.some((event) => ["us-2026-independence", "us-2027-juneteenth", "us-2027-christmas"].includes(event.holidaySource.identity)))
})

test("retired 2027 federal-office New Year is removed only when its old managed baseline is unchanged", () => {
  const desired = reference.events.find((event) => event.holidaySource.identity === "us-2027-new-year")!
  const retired: HolidayCalendarEvent = { ...desired, id: "public-holiday-us-2027-next-new-year-observed", startDate: "2027-12-31", endDate: "2027-12-31", title: "PUBLIC HOLIDAY - USA (FEDERAL) - NEW YEAR'S DAY 2028 (OBSERVED)", holidaySource: { ...desired.holidaySource, identity: "us-2027-next-new-year-observed", revision: "2026-10-07.1", deletionIds: ["public-holiday-us-2027-next-new-year-observed"], baseline: "" } }
  retired.holidaySource.baseline = JSON.stringify({ startDate: retired.startDate, endDate: retired.endDate, title: retired.title, tags: [...retired.tags].sort(), eventType: retired.eventType, people: [], uncertainPeople: [], sourceRow: null })
  assert.ok(plan([retired]).removals.includes(retired.id))
  const edited = { ...retired, people: ["CY"] }
  assert.ok(!plan([edited]).removals.includes(retired.id))
  assert.equal(plan([edited]).preserved.find((row) => row.id === edited.id)?.reviewRequired, true)
})

test("Singapore stale estimates are absent and observed Sundays have correct replacements", () => {
  const sg = reference.events.filter((event) => event.holidaySource.country === "SG")
  for (const date of ["2026-03-21", "2027-10-28", "2026-06-01", "2026-08-10", "2026-11-09", "2027-02-08"]) assert.ok(sg.some((event) => event.startDate === date))
  for (const date of ["2026-03-20", "2027-10-29"]) assert.ok(!sg.some((event) => event.startDate === date))
})

test("HK official substitute/lunar-day labels remain exclusive to HK attendance", () => {
  const hk = reference.events.filter((event) => event.holidaySource.country === "HK")
  assert.match(hk.find((event) => event.startDate === "2026-04-07")!.title, /DAY FOLLOWING EASTER MONDAY/)
  assert.match(hk.find((event) => event.startDate === "2027-02-08")!.title, /THIRD DAY/)
  assert.match(hk.find((event) => event.startDate === "2027-02-09")!.title, /FOURTH DAY/)
  assert.ok(reference.events.filter((event) => event.holidaySource.country !== "HK").every((event) => !event.title.startsWith("HOLIDAY ATTENDANCE")))
})

test("Taiwan includes named weekends and government substitute days, not ordinary weekends", () => {
  const tw = reference.events.filter((event) => event.holidaySource.country === "TW")
  for (const date of ["2026-02-15", "2026-02-20", "2026-02-27", "2026-04-03", "2026-10-26", "2027-02-09", "2027-02-10", "2027-03-01", "2027-04-06", "2027-04-30", "2027-12-31"]) assert.ok(tw.some((event) => event.startDate === date))
  assert.ok(!tw.some((event) => event.startDate === "2027-01-02"))
  assert.ok(tw.every((event) => event.title.startsWith("GOVERNMENT HOLIDAY - TAIWAN")))
})

test("known pristine stale dates are repaired, exact obsolete US dates removed, second pass is empty", () => {
  const current = [legacy("SG", "2026-03-20"), legacy("SG", "2026-03-21"), legacy("SG", "2027-10-29"), legacy("US", "2026-02-12")]
  const changes = plan(current)
  assert.ok(changes.removals.includes("public-holiday-sg-2026-03-20"))
  assert.ok(changes.removals.includes("public-holiday-us-2026-02-12"))
  assert.equal(changes.updates.find((event) => event.id === "public-holiday-sg-2027-10-29")?.startDate, "2027-10-28")
  const repeated = plan(apply(current, changes), changes.removals)
  assert.equal(repeated.additions.length + repeated.updates.length + repeated.removals.length, 0)
})

test("database object-key reordering cannot create repeated holiday corrections", () => {
  function reordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reordered)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)]))
  }
  const initial = plan([legacy("SG", "2027-10-29"), legacy("US", "2026-07-03")])
  const saved = reordered(apply([legacy("SG", "2027-10-29"), legacy("US", "2026-07-03")], initial)) as OfficeCalendarEvent[]
  const repeated = plan(saved, initial.removals)
  assert.equal(repeated.complete, true)
  assert.equal(repeated.additions.length + repeated.updates.length + repeated.removals.length, 0)
  assert.equal(repeated.preserved.filter(row => row.reviewRequired).length, 0)

  const changedSource = structuredClone(saved) as HolidayCalendarEvent[]
  changedSource[0].holidaySource.revision = "older-reference"
  assert.equal(plan(changedSource).updates.length, 1, "a real metadata revision still needs correction")
  changedSource[0].people = ["CY"]
  const protectedPlan = plan(changedSource)
  assert.equal(protectedPlan.updates.length, 0)
  assert.equal(protectedPlan.preserved.find(row => row.id === changedSource[0].id)?.reviewRequired, true)
})

test("manual edits, unknown extras and attendance assignments are never overwritten or deleted", () => {
  const hk = { ...legacy("HK", "2026-04-07", "HOLIDAY ATTENDANCE - EASTER MONDAY"), people: ["SC"] }
  const sg = { ...legacy("SG", "2026-03-20"), title: "Company-specific holiday" }
  const us = { ...legacy("US", "2026-02-12"), note: "Regional office" }
  const changes = plan([hk, sg, us])
  assert.ok(!changes.updates.some((event) => [hk.id, sg.id, us.id].includes(event.id)))
  assert.ok(!changes.removals.some((id) => [hk.id, sg.id, us.id].includes(id)))
  assert.equal(changes.preserved.filter((row) => row.reviewRequired).length, 3)
  assert.equal(changes.complete, false)
  assert.ok(!changes.additions.some((event) => event.holidaySource.identity === "sg-2026-hari-raya-puasa"))
})

test("pristine HK labels change in place but preserve IDs", () => {
  const current = legacy("HK", "2027-02-08", "HOLIDAY ATTENDANCE - SECOND DAY OF LUNAR NEW YEAR")
  const updated = plan([current]).updates.find((event) => event.id === current.id)!
  assert.equal(updated.id, current.id)
  assert.match(updated.title, /THIRD DAY/)
})

test("combined manual Christmas entry suppresses three countries without deleting the manual entry", () => {
  const manual = { ...legacy("SG", "2026-12-25"), id: "fc-2026-065", title: "PUBLIC HOLIDAY - USA , SINGAPORE, TAIWAN", tags: [], sourceRow: 65 }
  const existing = legacy("SG", "2026-12-25")
  const changes = plan([manual, existing])
  assert.ok(!changes.additions.some((event) => event.startDate === "2026-12-25" && event.holidaySource.country !== "HK"))
  assert.ok(changes.removals.includes(existing.id))
  assert.ok(!changes.removals.includes(manual.id))
  assert.ok(!changes.updates.some((event) => event.id === manual.id))
})

test("intentional deletion markers block both stable identities and old dates across corrections", () => {
  const tombstones = ["public-holiday-sg-2026-03-20", "public-holiday-us-2027-columbus", "public-holiday-hk-2026-04-07"]
  const changes = plan([], tombstones)
  assert.ok(!changes.additions.some((event) => ["sg-2026-hari-raya-puasa", "us-2027-columbus", "hk-2026-easter-monday-observed"].includes(event.holidaySource.identity)))
})

test("a surviving stale alias cannot bypass an intentional deletion of the corrected target", () => {
  const current = legacy("SG", "2026-03-20")
  const changes = plan([current], ["public-holiday-sg-2026-03-21"])
  assert.ok(!changes.updates.some((event) => event.id === current.id))
  assert.ok(!changes.removals.includes(current.id))
  assert.ok(!changes.additions.some((event) => event.holidaySource.identity === "sg-2026-hari-raya-puasa"))
  assert.equal(changes.preserved.find((event) => event.id === current.id)?.reviewRequired, true)
  assert.equal(changes.complete, false)
})

test("unrecognized importer-looking entries are preserved but prevent a false-ready result", () => {
  const unknown = legacy("SG", "2026-04-02")
  const changes = plan([unknown])
  assert.ok(!changes.removals.includes(unknown.id))
  assert.ok(!changes.updates.some((event) => event.id === unknown.id))
  assert.equal(changes.preserved.find((event) => event.id === unknown.id)?.reviewRequired, true)
  assert.equal(changes.complete, false)
})

test("managed identity corrects a future date revision in place and preserves subsequent manual edits", () => {
  const desired = reference.events.find((event) => event.holidaySource.identity === "sg-2027-deepavali")!
  const corrected: HolidayCalendarEvent = { ...desired, startDate: "2027-10-27", endDate: "2027-10-27" }
  const changes = planHolidayReconciliation([desired], [corrected], { coverage: reference.coverage })
  assert.equal(changes.updates.length, 1)
  assert.equal(changes.updates[0].id, desired.id)
  const repeated = planHolidayReconciliation(changes.updates, [corrected], { coverage: reference.coverage })
  assert.equal(repeated.updates.length + repeated.removals.length + repeated.additions.length, 0)
  assert.equal(repeated.complete, true)
  const custom = { ...desired, title: `${desired.title} (CUSTOM)` }
  const protectedPlan = planHolidayReconciliation([custom], [corrected], { coverage: reference.coverage })
  assert.equal(protectedPlan.updates.length + protectedPlan.removals.length + protectedPlan.additions.length, 0)
  assert.equal(protectedPlan.preserved[0].reviewRequired, true)
})

test("partial unavailable coverage never removes or edits that country's records", () => {
  const partial = getVerifiedPublicHolidays([2028], ["US"])
  const current = legacy("US", "2028-02-12")
  const changes = planHolidayReconciliation([current], [], { coverage: partial.coverage })
  assert.equal(changes.complete, false)
  assert.equal(changes.removals.length + changes.updates.length + changes.additions.length, 0)
})

test("holiday HTTP boundary is edit-authorized, server-planned, audited and atomic", () => {
  const code = readFileSync(new URL("../app/api/event-calendar/public-holidays/route.ts", import.meta.url), "utf8")
  assert.match(code, /requireAdminPagePermission\("event-calendar", "edit"\)/)
  assert.match(code, /createAdminAuditContext\(session, request, "event-calendar"\)/)
  assert.match(code, /body\.action === "preview"/)
  assert.match(code, /body\.expectedStoreVersion !== getEventCalendarStoreVersion\(payload\)/)
  assert.match(code, /mutateEventCalendarStoreBatch\(supabase, mutations, body\.expectedStoreVersion\)/)
  assert.doesNotMatch(code, /body\.events|date\.nager\.at/)
})
