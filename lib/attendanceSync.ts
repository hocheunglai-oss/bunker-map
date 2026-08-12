import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  DINGTALK_ATTENDANCE_MAX_USERS,
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
  listRecords(input: unknown): Promise<{
    query: unknown
    records: DingTalkAttendanceRecord[]
  }>
}

type AttendanceSyncOptions = {
  now?: Date
  client?: AttendanceRecordClient
  supabase?: SupabaseClient
}

function rollingWindow(now: Date) {
  const todayText = hktDateFromTimestamp(now)
  const today = parseIsoDate(todayText)!.date
  const fromDate = formatIsoDate(
    new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000),
  )
  const from = hktTimestampForDateAndTime(fromDate, "00:00:00")!
  return { from, to: now }
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
  const supabase = options.supabase || getAttendanceServiceClient()
  const client = options.client || getDingTalkAttendanceClient()
  const window = rollingWindow(now)

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
  let batchesAttempted = 0
  let recordsFetched = 0
  let recordsInserted = 0
  const errors: string[] = []

  try {
    const { data: personRows, error: personError } = await supabase
      .from("attendance_people")
      .select("id,dingtalk_user_id")
      .eq("is_active", true)
      .not("dingtalk_user_id", "is", null)
      .order("staff_code")
    if (personError) throw personError

    const people = (personRows || []).flatMap((row) => {
      const value = row as { id?: unknown; dingtalk_user_id?: unknown }
      const dingtalkUserId =
        typeof value.dingtalk_user_id === "string"
          ? value.dingtalk_user_id.trim().slice(0, 128)
          : ""
      return dingtalkUserId
        ? [{ id: String(value.id), dingtalkUserId } satisfies AttendanceSyncPerson]
        : []
    })
    peopleRequested = people.length
    const personByDingTalkId = new Map(
      people.map((person) => [person.dingtalkUserId, person]),
    )

    for (const batch of batches(people, DINGTALK_ATTENDANCE_MAX_USERS)) {
      batchesAttempted += 1
      try {
        const result = await client.listRecords({
          userIds: batch.map((person) => person.dingtalkUserId),
          checkDateFrom: formatDingTalkHktTimestamp(window.from),
          checkDateTo: formatDingTalkHktTimestamp(window.to),
          isI18n: false,
        })
        recordsFetched += result.records.length
        const normalized = result.records.flatMap((record) => {
          const punch = normalizeDingTalkPunch(record, personByDingTalkId)
          return punch && isImportableDingTalkPunch(punch.punch_time) ? [punch] : []
        })
        const invalidCount = result.records.filter(
          (record) => !normalizeDingTalkPunch(record, personByDingTalkId),
        ).length
        if (invalidCount) {
          errors.push(`${invalidCount} DingTalk record(s) had invalid or unmapped fields.`)
        }
        for (const insertBatch of batches(normalized, 1000)) {
          const { data: inserted, error: insertError } = await supabase.rpc(
            "insert_attendance_raw_punches",
            { p_rows: insertBatch },
          )
          if (insertError) throw insertError
          recordsInserted += Number(inserted || 0)
        }
      } catch (error) {
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
        batches_attempted: batchesAttempted,
        records_fetched: recordsFetched,
        records_inserted: recordsInserted,
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
        batches_attempted: batchesAttempted,
        records_fetched: recordsFetched,
        records_inserted: recordsInserted,
        error_summary: message,
      })
      .eq("id", runId)
    throw error
  }
}
