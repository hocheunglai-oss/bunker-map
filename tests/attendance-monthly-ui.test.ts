import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

const client = source("../app/admin/attendancerecord/AttendanceRecordClient.tsx")
const styles = source("../app/admin/attendancerecord/attendanceRecord.module.css")
const adminUsers = source("../lib/adminUsers.ts")
const userManagement = source("../app/admin/usermanagement/page.tsx")

test("Attendance Record exposes only the requested three compact views", () => {
  assert.match(
    client,
    /const TABS[\s\S]*?ATTENDANCE \(CURRENT MONTH\)[\s\S]*?MONTHLY[\s\S]*?ALL TIME/,
  )
  assert.doesNotMatch(client, /\{ id: "daily"/)
  assert.doesNotMatch(client, /\{ id: "leave"/)
  assert.doesNotMatch(client, /MONTHLY SUMMARY/)
  assert.doesNotMatch(client, />Correct</i)
  assert.doesNotMatch(client, /Opening carry-forward \+ allowance/)
})

test("Monthly Record follows the legacy weekday IN and OUT matrix", () => {
  assert.match(client, /dayOfWeek === 0 \|\| dayOfWeek === 6/)
  assert.match(client, /return `\$\{String\(date\.getUTCDate\(\)\).*\}\/\$\{String\(date\.getUTCMonth\(\) \+ 1\).*\} \$\{weekday\}`/)
  assert.match(client, /<th>IN<\/th>/)
  assert.match(client, /<th>OUT<\/th>/)
  assert.match(client, /hktTimeFromTimestamp/)
  assert.match(client, /openLeave\(person, day\.date, "in", record\)/)
  assert.match(client, /openLeave\(person, day\.date, "out", record\)/)
  assert.doesNotMatch(client, /Correct/)
  assert.match(client, /staffOrder/)
  assert.match(client, /DEFAULT_EVENT_CALENDAR_STAFF_ORDER/)
  assert.match(client, /VL[\s\S]*?SC[\s\S]*?OL[\s\S]*?DT[\s\S]*?KZ[\s\S]*?CY[\s\S]*?MY[\s\S]*?LC[\s\S]*?LL[\s\S]*?JZ/)
})

test("Monthly Record edits only the leave portion represented by the clicked cell", () => {
  assert.match(
    client,
    /function leaveEntryForDirection[\s\S]*?entry\.portion === "full"[\s\S]*?direction === "in" \? "am" : "pm"[\s\S]*?entry\.portion === matchingPortion/,
  )
  assert.match(
    client,
    /const matching = record \? leaveEntryForDirection\(record, direction\) : undefined/,
  )
  assert.doesNotMatch(client, /\|\| entries\[0\]/)
})

test("Monthly view includes required Excel totals, confirmation, and reminders", () => {
  for (const label of [
    "ALS",
    "ALU",
    "SLM",
    "SLR",
    "SLX",
    "HOL",
    "SPECIAL",
    "MATERNITY",
    "NO PAY",
    "HO",
    "OS",
    "ATTENDED",
    "LATE",
    "LEAVE",
    "CONFIRMATION",
  ]) {
    assert.match(client, new RegExp(`>${label}(?:<br \/>)?`))
  }
  assert.match(client, /SEND REMINDER/)
  assert.match(client, /row\.summary\?\.canConfirm/)
  assert.match(client, /selectedSummaryYear/)
  assert.match(client, /selectedSummaryYear < currentYear \? 12 : currentMonth/)
  assert.match(client, /yearData\[section\.month\]\?\.periodClosed/)
  assert.match(client, /year: selectedSummaryYear/)
  assert.match(client, /availableYears/)
  assert.match(client, />OPEN</)
  assert.match(client, /scope: "year"/)
  assert.doesNotMatch(client, /Promise\.all\(\s*months\.map/)
  assert.match(client, /action, \.\.\.body/)
})

test("Monthly Record renders Hong Kong holidays and supports explicit work-mode overrides", () => {
  assert.match(client, /HK HOLIDAY/)
  assert.match(client, /holidayTitle\(day\.holiday\)/)
  assert.match(client, /recordCellValue\(record, "in", day\.holiday\)/)
  assert.match(client, /item\.workMode === "home-office"/)
  assert.match(client, /Default \(\{leaveDraft\.defaultWorkMode/)
  const dayEdit = client.slice(
    client.indexOf("async function saveDayEdit()"),
    client.indexOf("async function deleteLeave()"),
  )
  assert.match(dayEdit, /postAttendance\("save-day-edit"/)
  assert.equal(dayEdit.match(/postAttendance\(/g)?.length, 1)
  assert.doesNotMatch(dayEdit, /save-work-mode|save-leave|delete-leave/)
  assert.match(client, /value="office"/)
  assert.match(client, /value="home-office"/)
  assert.match(client, /<option value="business-trip">Business Trip<\/option>/)
  assert.match(client, /existingLeaveEntryId: leaveDraft\.entryId/)
  const deleteDayEntry = client.slice(
    client.indexOf("async function deleteLeave()"),
    client.indexOf("async function confirmMonth("),
  )
  assert.match(deleteDayEntry, /postAttendance\("save-day-edit"/)
  assert.match(deleteDayEntry, /leaveEnabled: false/)
  assert.doesNotMatch(deleteDayEntry, /postAttendance\("delete-leave"/)
})

test("day editor treats HO and OS as legacy work modes, not new leave", () => {
  const leaveCodes = client.slice(
    client.indexOf("const LEAVE_CODES"),
    client.indexOf("const EMPTY_MONTH"),
  )
  assert.doesNotMatch(leaveCodes, /value: "HO"|value: "OS"/)
  assert.match(client, /Legacy work-mode record \(remove to replace\)/)
  assert.match(client, /leaveDraft\.entryId[\s\S]*?deleteLeave\(\)/)
})

test("Reminder selection excludes historical, unlinked, and invalid-email staff", () => {
  assert.match(
    client,
    /function isReminderEligiblePerson[\s\S]*?isActiveRosterPerson\(person\)[\s\S]*?Boolean\(person\.adminUserId\)[\s\S]*?normalizeEmailList\(username\)\.length === 1/,
  )
  assert.match(
    client,
    /isReminderEligiblePerson\(row\.person\)[\s\S]*?row\.summary\?\.confirmation\?\.status !== "confirmed"/,
  )
  assert.match(client, /personIds: selectedReminderPersonIds/)
  assert.match(
    client,
    /setReminderSelection\(new Set\(reminderRecipients\.map\(\(row\) => row\.person\.id\)\)\)/,
  )
})

test("All Time uses User Management roster membership and group metadata", () => {
  assert.match(client, /const EXCLUDED_STAFF_CODES = new Set\(\["SY", "CD", "HC"\]\)/)
  assert.match(client, /source\.availableUsers/)
  assert.match(client, /user\.attendanceTeam \|\| user\.attendanceGroup/)
  assert.match(client, /postAttendance\("save-person"/)
  assert.match(client, /"remove-person"/)
  assert.match(adminUsers, /ADMIN_ATTENDANCE_GROUP_METADATA_KEY = "__attendanceGroup"/)
  assert.match(adminUsers, /ADMIN_ATTENDANCE_GROUPS = \["BT", "BS", "AC"\]/)
  assert.match(userManagement, /Attendance Group/)
  assert.match(userManagement, /Not included in attendance/)
  assert.doesNotMatch(client, /<th>USERNAME<\/th>/)
  assert.doesNotMatch(client, /<th>FIRST RECORD<\/th>/)
  assert.doesNotMatch(client, /<th>LATEST RECORD<\/th>/)
  assert.doesNotMatch(client, /<th>ATTENDED DAYS<\/th>/)
  assert.doesNotMatch(client, /<th>LATE DAYS<\/th>/)
  assert.match(client, /CURRENT YEAR<br \/>ALLOWANCE/)
  assert.match(client, /LAST YEAR BAL B\/F/)
  assert.match(client, /annualSummaries/)
  assert.match(client, /annual\?\.leavePaidUnits === null[\s\S]*?"—"/)
  assert.doesNotMatch(client, /codeTotal\(row\.summary, "ALS"\) \+ codeTotal\(row\.summary, "ALU"\)/)
  assert.match(client, /<th>LEAVE<br \/>PAID<\/th>[\s\S]*?<td>—<\/td>/)
  assert.match(client, /selectedAllTimeYear/)
  assert.match(client, /<th scope="row">TOTAL<\/th>/)
})

test("Attendance tables retain the existing admin visual system and Roboto font", () => {
  assert.match(styles, /var\(--fc-admin-font\), Roboto, Arial, sans-serif/)
  assert.match(styles, /var\(--fc-admin-page-bg\)/)
  assert.match(styles, /var\(--fc-admin-panel-bg\)/)
  assert.match(styles, /var\(--fc-admin-primary-button-bg\)/)
  assert.match(styles, /var\(--fc-table-head-bg\)/)
  assert.match(styles, /var\(--fc-row-bg\)/)
  assert.match(styles, /var\(--fc-row-border\)|var\(--fc-admin-border-soft\)/)
  assert.match(styles, /var\(--fc-admin-selected-bg\)/)
  assert.doesNotMatch(styles, /#fffda2|#fff7c9/i)
})
