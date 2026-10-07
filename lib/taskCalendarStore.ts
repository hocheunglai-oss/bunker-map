import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { TaskCalendarValidationError, validateTaskCalendarTask } from "@/data/taskCalendar"

type RecordValue = Record<string, unknown>
export type TaskCalendarMutation = {
  operation: "create" | "update" | "delete"
  task?: unknown
  taskId?: unknown
  expectedTaskVersion?: unknown
}

const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
}
function json(value: unknown) { return JSON.stringify(canonical(value)) }
export function getTaskCalendarTaskVersion(value: unknown) { return createHash("sha256").update(json(value) ?? "null").digest("hex") }
export function getTaskCalendarVersions(payload: unknown) {
  const tasks = record(payload).tasks
  return Object.fromEntries((Array.isArray(tasks) ? tasks : []).filter((task) => typeof record(task).id === "string").map((task) => [String(record(task).id), getTaskCalendarTaskVersion(task)]))
}

export class TaskCalendarConflictError extends Error {
  readonly code = "TASK_CALENDAR_CONFLICT"
  readonly payload: RecordValue
  readonly taskVersions: Record<string, string>
  constructor(payload: unknown) {
    super("This task changed while you were editing. Your draft is kept, but nothing was overwritten. Cancel and reopen the latest task before saving again.")
    this.name = "TaskCalendarConflictError"
    this.payload = record(payload)
    this.taskVersions = getTaskCalendarVersions(payload)
  }
}

export function applyTaskCalendarMutation(currentValue: unknown, mutation: TaskCalendarMutation) {
  const current = record(currentValue)
  if (currentValue != null && !Array.isArray(current.tasks)) throw new TaskCalendarValidationError("The saved task list is invalid. Nothing was changed.")
  const tasks: unknown[] = Array.isArray(current.tasks) ? [...current.tasks] : []
  const deleted = new Set(Array.isArray(current.deletedTaskIds) ? current.deletedTaskIds.filter((id): id is string => typeof id === "string") : [])
  if (!["create", "update", "delete"].includes(mutation.operation)) throw new TaskCalendarValidationError("Unknown task change.")
  const incoming = mutation.operation === "delete" ? null : validateTaskCalendarTask(mutation.task)
  const id = incoming?.id ?? mutation.taskId
  if (typeof id !== "string" || !id.trim() || id.length > 200) throw new TaskCalendarValidationError("A valid task ID is required.")
  const index = tasks.findIndex((task) => record(task).id === id)
  const existing = index >= 0 ? tasks[index] : null
  if (mutation.operation === "create") {
    if (deleted.has(id)) throw new TaskCalendarConflictError(current)
    if (existing) {
      if (json(existing) === json(incoming)) return current
      throw new TaskCalendarConflictError(current)
    }
    tasks.unshift(incoming)
  } else {
    if (mutation.operation === "delete" && !existing && deleted.has(id)) return current
    if (!existing) throw new TaskCalendarConflictError(current)
    if (mutation.operation === "update" && json(existing) === json(incoming)) return current
    if (typeof mutation.expectedTaskVersion !== "string" || !/^[a-f0-9]{64}$/.test(mutation.expectedTaskVersion) || mutation.expectedTaskVersion !== getTaskCalendarTaskVersion(existing)) throw new TaskCalendarConflictError(current)
    if (mutation.operation === "delete") {
      tasks.splice(index, 1)
      deleted.add(id)
    } else tasks[index] = incoming
  }
  return { ...current, tasks, deletedTaskIds: [...deleted] }
}

/** Per-record versions prevent stale edits; timestamp CAS makes the shared-row merge atomic. */
export async function mutateTaskCalendarStore(supabase: SupabaseClient, mutation: TaskCalendarMutation) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const { data: current, error: readError } = await supabase.from("office_calendar_store").select("payload, updated_at").eq("key", "task-calendar").maybeSingle()
    if (readError) throw readError
    const nextPayload = applyTaskCalendarMutation(current?.payload, mutation)
    if (current && json(nextPayload) === json(current.payload)) return current.payload
    const nextUpdatedAt = new Date(Math.max(Date.now(), current?.updated_at ? new Date(current.updated_at).getTime() + 1 : 0)).toISOString()
    if (!current) {
      const { data: inserted, error } = await supabase.from("office_calendar_store").insert({ key: "task-calendar", payload: nextPayload, updated_at: nextUpdatedAt }).select("payload").maybeSingle()
      if (error?.code === "23505") continue
      if (error) throw error
      if (inserted) return inserted.payload
    } else {
      const { data: updated, error } = await supabase.from("office_calendar_store").update({ payload: nextPayload, updated_at: nextUpdatedAt }).eq("key", "task-calendar").eq("updated_at", current.updated_at).select("payload").maybeSingle()
      if (error) throw error
      if (updated) return updated.payload
    }
  }
  throw new Error("The task calendar changed repeatedly while saving. Your draft is kept. Please try again.")
}
