import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  DINGTALK_ATTENDANCE_MAX_USERS,
  DINGTALK_ATTENDANCE_MAX_RANGE_DAYS,
  DINGTALK_ATTENDANCE_MAX_AGE_DAYS,
  type DingTalkAttendanceRecord,
  getDingTalkAttendanceClient,
} from "@/lib/dingTalkAttendance"
import { getAttendanceServiceClient } from "@/lib/attendanceData"
import {
  isImportableDingTalkPunch,
  type AttendanceSyncPerson,
  normalizeDingTalkPunch,
} from "@/lib/attendanceSyncRecords"
import {
  formatDingTalkHktTimestamp,
  formatIsoDate,
  hktDateFromTimestamp,
  hktTimestampForDateAndTime,
  parseIsoDate,
} from "@/lib/attendanceRules"

type AttendanceRecordClient = {
  listRecords(input: unknown, options?: { signal?: AbortSignal }): Promise<{
    query: unknown
    records: DingTalkAttendanceRecord[]
  }>
}

type AttendanceSyncOptions = {
  now?: Date
  client?: AttendanceRecordClient
  supabase?: SupabaseClient
  window?: { from: Date; to: Date }
  people?: AttendanceSyncPerson[]
  signal?: AbortSignal
}

type AttendanceMonthRequeryOptions = {
  year: number
  month: number
  people: AttendanceSyncPerson[]
  now?: Date
  client?: AttendanceRecordClient
  supabase?: SupabaseClient
  signal?: AbortSignal
}

const DAY_MS = 24 * 60 * 60 * 1000

function rollingWindow(now: Date) {
  const todayText = hktDateFromTimestamp(now)
  const today = parseIsoDate(todayText)!.date
  const fromDate = formatIsoDate(
    new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000),
  )
  const from = hktTimestampForDateAndTime(fromDate, "00:00:00")!
  return { from, to: new Date(Math.floor(now.getTime() / 1000) * 1000) }
}

function batches<T>(values: T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function runAttendanceSync(options: AttendanceSyncOptions = {}) {
  const now = options.now || new Date()
  if (!Number.isFinite(now.getTime())) throw new Error("Attendance sync time is invalid.")
  options.signal?.throwIfAborted()
  const supabase = options.supabase || getAttendanceServiceClient()
  const client = options.client || getDingTalkAttendanceClient()
  const requestedWindow = options.window || rollingWindow(now)
  // DingTalk accepts whole-second bounds. Persist precisely the bounds sent
  // upstream so a sync never certifies a fraction of time it did not query.
  const window = {
    from: new Date(Math.floor(requestedWindow.from.getTime() / 1000) * 1000),
    to: new Date(Math.floor(requestedWindow.to.getTime() / 1000) * 1000),
  }
  if (
    !Number.isFinite(window.from.getTime()) || !Number.isFinite(window.to.getTime()) ||
    window.from >= window.to || window.to > now ||
    window.to.getTime() - window.from.getTime() > DINGTALK_ATTENDANCE_MAX_RANGE_DAYS * DAY_MS ||
    window.from.getTime() < now.getTime() - DINGTALK_ATTENDANCE_MAX_AGE_DAYS * DAY_MS
  ) {
    throw new Error("Attendance sync window is outside DingTalk's permitted range.")
  }

  const { data: runData, error: runError } = await supabase
    .from("attendance_sync_runs")
    .insert({
      window_from: window.from.toISOString(),
      window_to: window.to.toISOString(),
      status: "running",
    })
    .select("id")
    .single()
  if (runError) throw runError
  const runId = String((runData as { id: unknown }).id)

  let peopleRequested = 0
  let requestedPeople: Record<string, string> = {}
  let batchesAttempted = 0
  let recordsFetched = 0
  let recordsInserted = 0
  const errors: string[] = []
  let failureUnknown = false
  const failureAffected = new Map<string, { person_id: string | null; work_date: string }>()
  const addFailureDate = (personId: string | null, workDate: string) => {
    failureAffected.set(`${personId || "*"}:${workDate}`, {
      person_id: personId, work_date: workDate,
    })
  }
  const failureScope = () => ({
    unknown: failureUnknown,
    affected: [...failureAffected.values()],
  })

  try {
    let people = options.people
    if (!people) {
      const { data: personRows, error: personError } = await supabase
        .from("attendance_people")
        .select("id,dingtalk_user_id")
        .eq("is_active", true)
        .not("dingtalk_user_id", "is", null)
        .order("staff_code")
      if (personError) throw personError
      people = (personRows || []).flatMap((row) => {
        const value = row as { id?: unknown; dingtalk_user_id?: unknown }
        const dingtalkUserId =
          typeof value.dingtalk_user_id === "string"
            ? value.dingtalk_user_id.trim().slice(0, 128)
            : ""
        return dingtalkUserId
          ? [{ id: String(value.id), dingtalkUserId } satisfies AttendanceSyncPerson]
          : []
      })
    }
    options.signal?.throwIfAborted()
    if (!people.length) {
      throw new Error("No DingTalk-linked attendance people were available for synchronization.")
    }
    if (new Set(people.map((person) => person.id)).size !== people.length ||
        people.some((person) => !person.id.trim() || !person.dingtalkUserId.trim())) {
      throw new Error("Attendance sync people contain a blank or duplicate identity.")
    }
    if (new Set(people.map((person) => person.dingtalkUserId)).size !== people.length) {
      throw new Error("Multiple attendance people share a DingTalk user ID; synchronization is unsafe.")
    }
    peopleRequested = people.length
    requestedPeople = Object.fromEntries(
      people.map((person) => [person.id, person.dingtalkUserId]),
    )
    for (const batch of batches(people, DINGTALK_ATTENDANCE_MAX_USERS)) {
      options.signal?.throwIfAborted()
      batchesAttempted += 1
      try {
        // The response must contain only identities requested in this batch.
        const personByDingTalkId = new Map(
          batch.map((person) => [person.dingtalkUserId, person]),
        )
        const requestFrom = formatDingTalkHktTimestamp(window.from)
        const requestTo = formatDingTalkHktTimestamp(window.to)
        const result = await client.listRecords({
          userIds: batch.map((person) => person.dingtalkUserId),
          checkDateFrom: requestFrom,
          checkDateTo: requestTo,
          isI18n: false,
        }, { signal: options.signal })
        options.signal?.throwIfAborted()
        recordsFetched += result.records.length
        const mapped = result.records.map((record) => normalizeDingTalkPunch(record, personByDingTalkId))
        const inRequestedWindow = (punch: NonNullable<(typeof mapped)[number]>) => {
          const at = Date.parse(punch.punch_time)
          return at >= window.from.getTime() && at <= window.to.getTime()
        }
        let invalidCount = 0
        for (let index = 0; index < mapped.length; index += 1) {
          const punch = mapped[index]
          if (punch && inRequestedWindow(punch)) continue
          invalidCount += 1
          const record = result.records[index]
          const timestamp = Number(record.userCheckTime)
          if (!Number.isFinite(timestamp) || timestamp < window.from.getTime() ||
              timestamp > window.to.getTime()) {
            failureUnknown = true
            continue
          }
          const userId = typeof record.userId === "string"
            ? record.userId.trim().slice(0, 128) : String(record.userId ?? "").trim().slice(0, 128)
          addFailureDate(personByDingTalkId.get(userId)?.id || null,
            hktDateFromTimestamp(new Date(timestamp)))
        }
        const normalizedAll = mapped.flatMap((punch) => punch && inRequestedWindow(punch) ? [punch] : [])
        const normalized = normalizedAll.filter((punch) => isImportableDingTalkPunch(punch.punch_time))
        if (invalidCount) {
          errors.push(`${invalidCount} DingTalk record(s) had invalid or unmapped fields.`)
        }
        for (const insertBatch of batches(normalized, 1000)) {
          options.signal?.throwIfAborted()
          const { data: inserted, error: insertError } = await supabase.rpc(
            "insert_attendance_raw_punches_checked",
            { p_rows: insertBatch },
          )
          if (insertError) throw insertError
          const result = inserted as { inserted_count?: unknown; anomaly_count?: unknown } | null
          const insertedCount = result?.inserted_count
          const anomalyCount = result?.anomaly_count
          if (typeof insertedCount !== "number" || !Number.isInteger(insertedCount) || insertedCount < 0 ||
              typeof anomalyCount !== "number" || !Number.isInteger(anomalyCount) || anomalyCount < 0) {
            throw new Error("Attendance punch insertion returned an invalid result.")
          }
          recordsInserted += insertedCount
          if (anomalyCount) {
            errors.push(`${anomalyCount} changed DingTalk record(s) require review.`)
          }
        }
        if (!invalidCount) {
          options.signal?.throwIfAborted()
          const { data: reconciliation, error: reconciliationError } = await supabase.rpc(
            "reconcile_attendance_dingtalk_punch_window",
            {
              p_requested_users: batch.map((person) => ({
                person_id: person.id,
                dingtalk_user_id: person.dingtalkUserId,
              })),
              p_window_from: window.from.toISOString(),
              p_window_to: window.to.toISOString(),
              p_returned_source_keys: [...new Set(normalizedAll.map((punch) => punch.source_record_key))],
              p_complete: true,
            },
          )
          if (reconciliationError) throw reconciliationError
          const missingCount = (reconciliation as { missing_count?: unknown } | null)?.missing_count
          if (typeof missingCount !== "number" || !Number.isInteger(missingCount) || missingCount < 0) {
            throw new Error("Attendance punch reconciliation returned an invalid result.")
          }
          if (missingCount) {
            errors.push(`${missingCount} missing DingTalk record(s) require review.`)
          }
        }
      } catch (error) {
        failureUnknown = true
        errors.push(`Batch ${batchesAttempted}: ${errorMessage(error)}`)
      }
    }

    const status = errors.length
      ? batchesAttempted > errors.filter((message) => message.startsWith("Batch ")).length
        ? "partial"
        : "failed"
      : "succeeded"
    const completedAt = new Date().toISOString()
    const errorSummary = errors.length ? errors.join(" ").slice(0, 4000) : null
    const { error: completionError } = await supabase
      .from("attendance_sync_runs")
      .update({
        completed_at: completedAt,
        status,
        people_requested: peopleRequested,
        requested_people: requestedPeople,
        batches_attempted: batchesAttempted,
        records_fetched: recordsFetched,
        records_inserted: recordsInserted,
        failure_scope: failureScope(),
        error_summary: errorSummary,
      })
      .eq("id", runId)
    if (completionError) throw completionError

    return {
      runId,
      status,
      windowFrom: window.from.toISOString(),
      windowTo: window.to.toISOString(),
      peopleRequested,
      batchesAttempted,
      recordsFetched,
      recordsInserted,
      errorSummary,
    }
  } catch (error) {
    const message = errorMessage(error).slice(0, 4000)
    await supabase
      .from("attendance_sync_runs")
      .update({
        completed_at: new Date().toISOString(),
        status: "failed",
        people_requested: peopleRequested,
        requested_people: requestedPeople,
        batches_attempted: batchesAttempted,
        records_fetched: recordsFetched,
        records_inserted: recordsInserted,
        failure_scope: { unknown: true, affected: failureScope().affected },
        error_summary: message,
      })
      .eq("id", runId)
    throw error
  }
}

export function attendanceMonthSyncWindows(year: number, month: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2200 ||
      !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Attendance requery month is invalid.")
  }
  const firstDay = formatIsoDate(new Date(Date.UTC(year, month - 1, 1)))
  const nextMonthFirstDay = formatIsoDate(new Date(Date.UTC(year, month, 1)))
  const from = hktTimestampForDateAndTime(firstDay, "00:00:00")!
  const end = hktTimestampForDateAndTime(nextMonthFirstDay, "00:00:00")!
  const windows: Array<{ from: Date; to: Date }> = []
  for (let cursor = from.getTime(); cursor < end.getTime();) {
    const to = Math.min(cursor + DINGTALK_ATTENDANCE_MAX_RANGE_DAYS * DAY_MS, end.getTime())
    windows.push({ from: new Date(cursor), to: new Date(to) })
    cursor = to
  }
  return windows
}

export async function requeryAttendanceMonthForAutoConfirmation(
  options: AttendanceMonthRequeryOptions,
) {
  const now = options.now || new Date()
  if (!Number.isFinite(now.getTime())) throw new Error("Attendance requery time is invalid.")
  const windows = attendanceMonthSyncWindows(options.year, options.month)
  if (windows[0].from.getTime() < now.getTime() - DINGTALK_ATTENDANCE_MAX_AGE_DAYS * DAY_MS) {
    throw new Error("Attendance auto-confirm blocked: the month is older than DingTalk's query limit.")
  }
  if (!options.people.length) return { windows: windows.length, runs: 0 }

  const supabase = options.supabase || getAttendanceServiceClient()
  const client = options.client || getDingTalkAttendanceClient()
  const people = [...options.people].sort((left, right) => left.id.localeCompare(right.id))
  const work = windows.flatMap((window) => batches(people, DINGTALK_ATTENDANCE_MAX_USERS)
    .map((batch) => ({ window, people: batch })))
  const failures: string[] = []
  let next = 0
  let succeeded = 0
  const worker = async () => {
    while (next < work.length && !failures.length) {
      if (options.signal?.aborted) {
        failures.push("Attendance month requery exceeded its time budget.")
        return
      }
      const item = work[next++]
      try {
        const result = await runAttendanceSync({
          now, client, supabase, window: item.window, people: item.people,
          signal: options.signal,
        })
        if (result.status === "succeeded") succeeded += 1
        else failures.push(`Attendance month requery ${result.runId} was ${result.status}.`)
      } catch (error) {
        failures.push(errorMessage(error))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, work.length) }, worker))
  options.signal?.throwIfAborted()
  if (failures.length || succeeded !== work.length) {
    throw new Error(`Attendance auto-confirm blocked: full-month DingTalk requery failed. ${failures.join(" ")}`)
  }
  return { windows: windows.length, runs: succeeded }
}
