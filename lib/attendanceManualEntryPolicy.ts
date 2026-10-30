import { formatIsoDate, parseIsoDate } from "./attendanceRules"

type ManualEntryAttendancePerson = {
  id: string
  adminUserId: string | null
  staffCode: string
  dingTalkUserId: string | null
  team: string
  employmentStartDate: string | null
}

// Owner-authorized HK onboarding from 2 November 2026. These are manual
// attendance records, NOT CY/JZ-style exceptions that approve attendance.
// Pin both identities, the initials, group and start date so reassignment or
// roster drift cannot silently inherit this policy.
const MANUAL_ENTRY_START_DATE = "2026-11-02"
const MANUAL_ENTRY_PEOPLE = Object.freeze([
  Object.freeze({
    id: "4c5d73e6-63a9-4b05-93a7-7354b3e668ad",
    adminUserId: "84bb808c-e188-43ce-9ddf-e7e2fe2e997d",
    staffCode: "NN",
  }),
  Object.freeze({
    id: "96142f45-373f-47e2-9104-e33804f2fb1e",
    adminUserId: "7c2f5a90-09ae-4d3b-9996-d189f0154d53",
    staffCode: "ML",
  }),
])

function matchesManualEntryIdentity(person: ManualEntryAttendancePerson) {
  return person.team === "BT" &&
    person.employmentStartDate === MANUAL_ENTRY_START_DATE &&
    MANUAL_ENTRY_PEOPLE.some((approved) => person.id === approved.id &&
      person.adminUserId === approved.adminUserId &&
      person.staffCode === approved.staffCode)
}

// Health classification only: a real mapping is counted as mapped instead.
export function hasManualEntryOnlyAttendancePolicy(
  person: ManualEntryAttendancePerson,
  asOfDate: string,
) {
  return Boolean(parseIsoDate(asOfDate)) && asOfDate >= MANUAL_ENTRY_START_DATE &&
    matchesManualEntryIdentity(person) &&
    (person.dingTalkUserId === null ||
      (typeof person.dingTalkUserId === "string" && !person.dingTalkUserId.trim()))
}

// A monthly statement overlapping the manual-entry period must stay pending
// for genuine manual review. Linking DingTalk later is NOT permission to
// auto-approve earlier manual months. Before onboarding DingTalk, explicitly
// close this policy with a reviewed effective end date and preserve exclusion
// for every month overlapping that historical manual period. Until then the
// period is open-ended, even if a DingTalk link has already been added.
export function hasManualEntryOnlyAttendancePolicyForPeriod(
  person: ManualEntryAttendancePerson,
  period: { year: number; month: number },
) {
  if (!Number.isInteger(period.year) || period.year < 2000 || period.year > 2200 ||
    !Number.isInteger(period.month) || period.month < 1 || period.month > 12) return false
  const monthEnd = formatIsoDate(new Date(Date.UTC(period.year, period.month, 0)))
  return monthEnd >= MANUAL_ENTRY_START_DATE && matchesManualEntryIdentity(person)
}
