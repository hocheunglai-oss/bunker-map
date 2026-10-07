export type TaskScheduleType = "Weekly" | "Monthly" | "Yearly"

export type TaskCalendarTask = {
  id: string
  sourceRow: number
  scheduleType: TaskScheduleType
  dayOfWeek?: number
  daysOfMonth: number[]
  months?: number[]
  notify: string[]
  cc: string[]
  task: string
  remark: string
}

export const TASK_CALENDAR_PROTOCOL_VERSION = 1

export class TaskCalendarValidationError extends Error {
  readonly code = "TASK_CALENDAR_INVALID_MUTATION"

  constructor(message: string) {
    super(message)
    this.name = "TaskCalendarValidationError"
  }
}

function invalidTask(message: string): never {
  throw new TaskCalendarValidationError(message)
}

function integerList(value: unknown, min: number, max: number, label: string) {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item < min || item > max)) {
    invalidTask(`${label} must contain whole numbers from ${min} to ${max}.`)
  }
  return Array.from(new Set(value as number[])).sort((a, b) => a - b)
}

function recipientList(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 100)) {
    invalidTask(`${label} must contain valid staff codes.`)
  }
  return Array.from(new Set((value as string[]).map((item) => item.trim().toUpperCase())))
}

/** Shared browser/server validation; never replace bad or absent input with a different schedule. */
export function validateTaskCalendarTask(value: unknown): TaskCalendarTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidTask("The task is invalid.")
  const task = value as Record<string, unknown>
  const allowed = new Set(["id", "sourceRow", "scheduleType", "dayOfWeek", "daysOfMonth", "months", "notify", "cc", "task", "remark"])
  if (Object.keys(task).some((key) => !allowed.has(key))) invalidTask("The task contains unsupported fields. Refresh the page before editing it.")
  if (typeof task.id !== "string" || !task.id.trim() || task.id !== task.id.trim() || task.id.length > 200) invalidTask("The task ID is invalid.")
  if (typeof task.task !== "string" || !task.task.trim() || task.task.length > 5000) invalidTask("Enter a task name (up to 5,000 characters).")
  if (typeof task.remark !== "string" || task.remark.length > 10000) invalidTask("The remark must be text (up to 10,000 characters).")
  if (!Number.isInteger(task.sourceRow) || Number(task.sourceRow) < 0) invalidTask("The task source is invalid.")
  if (!["Weekly", "Monthly", "Yearly"].includes(String(task.scheduleType))) invalidTask("Choose Weekly, Monthly or Yearly.")
  const scheduleType = task.scheduleType as TaskScheduleType
  const daysOfMonth = integerList(task.daysOfMonth, 1, 31, "Days of month")
  const months = integerList(task.months ?? [], 1, 12, "Months")
  if (scheduleType === "Weekly" && (!Number.isInteger(task.dayOfWeek) || Number(task.dayOfWeek) < 0 || Number(task.dayOfWeek) > 6)) invalidTask("Choose a weekday for this weekly task.")
  if (scheduleType !== "Weekly" && !daysOfMonth.length) invalidTask("Enter at least one day of the month.")
  if (scheduleType === "Yearly" && !months.length) invalidTask("Choose at least one month for this yearly task.")
  const notify = recipientList(task.notify, "Notify To")
  const cc = recipientList(task.cc, "CC Copy")
  if (!notify.length) invalidTask("Choose at least one person in Notify To.")
  return {
    id: task.id,
    sourceRow: Number(task.sourceRow),
    scheduleType,
    ...(scheduleType === "Weekly" ? { dayOfWeek: Number(task.dayOfWeek) } : {}),
    daysOfMonth: scheduleType === "Weekly" ? [] : daysOfMonth,
    months: scheduleType === "Yearly" ? months : [],
    notify,
    cc,
    task: task.task.trim(),
    remark: task.remark,
  }
}

export function parseTaskDays(value: string) {
  const pieces = value.trim().split(/[,;\s]+/).filter(Boolean)
  if (!pieces.length || pieces.some((piece) => !/^\d{1,2}$/.test(piece))) invalidTask("Enter days from 1 to 31, separated by commas.")
  return integerList(pieces.map(Number), 1, 31, "Days of month")
}

export function readTaskCalendarTasks(payload: unknown): TaskCalendarTask[] {
  if (payload === null || payload === undefined) return []
  if (typeof payload !== "object" || Array.isArray(payload)) invalidTask("The saved task calendar is invalid. Please ask an administrator to review it.")
  const tasks = (payload as Record<string, unknown>).tasks
  if (!Array.isArray(tasks)) invalidTask("The saved task calendar has no valid task list. Please ask an administrator to review it.")
  const ids = new Set<string>()
  return tasks.map((task) => {
    const valid = validateTaskCalendarTask(task)
    if (ids.has(valid.id)) invalidTask("The saved task calendar contains duplicate task IDs. Please ask an administrator to review it.")
    ids.add(valid.id)
    return valid
  })
}

export const weekDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
export const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export const taskCalendarTasks: TaskCalendarTask[] = [
  { id: "task-comp-file", sourceRow: 7, scheduleType: "Weekly", dayOfWeek: 5, daysOfMonth: [], notify: ["VL", "SC", "OL", "KZ", "CY", "MY"], cc: [], task: "Unofficial Compensation Outstanding File", remark: "" },
  { id: "task-bank-intesa", sourceRow: 8, scheduleType: "Monthly", daysOfMonth: [1, 16], notify: ["LL"], cc: ["LC"], task: "FC Bank Interest Rate Table Update (Intesa - TD/TL)", remark: "" },
  { id: "task-bank-ubs", sourceRow: 9, scheduleType: "Monthly", daysOfMonth: [1, 16], notify: ["LL"], cc: ["LC"], task: "FC Bank Interest Rate Table Update (UBS - TD/TL/OD)", remark: "" },
  { id: "task-exchange-rate", sourceRow: 10, scheduleType: "Monthly", daysOfMonth: [1, 16], notify: ["LL"], cc: ["LC"], task: "FC Exchange Rate Table Update for A/C use & email to CC", remark: "" },
  { id: "task-expense-claim", sourceRow: 11, scheduleType: "Monthly", daysOfMonth: [1], notify: ["LL"], cc: ["VL"], task: "Expense Claim Submission", remark: "" },
  { id: "task-payment-buyer", sourceRow: 12, scheduleType: "Weekly", dayOfWeek: 3, daysOfMonth: [], notify: ["LL", "LC"], cc: ["VL"], task: "Payment Reminder to Buyer (WED)", remark: "" },
  { id: "task-comp-fcbv", sourceRow: 13, scheduleType: "Monthly", daysOfMonth: [1], notify: ["SC", "OL"], cc: ["VL", "SC", "OL", "KZ", "CY", "MY"], task: "Unofficial Compensation Outstanding File to FCBV", remark: "" },
  { id: "task-mop-price", sourceRow: 14, scheduleType: "Monthly", daysOfMonth: [1], notify: ["LC", "LL"], cc: ["VL"], task: "Ask VL for MOP's price to issue invoice to customer", remark: "" },
  { id: "task-funding-fcbv", sourceRow: 15, scheduleType: "Yearly", daysOfMonth: [2], months: [2, 4, 6, 8, 10, 12], notify: ["LL", "LC", "OL"], cc: ["VL"], task: "Payment for Funding to FCBV", remark: "" },
  { id: "task-cm-sinotrans", sourceRow: 16, scheduleType: "Weekly", dayOfWeek: 6, daysOfMonth: [], notify: ["LL", "LC", "VL"], cc: [], task: "Payment Reminder to CM/SINOTRANS GZ-GTL by Email & WeChat", remark: "" },
  { id: "task-general-expense", sourceRow: 20, scheduleType: "Monthly", daysOfMonth: [11, 26], notify: ["LL", "LC"], cc: [], task: "General Expense Payment", remark: "" },
  { id: "task-phonebook", sourceRow: 22, scheduleType: "Monthly", daysOfMonth: [15, 30], notify: ["VL"], cc: ["SC"], task: "Update Mobile Phonebook", remark: "" },
  { id: "task-misc-invoice", sourceRow: 24, scheduleType: "Monthly", daysOfMonth: [15], notify: ["LL", "LC"], cc: ["VL"], task: "Payment Reminder for Misc Invoice", remark: "" },
  { id: "task-sharing-invoice", sourceRow: 30, scheduleType: "Monthly", daysOfMonth: [25], notify: ["LL"], cc: ["VL", "LC"], task: "Issue Office Sharing Expense Invoice to Express Global HK", remark: "" },
  { id: "task-mpf", sourceRow: 31, scheduleType: "Monthly", daysOfMonth: [26], notify: ["LL", "LC"], cc: ["VL"], task: "MPF Upload to Manulife", remark: "" },
  { id: "task-medical-summary", sourceRow: 34, scheduleType: "Monthly", daysOfMonth: [30], notify: ["LL"], cc: ["LC"], task: "Staff Medical Expense Summary Update", remark: "" },
  { id: "task-bc-admin", sourceRow: 35, scheduleType: "Yearly", daysOfMonth: [30], months: [3, 6, 9, 12], notify: ["VL"], cc: [], task: "BC Administration", remark: "" },
]

export function getHongKongTaskDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date)
  const part = (type: string) => parts.find((item) => item.type === type)?.value || ""
  return `${part("year")}-${part("month")}-${part("day")}`
}

function taskDateParts(date: Date | string) {
  const key = typeof date === "string" ? date : getHongKongTaskDate(date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) invalidTask("The task reminder date is invalid.")
  const parsed = new Date(`${key}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== key) invalidTask("The task reminder date is invalid.")
  return { day: parsed.getUTCDate(), month: parsed.getUTCMonth() + 1, weekday: parsed.getUTCDay(), daysInMonth: new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).getUTCDate() }
}

function isDayDue(daysOfMonth: number[], date: Date | string) {
  const { day, daysInMonth } = taskDateParts(date)
  return daysOfMonth.some((target) => day === target || (day === daysInMonth && target > daysInMonth))
}

export function isTaskDueOnDate(task: TaskCalendarTask, date: Date | string = new Date()) {
  const { month, weekday } = taskDateParts(date)
  if (task.scheduleType === "Weekly") return weekday === task.dayOfWeek
  if (task.scheduleType === "Yearly" && !(task.months || []).includes(month)) return false
  return isDayDue(task.daysOfMonth, date)
}

export function getDueTaskCalendarTasks(date: Date | string = new Date(), tasks: TaskCalendarTask[] = []) {
  return tasks.filter((task) => isTaskDueOnDate(task, date))
}

export function getTaskScheduleText(task: TaskCalendarTask) {
  if (task.scheduleType === "Weekly") return `Weekly on ${weekDays[task.dayOfWeek ?? -1] || "weekday not selected"}`
  const days = task.daysOfMonth.join(", ")
  if (task.scheduleType === "Monthly") return `Monthly on day ${days}`
  const months = (task.months || []).map((month) => monthNames[month - 1]).join(", ")
  return `Yearly in ${months} on day ${days}`
}
