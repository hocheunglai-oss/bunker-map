export type TaskCalendarTask = {
  id: string
  sourceRow: number
  dayOfMonth: number
  notify: string[]
  cc: string[]
  task: string
  company: string
  frequency: "1 Monthly" | "2 Monthly" | "4 Monthly" | "4 Yearly" | "6 Yearly"
  remark: string
}

export const taskCalendarPeopleEmails: Record<string, string[]> = {
  LL: ["louisa@cosulich.com.hk"],
  LC: ["laureen@cosulich.com.hk"],
  SC: ["stanley@cosulich.com.hk"],
  VL: ["vincent@cosulich.com.hk"],
  OL: ["otto@cosulich.com.hk"],
  BT: [
    "vincent@cosulich.com.hk",
    "stanley@cosulich.com.hk",
    "otto@cosulich.com.hk",
    "kelvin@cosulich.com.hk",
    "chengyuan@cosulich.com.hk",
    "mayshen@cosulich.com.hk",
  ],
}

export const taskCalendarTasks: TaskCalendarTask[] = [
  { id: "task-7", sourceRow: 7, dayOfMonth: 1, notify: ["BT"], cc: [], task: "Unofficial Compensation Outststanding  File", company: "Fcb", frequency: "4 Monthly", remark: "" },
  { id: "task-8", sourceRow: 8, dayOfMonth: 1, notify: ["LL"], cc: ["LC"], task: "FC Bank Interest Rate Table Update (Intesa  - TD/TL)", company: "-", frequency: "2 Monthly", remark: "" },
  { id: "task-9", sourceRow: 9, dayOfMonth: 1, notify: ["LL"], cc: ["LC"], task: "FC Bank Interest Rate Table Update (UBS - TD/TL/OD)", company: "-", frequency: "2 Monthly", remark: "" },
  { id: "task-10", sourceRow: 10, dayOfMonth: 1, notify: ["LL"], cc: ["LC"], task: "FC Exchange Rate Table Update for A/C use & email to CC", company: "-", frequency: "2 Monthly", remark: "" },
  { id: "task-11", sourceRow: 11, dayOfMonth: 1, notify: ["LL"], cc: ["VL"], task: "Expense Claim Submission", company: "-", frequency: "1 Monthly", remark: "" },
  { id: "task-12", sourceRow: 12, dayOfMonth: 1, notify: ["LL", "LC"], cc: ["VL"], task: "Payment Reminder to Buyer (WED)", company: "Fcb", frequency: "4 Monthly", remark: "" },
  { id: "task-13", sourceRow: 13, dayOfMonth: 1, notify: ["SC", "OL"], cc: ["BT"], task: "Unofficial Compensation Outststanding File to Fcbv", company: "Fcb", frequency: "1 Monthly", remark: "" },
  { id: "task-14", sourceRow: 14, dayOfMonth: 1, notify: ["LC", "LL"], cc: ["VL"], task: "Ask VL for MOP's price to issue invoice to customer", company: "Fcb", frequency: "1 Monthly", remark: "" },
  { id: "task-15", sourceRow: 15, dayOfMonth: 2, notify: ["LL", "LC", "OL"], cc: ["VL"], task: "Payment for Funding to FCBV (Feb/Apr/Jun/Aug/Oct/Dec)", company: "Fcb", frequency: "6 Yearly", remark: "" },
  { id: "task-16", sourceRow: 16, dayOfMonth: 2, notify: ["LL", "LC", "VL"], cc: [], task: "Payment Reminder to CM/SINOTRANS GZ-GTL by Email & WeChat", company: "Fcb", frequency: "4 Monthly", remark: "" },
  { id: "task-17", sourceRow: 17, dayOfMonth: 8, notify: ["BT"], cc: [], task: "Unofficial Compensation Outststanding  File", company: "Fcb", frequency: "4 Monthly", remark: "" },
  { id: "task-18", sourceRow: 18, dayOfMonth: 8, notify: ["LL", "LC"], cc: ["VL"], task: "Payment Reminder to Buyer (WED)", company: "Fcb", frequency: "4 Monthly", remark: "" },
  { id: "task-19", sourceRow: 19, dayOfMonth: 9, notify: ["LL", "LC", "VL"], cc: [], task: "Payment Reminder to CM/SINOTRANS GZ-GTL by Email & WeChat", company: "Fcb", frequency: "4 Monthly", remark: "" },
  { id: "task-20", sourceRow: 20, dayOfMonth: 11, notify: ["LL", "LC"], cc: [], task: "General Expense Payment", company: "-", frequency: "2 Monthly", remark: "" },
  { id: "task-21", sourceRow: 21, dayOfMonth: 15, notify: ["BT"], cc: [], task: "Unofficial Compensation Outstanding  File", company: "Fcb", frequency: "4 Monthly", remark: "" },
  { id: "task-22", sourceRow: 22, dayOfMonth: 15, notify: ["VL"], cc: ["SC"], task: "Update Mobile Phonebook", company: "-", frequency: "2 Monthly", remark: "" },
  { id: "task-23", sourceRow: 23, dayOfMonth: 15, notify: ["LL", "LC"], cc: ["VL"], task: "Payment Reminder to Buyer (WED)", company: "Fcb", frequency: "4 Monthly", remark: "" },
  { id: "task-24", sourceRow: 24, dayOfMonth: 15, notify: ["LL", "LC"], cc: ["VL"], task: "Payment Reminder for Misc Invoice", company: "Fcb", frequency: "1 Monthly", remark: "" },
  { id: "task-25", sourceRow: 25, dayOfMonth: 16, notify: ["LL"], cc: ["LC"], task: "FC Bank Interest Rate Table Update (Intesa  - TD/TL)", company: "-", frequency: "2 Monthly", remark: "" },
  { id: "task-26", sourceRow: 26, dayOfMonth: 16, notify: ["LL"], cc: ["LC"], task: "FC Bank Interest Rate Table Update (UBS - TD/TL/OD)", company: "-", frequency: "2 Monthly", remark: "" },
  { id: "task-27", sourceRow: 27, dayOfMonth: 16, notify: ["LL"], cc: ["LC"], task: "FC Exchange Rate Table Update for A/C use & email to CC", company: "-", frequency: "2 Monthly", remark: "" },
  { id: "task-28", sourceRow: 28, dayOfMonth: 16, notify: ["LL", "LC", "VL"], cc: [], task: "Payment Reminder to CM/SINOTRANS GZ-GTL by Email & WeChat", company: "Fcb", frequency: "4 Monthly", remark: "" },
  { id: "task-29", sourceRow: 29, dayOfMonth: 22, notify: ["LL", "LC"], cc: ["VL"], task: "Payment Reminder to Buyer (WED)", company: "Fcb", frequency: "4 Monthly", remark: "" },
  { id: "task-30", sourceRow: 30, dayOfMonth: 25, notify: ["LL"], cc: ["VL", "LC"], task: "Issue Office Sharing Expense Invoice to Express Global HK", company: "Fcb", frequency: "1 Monthly", remark: "" },
  { id: "task-31", sourceRow: 31, dayOfMonth: 26, notify: ["LL", "LC"], cc: ["VL"], task: "MPF Upload to Manulife", company: "-", frequency: "1 Monthly", remark: "" },
  { id: "task-32", sourceRow: 32, dayOfMonth: 26, notify: ["LL", "LC"], cc: [], task: "General Expense Payment", company: "-", frequency: "2 Monthly", remark: "" },
  { id: "task-33", sourceRow: 33, dayOfMonth: 30, notify: ["VL"], cc: ["SC"], task: "Update Mobile Phonebook", company: "-", frequency: "2 Monthly", remark: "" },
  { id: "task-34", sourceRow: 34, dayOfMonth: 30, notify: ["LL"], cc: ["LC"], task: "Staff Medical Expense Summary Update", company: "-", frequency: "1 Monthly", remark: "" },
  { id: "task-35", sourceRow: 35, dayOfMonth: 30, notify: ["VL"], cc: ["SY"], task: "BC Administration (Mar/Jun/ Sep/ Dec)", company: "Fcb", frequency: "4 Yearly", remark: "" },
]

const monthMap: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

function getDaysInMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
}

export function getTaskActiveMonths(task: TaskCalendarTask) {
  if (!task.frequency.includes("Yearly")) return null
  const matches = task.task.match(/\(([^)]*)\)/)?.[1] || ""
  const months = matches
    .split(/[\/,\s]+/)
    .map((item) => monthMap[item.slice(0, 3).toLowerCase()])
    .filter((item): item is number => Boolean(item))

  return months.length ? months : null
}

export function isTaskDueOnDate(task: TaskCalendarTask, date = new Date()) {
  const activeMonths = getTaskActiveMonths(task)
  const month = date.getMonth() + 1
  if (activeMonths && !activeMonths.includes(month)) return false

  const day = date.getDate()
  const daysInMonth = getDaysInMonth(date)
  return day === task.dayOfMonth || (day === daysInMonth && task.dayOfMonth > daysInMonth)
}

export function getDueTaskCalendarTasks(date = new Date()) {
  return taskCalendarTasks.filter((task) => isTaskDueOnDate(task, date))
}

export function resolveTaskRecipients(codes: string[]) {
  return Array.from(new Set(codes.flatMap((code) => taskCalendarPeopleEmails[code] || [])))
}
