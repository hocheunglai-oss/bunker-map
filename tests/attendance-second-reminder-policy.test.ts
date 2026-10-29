import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import ts from "typescript"
import { buildAttendanceSecondReminderEmail } from "../lib/attendanceData"
import { hasManualEntryOnlyAttendancePolicyForPeriod } from "../lib/attendanceManualEntryPolicy"
import { hongKongWorkingDayNumber, previousMonthPeriod } from "../lib/attendanceMonthEnd"
import { hktDateFromTimestamp } from "../lib/attendanceRules"
import { normalizeEmailList } from "../lib/emailAddress"

// Execute the production sender with local provider fixtures. The policy,
// email builder, recipient normalization and Hong Kong calendar rules are
// real; no staff email or production database connection is ever opened.
const source = ts.createSourceFile("attendanceData.ts",
  readFileSync(new URL("../lib/attendanceData.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) &&
  statement.name?.text === "sendAttendanceSecondReminders")
assert.ok(declaration)
const compiled = transformSync(declaration.getText(source).replace(/^export /, ""),
  { loader: "ts", format: "cjs", target: "node24" }).code

type Person = {
  id: string; adminUserId: string; staffCode: string; displayName: string;
  dingTalkUserId: string | null; team: string; employmentStartDate: string;
}
type Row = Record<string, unknown>
type Email = { to: string[]; subject: string; html: string }
const manualPeople: Person[] = [
  { id: "4c5d73e6-63a9-4b05-93a7-7354b3e668ad", adminUserId: "84bb808c-e188-43ce-9ddf-e7e2fe2e997d",
    staffCode: "NN", displayName: "NN", dingTalkUserId: null, team: "BT", employmentStartDate: "2026-11-02" },
  { id: "96142f45-373f-47e2-9104-e33804f2fb1e", adminUserId: "7c2f5a90-09ae-4d3b-9996-d189f0154d53",
    staffCode: "TL", displayName: "TL", dingTalkUserId: null, team: "BT", employmentStartDate: "2026-11-02" },
]
const ordinary: Person = { id: "ordinary-person", adminUserId: "ordinary-admin", staffCode: "OTHER",
  displayName: "Ordinary User", dingTalkUserId: "ordinary-ding", team: "BT", employmentStartDate: "2026-01-01" }

function fixture(people: Person[]) {
  const emails: Email[] = [], dispatches: Row[] = []
  const users = people.map((person, index) => ({ id: person.adminUserId, displayName: person.displayName,
    username: `fixture-${index}@example.invalid`, isActive: true }))
  const client = {
    from(table: string) {
      assert.equal(table, "attendance_reminder_dispatches", "reminder flow must not write confirmations")
      return {
        insert(row: Row) {
          return { select() { return { async single() {
            if (dispatches.some(value => value.person_id === row.person_id && value.year === row.year &&
              value.month === row.month && value.dispatch_kind === row.dispatch_kind)) {
              return { data: null, error: { code: "23505" } }
            }
            const saved = { ...row, id: `dispatch-${dispatches.length}` }
            dispatches.push(saved)
            return { data: saved, error: null }
          } } } }
        },
        update(values: Row) {
          return { async eq(column: string, id: string) {
            assert.equal(column, "id")
            const saved = dispatches.find(row => row.id === id)
            assert.ok(saved)
            Object.assign(saved, values)
            return { error: null }
          } }
        },
      }
    },
  }
  const send = new Function("loadAttendanceCalendarContext", "hktDateFromTimestamp", "previousMonthPeriod",
    "hongKongWorkingDayNumber", "loadAttendancePeopleForPeriod", "listManagedAdminUsers", "normalizeEmailList",
    "hasManualEntryOnlyAttendancePolicyForPeriod", "asRow", "throwIfError", "buildAttendanceSecondReminderEmail",
    "sendNoticeEmail", `${compiled}; return sendAttendanceSecondReminders`)(
    async () => ({ holidaysByDate: new Map() }), hktDateFromTimestamp, previousMonthPeriod,
    hongKongWorkingDayNumber, async () => people, async () => users, normalizeEmailList,
    hasManualEntryOnlyAttendancePolicyForPeriod, (value: Row) => value,
    (error: unknown) => { if (error) throw error }, buildAttendanceSecondReminderEmail,
    async (email: Email) => { emails.push(email); return { id: `fixture-message-${emails.length}` } },
  ) as (client: unknown, now: Date) => Promise<{ sent: number; alreadySent: number; failed: number }>
  return { emails, dispatches, send: (now = new Date("2026-12-01T00:00:00.000Z")) => send(client, now) }
}

test("real second-reminder sender gives NN/TL truthful manual review wording and ordinary staff unchanged wording", async () => {
  const app = fixture([...manualPeople, ordinary])
  assert.equal((await app.send()).sent, 3)
  for (const email of app.emails.slice(0, 2)) {
    assert.match(email.html, /manual-entry attendance period/)
    assert.match(email.html, /Unconfirmed records will remain pending/)
    assert.match(email.html, /will not be automatically confirmed/)
    assert.match(email.html, /click <strong>CONFIRM<\/strong> when the entries are accurate/)
    assert.match(email.html, /sign-in or sign-out entry is missing/)
    assert.match(email.html, /right to dispute/)
    assert.doesNotMatch(email.html, /SYSTEM CONFIRMED|once attendance synchronization has been verified/)
  }
  const expectedOrdinary = buildAttendanceSecondReminderEmail({ displayName: ordinary.displayName, year: 2026, month: 11 })
  assert.equal(app.emails[2].subject, expectedOrdinary.subject)
  assert.equal(app.emails[2].html, expectedOrdinary.html)
  assert.deepEqual(app.dispatches.map(row => [row.status, row.dispatch_kind]),
    Array.from({ length: 3 }, () => ["sent", "second_reminder"]))
  assert.equal((await app.send()).alreadySent, 3)
  assert.equal(app.emails.length, 3, "retry must not send duplicate reminders")
})

test("later DingTalk links retain truthful reminder wording for historical manual periods", async () => {
  const app = fixture(manualPeople.map(person => ({ ...person, dingTalkUserId: `later-${person.staffCode}` })))
  assert.equal((await app.send()).sent, 2)
  for (const email of app.emails) {
    assert.match(email.html, /will not be automatically confirmed/)
    assert.doesNotMatch(email.html, /SYSTEM CONFIRMED/)
  }
})

test("sender uses the real identity/group/start policy rather than selecting wording by initials", async () => {
  for (const person of manualPeople) {
    for (const change of [{ id: "another-person" }, { adminUserId: "another-account" },
      { staffCode: "OTHER" }, { team: "AC" }, { employmentStartDate: "2026-11-03" }]) {
      const app = fixture([{ ...person, ...change }])
      assert.equal((await app.send()).sent, 1)
      assert.match(app.emails[0].html, /SYSTEM CONFIRMED/)
      assert.doesNotMatch(app.emails[0].html, /manual-entry attendance period/)
    }
  }
  const earlierPeriod = fixture(manualPeople)
  assert.equal((await earlierPeriod.send(new Date("2026-11-02T00:00:00.000Z"))).sent, 2)
  for (const email of earlierPeriod.emails) assert.match(email.html, /SYSTEM CONFIRMED/)
})

test("manual reminder display names remain HTML-escaped", () => {
  const email = buildAttendanceSecondReminderEmail({
    displayName: "<script>bad</script>", year: 2026, month: 11, manualEntryOnly: true,
  })
  assert.doesNotMatch(email.html, /<script>/)
  assert.match(email.html, /&lt;script&gt;bad&lt;\/script&gt;/)
})
