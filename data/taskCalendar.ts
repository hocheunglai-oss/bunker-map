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

export const taskCalendarPeopleEmails: Record<string, string[]> = {
  LL: ["louisa@cosulich.com.hk"],
  LC: ["laureen@cosulich.com.hk"],
  SC: ["stanley@cosulich.com.hk"],
  VL: ["vincent@cosulich.com.hk"],
  OL: ["otto@cosulich.com.hk"],
  KZ: ["kelvin@cosulich.com.hk"],
  CY: ["chengyuan@cosulich.com.hk"],
  MY: ["mayshen@cosulich.com.hk"],
}

export const weekDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
export const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export const taskCalendarTasks: TaskCalendarTask[] = [
  { id: "task-comp-file", sourceRow: 7, scheduleType: "Weekly", dayOfWeek: 5, daysOfMonth: [], notify: ["VL", "SC", "OL", "KZ", "CY", "MY"], cc: [], task: "Unofficial Compensation Outstanding File", remark: "" },
  { id: "task-bank-intesa", sourceRow: 8, scheduleType: "Monthly", daysOfMonth: [1, 16], notify: ["LL"], cc: ["LC"], task: "FC Bank Interest Rate Table Update (Intesa - TD/TL)", remark: "" },
  { id: "task-bank-ubs", sourceRow: 9, scheduleType: "Monthly", daysOfMonth: [1, 16], notify: ["LL"], cc: ["LC"], task: "FC Bank Interest Rate Table Update (UBS - TD/TL/OD)", remark: "" },
  { id: "task-exchange-rate", sourceRow: 10, scheduleType: "Monthly", daysOfMonth: [1, 16], notify: ["LL"], cc: ["LC"], task: "FC Exchange Rate Table Update for A/C use & email to CC", remark: "" },
  { id: "task-expense-claim", sourceRow: 11, scheduleType: "Monthly", daysOfMonth: [1], notify: ["LL"], cc: ["VL"], task: "Expense Claim Submission", remark: "" },
  { id: "task-payment-buyer", sourceRow: 12, scheduleType: "Weekly", dayOfWeek: 5, daysOfMonth: [], notify: ["LL", "LC"], cc: ["VL"], task: "Payment Reminder to Buyer (WED)", remark: "" },
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

function getDaysInMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
}

function isDayDue(daysOfMonth: number[], date: Date) {
  const day = date.getDate()
  const daysInMonth = getDaysInMonth(date)
  return daysOfMonth.some((target) => day === target || (day === daysInMonth && target > daysInMonth))
}

export function isTaskDueOnDate(task: TaskCalendarTask, date = new Date()) {
  if (task.scheduleType === "Weekly") return date.getDay() === task.dayOfWeek
  if (task.scheduleType === "Yearly" && !(task.months || []).includes(date.getMonth() + 1)) return false
  return isDayDue(task.daysOfMonth, date)
}

export function getDueTaskCalendarTasks(date = new Date(), tasks = taskCalendarTasks) {
  return tasks.filter((task) => isTaskDueOnDate(task, date))
}

export function getTaskScheduleText(task: TaskCalendarTask) {
  if (task.scheduleType === "Weekly") return `Weekly on ${weekDays[task.dayOfWeek || 0]}`
  const days = task.daysOfMonth.join(", ")
  if (task.scheduleType === "Monthly") return `Monthly on day ${days}`
  const months = (task.months || []).map((month) => monthNames[month - 1]).join(", ")
  return `Yearly in ${months} on day ${days}`
}

export function resolveTaskRecipients(codes: string[]) {
  return Array.from(new Set(codes.flatMap((code) => taskCalendarPeopleEmails[code] || [])))
}
