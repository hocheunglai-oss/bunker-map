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
    /const TABS[\s\S]*?ATTENDANCE \(CURRENT MONTH\)[\s\S]*?MONTHLY STATEMENT[\s\S]*?ALL TIME RECORD/,
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
  assert.match(client, /openLeave\(person, day\.date, "in", record, day\.holiday\)/)
  assert.match(client, /openLeave\(person, day\.date, "out", record, day\.holiday\)/)
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
    /const matching = record \? editableAttendanceEntry\(record, direction\) : undefined/,
  )
  assert.doesNotMatch(client, /\|\| entries\[0\]/)
})

test("either side of a HOME or OS day edits the same portioned record", () => {
  assert.match(
    client,
    /function editableAttendanceEntry[\s\S]*?leaveEntryForDirection\(item, direction\)[\s\S]*?entry\.code === "HO" \|\| entry\.code === "OS"/,
  )
  assert.match(client, /entryId: matching\?\.id/)
  assert.match(client, /portion: matching\?\.portion/)
})

test("sign-in cells distinguish on-time, late, and automatic AM leave", () => {
  assert.match(client, /item\.automaticAmLeave\) return "AM LEAVE"/)
  assert.match(client, /item\.late\) return styles\.lateCell/)
  assert.match(client, /item\.effectiveSignIn\) return styles\.onTimeCell/)
  assert.match(client, /item\.early && item\.effectiveSignOut\) return styles\.onTimeCell/)
  assert.match(client, /item\.effectiveSignOut\) return styles\.onTimeCell/)
  assert.match(styles, /td\.onTimeCell[\s\S]*?#067647/)
})

test("half-day leave stacks the working-session punches in chronological order", () => {
  assert.match(
    client,
    /function halfDayPunchValue[\s\S]*?direction === "in"[\s\S]*?absenceEntryForPortion\(item, "pm"\)/,
  )
  assert.match(
    client,
    /direction === "out"[\s\S]*?absenceEntryForPortion\(item, "am"\)[\s\S]*?item\.automaticAmLeave/,
  )
  assert.match(
    client,
    /\[item\.effectiveSignIn, item\.effectiveSignOut\][\s\S]*?\.join\("\\n"\)/,
  )
  assert.match(client, /return item\.early \? styles\.lateCell : styles\.onTimeCell/)
  assert.match(client, /return item\.late \? styles\.lateCell : styles\.onTimeCell/)
  assert.match(styles, /\.cellButton[\s\S]*?white-space: pre-line/)
})

test("either cell edits the sole half-day status governing its paired punches", () => {
  assert.match(
    client,
    /function editableAttendanceEntry[\s\S]*?const entries = leaveEntries\(item\)[\s\S]*?if \(entries\.length === 1\) return entries\[0\]/,
  )
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
    "CONFIRMATION",
  ]) {
    assert.match(client, new RegExp(`>${label}(?:<br \/>)?`))
  }
  assert.match(client, /SEND REMINDER/)
  assert.match(client, /row\.summary\?\.canConfirm/)
  assert.match(client, /selectedSummaryYear/)
  assert.match(client, /selectedSummaryPersonId/)
  assert.match(client, /aria-label="Monthly attendance user"/)
  assert.match(client, /<option value="all">ALL USERS<\/option>/)
  assert.match(client, /filteredMonthSections\.map/)
  assert.match(client, /selectedSummaryYear < currentYear \? 12 : currentMonth/)
  assert.match(client, /yearData\[section\.month\]\?\.periodClosed/)
  assert.match(client, /year: selectedSummaryYear/)
  assert.match(client, /availableYears/)
  assert.match(client, />OPEN</)
  assert.match(client, /scope: "year"/)
  assert.doesNotMatch(client, /Promise\.all\(\s*months\.map/)
  assert.match(client, /action, \.\.\.body/)
})

test("Monthly summary fits the page and emphasizes only applicable figures", () => {
  assert.match(
    client,
    /function displaySummaryDays[\s\S]*?return Math\.abs\(value\) < 0\.00001 \? "–"/,
  )
  assert.match(client, /summaryNumberClass/)
  assert.match(client, /staffSecondaryLabel/)
  assert.match(
    styles,
    /\.excelPanel[\s\S]*?max-height: none;[\s\S]*?overflow: visible;/,
  )
  assert.match(
    styles,
    /\.yearSummaryTable[\s\S]*?min-width: 0;[\s\S]*?width: 100%;/,
  )
  assert.doesNotMatch(
    styles,
    /\.yearSummaryTable\s*\{[^}]*min-width:\s*1690px/,
  )
})

test("Monthly Record renders Hong Kong holidays and supports explicit work-mode overrides", () => {
  assert.match(client, /HK HOLIDAY/)
  assert.match(client, /holidayTitle\(day\.holiday\)/)
  assert.match(client, /recordCellValue\(record, "in", day\.holiday, viewNow\)/)
  assert.match(client, /item\.workMode === "home-office"/)
  assert.match(client, /Not attending holiday/)
  assert.match(client, /Holiday attendance/)
  assert.match(client, /direction === "in" \? "10:30" : "19:30"/)
  assert.match(client, /hongKongDateTimeKey\(now\)/)
  assert.match(client, /REFRESHING…[\s\S]*?REFRESH/)
  assert.match(client, /void loadSelectedMonth\(\)/)
  const dayEdit = client.slice(
    client.indexOf("async function saveDayEdit()"),
    client.indexOf("async function deleteLeave()"),
  )
  assert.match(dayEdit, /postAttendance\("save-day-edit"/)
  assert.equal(dayEdit.match(/postAttendance\(/g)?.length, 1)
  assert.doesNotMatch(dayEdit, /save-work-mode|save-leave|delete-leave/)
  assert.match(client, /value="mode:office"/)
  assert.match(client, /Holiday attendance/)
  assert.match(client, /<h2 id="leave-title">EDIT ATTENDANCE<\/h2>/)
  assert.match(client, /\["full", "Full day"\]/)
  assert.doesNotMatch(client, />\s*Note\s*<textarea/)
  assert.match(client, /scope: "month"/)
  assert.match(client, /value="mode:home-office"/)
  assert.match(client, /<option value="mode:business-trip">Business trip<\/option>/)
  assert.match(client, /existingLeaveEntryId: leaveDraft\.entryId/)
  assert.match(client, /aria-label="Sign in time"/)
  assert.match(client, /aria-label="Sign out time"/)
  assert.match(client, /Official sign-out time cannot be earlier than 17:00/)
  assert.match(dayEdit, /updateSignIn:/)
  assert.match(dayEdit, /updateSignOut:/)
  const deleteDayEntry = client.slice(
    client.indexOf("async function deleteLeave()"),
    client.indexOf("async function confirmMonth("),
  )
  assert.match(deleteDayEntry, /postAttendance\("save-day-edit"/)
  assert.match(deleteDayEntry, /leaveEnabled: false/)
  assert.doesNotMatch(deleteDayEntry, /postAttendance\("delete-leave"/)
})

test("manual IN and OUT corrections are atomic, audited replacements", () => {
  const attendanceData = source("../lib/attendanceData.ts")
  const migration = source("../supabase/migrations/20260814104914_add_attendance_time_corrections_to_day_editor.sql")
  assert.match(attendanceData, /p_update_sign_in: updateSignIn/)
  assert.match(attendanceData, /p_update_sign_out: updateSignOut/)
  assert.match(migration, /insert into public\.attendance_manual_overrides/)
  assert.match(migration, /'replace', 'OnDuty'/)
  assert.match(migration, /'replace', 'OffDuty'/)
  assert.match(migration, /where action = 'replace'/)
  assert.match(migration, /Manual attendance editor correction/)
  assert.match(migration, /to service_role/)
  assert.match(migration, /from public, anon, authenticated, service_role/)
})

test("PM leave permits an audited morning sign-out while normal days retain 17:00", () => {
  const attendanceData = source("../lib/attendanceData.ts")
  const migration = source("../supabase/migrations/20260818023111_support_half_day_attendance_punches.sql")
  assert.match(attendanceData, /const hasAfternoonLeave/)
  assert.match(attendanceData, /checkType !== "OffDuty" \|\|[\s\S]*?hasAfternoonLeave/)
  assert.match(attendanceData, /const permitsMorningSignOut/)
  assert.match(migration, /p_leave_portion = 'pm'/)
  assert.match(migration, /Sign-out before 17:00 requires PM leave/)
  assert.match(migration, /from public, anon, authenticated, service_role/)
  assert.match(migration, /to service_role/)
})

test("day editor gives HOME and OS auditable AM, PM, and full-day portions", () => {
  const leaveCodes = client.slice(
    client.indexOf("const LEAVE_CODES"),
    client.indexOf("const EMPTY_MONTH"),
  )
  assert.doesNotMatch(leaveCodes, /value: "HO"|value: "OS"/)
  assert.match(client, /value === "home-office" \|\| value === "business-trip"/)
  assert.match(client, /code: value === "home-office" \? "HO" : "OS"/)
  assert.match(client, /attendanceModeCode \? "full"/)
  assert.match(client, /leaveDraft\.entryId[\s\S]*?deleteLeave\(\)/)
})

test("HOME and OS cells use the same green attendance treatment", () => {
  assert.match(styles, /td\.homeOfficeCell,\s*\n\.monthRecordTable td\.businessTripCell[\s\S]*?#067647/)
  assert.match(client, /entry\.code === "HO" \|\| entry\.code === "OS"[\s\S]*?styles\.homeOfficeCell/)
})

test("day editor combines attendance status and uses direct portion buttons", () => {
  assert.match(client, /Attendance status/)
  assert.doesNotMatch(client, />Work mode</)
  assert.doesNotMatch(client, />Leave</)
  assert.match(client, /styles\.portionButtons/)
  assert.match(client, /aria-pressed=\{leaveDraft\.portion === value\}/)
  assert.doesNotMatch(client, /<option value="default">Default/)
  assert.match(client, /record\?\.workMode && record\.workMode !== defaultWorkMode/)
  assert.match(client, /record\?\.holidayAttendance[\s\S]*?"office"/)
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
  assert.match(client, /"save-roster"/)
  assert.match(client, /EDIT ATTENDANCE USERS/)
  assert.match(client, /moveRosterItem/)
  assert.match(adminUsers, /ADMIN_ATTENDANCE_GROUP_METADATA_KEY = "__attendanceGroup"/)
  assert.match(adminUsers, /ADMIN_ATTENDANCE_GROUPS = \["BT", "BS", "AC"\]/)
  assert.match(userManagement, /Attendance Group/)
  assert.match(userManagement, /Not included in attendance/)
  assert.doesNotMatch(client, /<th>USERNAME<\/th>/)
  assert.doesNotMatch(client, /<th>FIRST RECORD<\/th>/)
  assert.doesNotMatch(client, /<th>LATEST RECORD<\/th>/)
  assert.doesNotMatch(client, /<th>ATTENDED DAYS<\/th>/)
  assert.doesNotMatch(client, /<th>LATE DAYS<\/th>/)
  assert.match(client, /BALANCE B\/F<br \/>31 DEC \{selectedAllTimeYear - 1\}/)
  assert.match(client, /ATTENDANCE &amp; LEAVE ACTIVITY/)
  assert.match(client, /BALANCE C\/F<br \/>31 DEC \{selectedAllTimeYear\}/)
  assert.match(client, /selectedAllTimeYear < currentYear \? "CLOSING POSITION" : "CURRENT BALANCE"/)
  assert.match(client, /<>BALANCE<br \/>TO DATE<\/>/)
  assert.match(client, />IN PROGRESS<\/span>/)
  assert.match(client, /annualSummaries/)
  assert.match(client, /closingBalanceUnits/)
  assert.match(client, /codeTotals\.HOL[\s\S]*?codeTotals\.ALS[\s\S]*?codeTotals\.ALU[\s\S]*?codeTotals\.SLX/)
  assert.doesNotMatch(client, /codeTotal\(row\.summary, "ALS"\) \+ codeTotal\(row\.summary, "ALU"\)/)
  assert.doesNotMatch(client, /<th>LEAVE<br \/>PAID<\/th>/)
  assert.doesNotMatch(client, />MAPPED<|>NOT MAPPED</)
  assert.doesNotMatch(client, /className=\{styles\.balanceExplanation\}/)
  assert.match(client, /<th>HOME<\/th>/)
  assert.match(client, /ATTEND<br \/>HOME/)
  assert.match(client, /LEGEND &amp; RULES/)
  assert.match(client, /traceableNumber/)
  assert.match(client, /data-date-trace-popover/)
  assert.match(client, /window\.setTimeout\(\(\) => setDateTrace\(null\), 8000\)/)
  assert.match(client, /window\.addEventListener\("pointerdown", close\)/)
  assert.match(client, /event\.key === "Escape"/)
  assert.match(client, /displayTraceDate/)
  assert.doesNotMatch(client, /dateTraceTitle/)
  assert.match(styles, /\.dateTraceButton[\s\S]*?color: var\(--fc-admin-link\)/)
  assert.match(styles, /\.dateTracePopover[\s\S]*?position: fixed/)
  assert.match(client, /CONFIRM YEAR/)
  assert.match(client, /note: "annual-summary"/)
  assert.match(styles, /\.allTimePanel[\s\S]*?max-height: none;[\s\S]*?overflow: visible;/)
  assert.match(styles, /\.allTimeTable[\s\S]*?min-width: 0;[\s\S]*?table-layout: fixed;/)
  assert.match(styles, /\.openingGroup[\s\S]*?#eaf3ff/)
  assert.match(styles, /\.activityGroup[\s\S]*?#f1efff/)
  assert.match(styles, /\.closingGroup[\s\S]*?#eaf8f0/)
  assert.match(client, /selectedAllTimeYear/)
  assert.match(client, /<th scope="row">TOTAL<\/th>/)
})

test("AC holiday attendance is excluded and historic imported credit is removed", () => {
  const attendanceData = source("../lib/attendanceData.ts")
  const migration = source("../supabase/migrations/20260812043244_attendance_roster_order_and_ac_holiday_exclusion.sql")
  assert.match(attendanceData, /attendanceHoliday &&[\s\S]*?team !== "AC"/)
  assert.match(migration, /person\.team = 'AC'/)
  assert.match(migration, /attendance_hk_holiday_projection/)
  assert.match(migration, /insert into public\.attendance_manual_overrides/)
  assert.match(migration, /system:ac-holiday-exclusion/)
  assert.match(migration, /delete from public\.attendance_work_mode_overrides/)
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
