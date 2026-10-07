import assert from "node:assert/strict"
import test from "node:test"
import { buildCalendarStaffDirectory, resolveCalendarStaffRecipients } from "../lib/calendarStaff"
import { resolveEventCalendarRecipients, validateCalendarEmailList } from "../lib/calendarRecipients"
import { formatEventDate } from "../lib/eventCalendarEmail"

const user = (id: string, display_name: string, email: string, is_active = true) => ({ id, display_name, email, username: email, is_active })
const person = (staff_code: string, admin_user_id: string | null) => ({ staff_code, admin_user_id, is_active: true })
test("DT JZ and newly added staff resolve from active canonical staff accounts", () => {
  const staff = buildCalendarStaffDirectory([person("DT", "1"), person("JZ", "2")], [user("1", "DT", "d@example.com"), user("2", "JZ", "j@example.com"), user("3", "NEW", "n@example.com")])
  assert.deepEqual(resolveCalendarStaffRecipients(["DT", "JZ", "NEW", "DT"], staff), { recipients: ["d@example.com", "j@example.com", "n@example.com"], unresolved: [] })
})
test("unresolved, inactive and conflicting staff are reported rather than silently dropped", () => {
  const staff = buildCalendarStaffDirectory([person("DT", "1"), person("JZ", "2")], [user("1", "DT", "d@example.com", false), user("2", "JZ", "j@example.com"), user("3", "JZ", "different@example.com")])
  assert.deepEqual(resolveCalendarStaffRecipients(["DT", "JZ", "UNKNOWN"], staff), { recipients: [], unresolved: ["DT", "JZ", "UNKNOWN"] })
})
test("canonical attendance CY and linked admin CY resolve exactly once with no CL option or warning", () => {
  const staff = buildCalendarStaffDirectory([person("CY", "chengyuan-account")], [user("chengyuan-account", "CY", "chengyuan@cosulich.com.hk")])
  assert.deepEqual(staff, [{ code: "CY", name: "CY", email: "chengyuan@cosulich.com.hk" }])
  assert.deepEqual(resolveCalendarStaffRecipients(["CY", " cy ", "CY"], staff), {
    recipients: ["chengyuan@cosulich.com.hk"], unresolved: [],
  })
  assert.deepEqual(resolveCalendarStaffRecipients(["CL"], staff), { recipients: [], unresolved: ["CL"] })
})
test("a canonical account link remains authoritative even while the old display label is being corrected", () => {
  const staff = buildCalendarStaffDirectory([person("CY", "chengyuan-account")], [user("chengyuan-account", "CL", "chengyuan@cosulich.com.hk")])
  assert.deepEqual(staff, [{ code: "CY", name: "CY", email: "chengyuan@cosulich.com.hk" }])
})
test("CY uses the same exact-code fallback as other staff, never a hardcoded email identity", () => {
  const canonical = buildCalendarStaffDirectory([person("CY", null)], [user("1", "CY", "new-address@example.com")])
  assert.deepEqual(canonical, [{ code: "CY", name: "CY", email: "new-address@example.com" }])
  const unmatched = buildCalendarStaffDirectory([person("CY", null)], [user("1", "CL", "chengyuan@cosulich.com.hk")])
  assert.deepEqual(resolveCalendarStaffRecipients(["CY"], unmatched), { recipients: [], unresolved: ["CY"] })
  const inactive = buildCalendarStaffDirectory([person("CY", "1")], [user("1", "CY", "chengyuan@cosulich.com.hk", false)])
  assert.deepEqual(resolveCalendarStaffRecipients(["CY"], inactive), { recipients: [], unresolved: ["CY"] })
  const brokenLink = buildCalendarStaffDirectory([person("CY", "missing-account")], [user("1", "CY", "chengyuan@cosulich.com.hk")])
  assert.deepEqual(resolveCalendarStaffRecipients(["CY"], brokenLink), { recipients: [], unresolved: ["CY"] })
})
test("email settings reject every malformed token and distinguish absent from deliberately empty", () => {
  assert.deepEqual(validateCalendarEmailList("A <A@example.com>; b@example.com\na@example.com"), ["a@example.com", "b@example.com"])
  assert.throws(() => validateCalendarEmailList("valid@example.com; NOT AN EMAIL"), /invalid/)
  assert.deepEqual(resolveEventCalendarRecipients({}, "default@example.com"), ["default@example.com"])
  assert.deepEqual(resolveEventCalendarRecipients({ emailRecipientsText: "" }, "default@example.com"), [])
  assert.throws(() => resolveEventCalendarRecipients({ emailRecipientsText: "invalid" }, "default@example.com"), /invalid/)
})
test("email date formatting is independent of server timezone", () => {
  const previous = process.env.TZ
  try {
    for (const zone of ["UTC", "Asia/Hong_Kong", "Pacific/Auckland", "America/Los_Angeles"]) {
      process.env.TZ = zone
      assert.equal(formatEventDate("2026-10-07"), "07 Oct 26 (Wed)")
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})
