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
test("existing CY route needs a unique matching active account and exposes its mismatch", () => {
  const staff = buildCalendarStaffDirectory([person("CY", null)], [user("1", "CL", "chengyuan@cosulich.com.hk")])
  assert.equal(staff.length, 1)
  assert.equal(staff[0].code, "CY")
  assert.match(staff[0].issue || "", /confirm/)
  assert.deepEqual(resolveCalendarStaffRecipients(["CY"], buildCalendarStaffDirectory([person("CY", null)], [])), { recipients: [], unresolved: ["CY"] })
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
