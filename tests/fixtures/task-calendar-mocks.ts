import type { TaskCalendarTask } from "../../data/taskCalendar"
import { ADMIN_PAGE_DEFINITIONS } from "../../lib/adminPages"

type TaskCalendarHarness = {
  tasks: TaskCalendarTask[]
  requests: { method: string; body: unknown }[]
  viewOnly: boolean
  revision: number
  failNext: boolean
  deferNext: boolean
  releaseWrite: (() => void) | null
  conflictNext: boolean
}

declare global { interface Window { __taskCalendarHarness: TaskCalendarHarness } }

export function installTaskCalendarHarness() {
  window.localStorage.clear()
  window.__taskCalendarHarness = {
    viewOnly: new URLSearchParams(window.location.search).get("access") === "view",
    requests: [],
    revision: 1,
    failNext: false,
    deferNext: false,
    releaseWrite: null,
    conflictNext: false,
    tasks: [
      { id: "synthetic-task-a", sourceRow: 1, scheduleType: "Monthly", daysOfMonth: [1, 16], months: [], notify: ["OL"], cc: ["VL"], task: "FIRST SYNTHETIC TASK", remark: "Original note" },
      { id: "synthetic-task-b", sourceRow: 2, scheduleType: "Weekly", dayOfWeek: 5, daysOfMonth: [], months: [], notify: ["VL"], cc: [], task: "SECOND SYNTHETIC TASK", remark: "" },
      { id: "synthetic-task-c", sourceRow: 3, scheduleType: "Yearly", daysOfMonth: [30], months: [3, 6, 9, 12], notify: ["LC"], cc: ["OL"], task: "THIRD SYNTHETIC TASK", remark: "" },
    ],
  }
  if (new URLSearchParams(window.location.search).get("empty") === "1") window.__taskCalendarHarness.tasks = []
  const versions = () => Object.fromEntries(window.__taskCalendarHarness.tasks.map((task) => [task.id, String(window.__taskCalendarHarness.revision).padStart(64, "0")]))
  const payload = () => ({ payload: { tasks: window.__taskCalendarHarness.tasks, deletedTaskIds: [] }, protocolVersion: 1, taskVersions: versions() })
  const staff = ["VL", "SC", "OL", "DT", "KZ", "CY", "MY", "LC", "LL", "JZ"].map((code) => ({ code, name: `${code} synthetic staff`, email: `${code.toLowerCase()}@example.test` }))
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    const method = init?.method || (input instanceof Request ? input.method : "GET")
    if (url.origin !== window.location.origin || url.pathname !== "/api/office-calendar-store/task-calendar") {
      throw new Error(`Unexpected request blocked by local task fixture: ${method} ${url.pathname}`)
    }
    const harness = window.__taskCalendarHarness
    const body = init?.body ? JSON.parse(String(init.body)) : null
    harness.requests.push({ method, body })
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } })
    if (method === "GET") return json({ ...payload(), staff })
    if (method === "PATCH") {
      if (harness.viewOnly) return json({ message: "Forbidden" }, 403)
      if (harness.deferNext) {
        harness.deferNext = false
        await new Promise<void>((resolve) => { harness.releaseWrite = resolve })
        harness.releaseWrite = null
      }
      if (harness.failNext) { harness.failNext = false; return json({ message: "Synthetic save failure. Please retry." }, 500) }
      if (harness.conflictNext) {
        harness.conflictNext = false
        harness.tasks[0].task = "OTHER USER SAVED TASK"
        harness.revision += 1
      }
      const id = body.task?.id || body.taskId
      if (body.operation !== "create" && versions()[id] !== body.expectedTaskVersion) return json({ ...payload(), message: "This task changed while you were editing. Your draft is kept. Cancel and reopen the latest task.", code: "TASK_CALENDAR_CONFLICT" }, 409)
      if (body.operation === "create") harness.tasks.unshift(body.task)
      else if (body.operation === "update") harness.tasks = harness.tasks.map((task) => task.id === id ? body.task : task)
      else if (body.operation === "delete") harness.tasks = harness.tasks.filter((task) => task.id !== id)
      else throw new Error("Unexpected task mutation")
      harness.revision += 1
      return json({ success: true, ...payload() })
    }
    throw new Error(`Unexpected local task fixture method: ${method}`)
  }
}

export function useSimpleAdminAuth() {
  return {
    loading: false,
    authenticated: true,
    resetRequired: false,
    username: "synthetic-user",
    displayName: "Synthetic user",
    role: "user",
    permissions: { "task-calendar": window.__taskCalendarHarness.viewOnly ? "view" as const : "edit" as const },
    pages: ADMIN_PAGE_DEFINITIONS,
  }
}

const router = { replace: () => {}, push: () => {} }
export function usePathname() { return "/admin/taskcalendar" }
export function useRouter() { return router }
