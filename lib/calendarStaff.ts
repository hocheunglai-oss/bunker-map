import type { SupabaseClient } from "@supabase/supabase-js"
import { isValidEmailAddress } from "@/lib/emailAddress"
import { createCalendarServiceClient } from "@/lib/calendarServiceClient"

export type CalendarStaff = { code: string; email: string | null; name: string; issue?: string }
type StaffRow = { staff_code: string; display_name?: string; admin_user_id: string | null; is_active: boolean }
type UserRow = { id: string; display_name: string | null; email: string | null; username: string; is_active: boolean }
const codeOf = (value: unknown) => typeof value === "string" ? value.trim().toUpperCase() : ""
const emailOf = (value: unknown) => typeof value === "string" && isValidEmailAddress(value.trim()) ? value.trim().toLowerCase() : null

export function buildCalendarStaffDirectory(people: StaffRow[], users: UserRow[]): CalendarStaff[] {
  const result = new Map<string, CalendarStaff>()
  const matchedUsers = new Set<string>()
  const activeUsers = users.filter((user) => user.is_active)
  for (const person of people.filter((person) => person.is_active)) {
    const code = codeOf(person.staff_code)
    if (!code) continue
    const matches = person.admin_user_id
      ? activeUsers.filter((user) => user.id === person.admin_user_id)
      : activeUsers.filter((user) => codeOf(user.display_name) === code)
    // Attendance's canonical staff code and account link determine identity.
    // Email addresses are delivery destinations, never staff identity aliases.
    const user = matches.length === 1 ? matches[0] : null
    if (user) matchedUsers.add(user.id)
    const email = user ? emailOf(user.email) || emailOf(user.username) : null
    const entry = { code, name: person.display_name || code, email }
    if (result.has(code)) {
      result.set(code, { code, name: code, email: null, issue: "Duplicate staff code. Check User Management before sending." })
    } else {
      result.set(code, email ? entry : { ...entry, issue: "No unique active staff email is available. Check User Management." })
    }
  }
  for (const user of activeUsers) {
    if (matchedUsers.has(user.id)) continue
    const code = codeOf(user.display_name)
    const email = emailOf(user.email) || emailOf(user.username)
    if (!/^[A-Z][A-Z0-9_-]{0,7}$/.test(code) || !email) continue
    const existing = result.get(code)
    if (existing) {
      // A broken attendance link must not be silently replaced by another user.
      if (existing.email !== email) result.set(code, { ...existing, email: null, issue: "Conflicting staff accounts. Check User Management before sending." })
    } else result.set(code, { code, name: user.display_name || code, email })
  }
  return [...result.values()].sort((a, b) => a.code.localeCompare(b.code))
}

export async function loadCalendarStaffDirectory(supabase: SupabaseClient = createCalendarServiceClient()) {
  const [people, users] = await Promise.all([
    supabase.from("attendance_people").select("staff_code,display_name,admin_user_id,is_active"),
    supabase.from("admin_users").select("id,display_name,email,username,is_active"),
  ])
  if (people.error || users.error) throw new Error("The staff directory is unavailable. No recipient addresses were guessed.")
  return buildCalendarStaffDirectory(people.data || [], users.data || [])
}

export function resolveCalendarStaffRecipients(codes: string[], staff: CalendarStaff[]) {
  const recipients = new Set<string>(), unresolved = new Set<string>()
  for (const raw of codes) {
    const code = codeOf(raw)
    const matches = staff.filter((person) => person.code === code)
    if (matches.length !== 1 || !matches[0].email) unresolved.add(code || "Unknown staff")
    else recipients.add(matches[0].email)
  }
  return { recipients: [...recipients], unresolved: [...unresolved] }
}
