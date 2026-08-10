import { NextResponse } from "next/server"
import {
  hasAdminPagePermission,
  requireAdminPagePermissionForRequest,
} from "@/lib/adminAuth"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import {
  AttendanceValidationError,
  attendancePersonBelongsToAdminUser,
  deleteAttendanceLeave,
  deleteAttendanceMonthlyAdjustment,
  deleteAttendanceOverride,
  getAttendanceLeave,
  getAllTimeAttendance,
  getAttendanceSettings,
  getDailyAttendance,
  getMonthlyAttendance,
  saveAttendanceDayEdit,
  saveAttendanceEntitlement,
  saveAttendanceLeaveRange,
  saveAttendanceMonthlyAdjustment,
  saveAttendanceMonthlyConfirmation,
  saveAttendanceOverride,
  saveAttendancePerson,
  saveAttendanceWorkMode,
  removeAttendancePerson,
  sendAttendanceConfirmationReminders,
} from "@/lib/attendanceData"
import { ATTENDANCE_PAGE_ID, hktDateFromTimestamp } from "@/lib/attendanceRules"
import { runAttendanceSync } from "@/lib/attendanceSync"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
}

function privateJson(body: unknown, init: ResponseInit = {}) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...PRIVATE_HEADERS, ...init.headers },
  })
}

function errorStatus(error: unknown) {
  if (!(error instanceof Error)) return 500
  if (error.message === "Unauthorized") return 401
  if (error.message === "Forbidden") return 403
  if (error instanceof AttendanceValidationError) return 400
  return 500
}

function publicError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback
  const status = errorStatus(error)
  return status < 500 ? error.message : fallback
}

async function readJson(request: Request) {
  try {
    const value = await request.json()
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AttendanceValidationError("A JSON object is required.")
    }
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof AttendanceValidationError) throw error
    throw new AttendanceValidationError("A valid JSON request body is required.")
  }
}

export async function GET(request: Request) {
  try {
    const session = await requireAdminPagePermissionForRequest(
      request,
      ATTENDANCE_PAGE_ID,
      "view",
    )
    const url = new URL(request.url)
    const view = url.searchParams.get("view") || "daily"
    const canEdit = hasAdminPagePermission(session, ATTENDANCE_PAGE_ID, "edit")
    let response: unknown
    if (view === "daily") {
      response = await getDailyAttendance(
        url.searchParams.get("date") || hktDateFromTimestamp(new Date()),
      )
    } else if (view === "leave") {
      response = await getAttendanceLeave(url.searchParams.get("year"))
    } else if (view === "monthly") {
      const scope = url.searchParams.get("scope")
      if (scope && scope !== "year") {
        throw new AttendanceValidationError("Attendance scope is unsupported.")
      }
      response = await getMonthlyAttendance(
        url.searchParams.get("year"),
        url.searchParams.get("month"),
        {
          adminUserId: session.adminUserId,
          canEdit,
          includeYearSummary: scope === "year",
        },
      )
    } else if (view === "all-time") {
      response = await getAllTimeAttendance(url.searchParams.get("year"), {
        includeAvailableUsers: canEdit,
      })
    } else if (view === "settings") {
      response = await getAttendanceSettings(url.searchParams.get("year"), {
        includeAvailableUsers: canEdit,
      })
    } else {
      throw new AttendanceValidationError("Attendance view is unsupported.")
    }
    return privateJson(response)
  } catch (error) {
    const status = errorStatus(error)
    if (status >= 500) console.error("Attendance read failed", error)
    return privateJson(
      { message: publicError(error, "Could not load attendance records.") },
      { status },
    )
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermissionForRequest(
      request,
      ATTENDANCE_PAGE_ID,
      "view",
    )
    const payload = await readJson(request)
    const action = payload.action
    if (typeof action !== "string") {
      throw new AttendanceValidationError("Attendance action is required.")
    }
    const actor = session.username || session.displayName
    if (!actor) throw new Error("Unauthorized")
    const context = createAdminAuditContext(session, request, ATTENDANCE_PAGE_ID)
    const client = createAdminAuditedSupabaseClient(context, { useServiceRole: true })
    const canEdit = hasAdminPagePermission(session, ATTENDANCE_PAGE_ID, "edit")

    if (action === "save-confirmation") {
      const confirmationInput = payload.confirmation
      const confirmationRow =
        confirmationInput &&
        typeof confirmationInput === "object" &&
        !Array.isArray(confirmationInput)
          ? (confirmationInput as Record<string, unknown>)
          : {}
      if (!canEdit) {
        if (confirmationRow.status !== "confirmed") {
          throw new Error("Forbidden")
        }
        const ownsPerson = session.adminUserId
          ? await attendancePersonBelongsToAdminUser(
              client,
              confirmationRow.personId,
              session.adminUserId,
            )
          : false
        if (!ownsPerson) throw new Error("Forbidden")
      }
      const confirmation = await saveAttendanceMonthlyConfirmation(
        client,
        confirmationInput,
        actor,
      )
      return privateJson({ success: true, confirmation })
    }

    if (!canEdit) throw new Error("Forbidden")

    if (action === "save-person" || action === "save-employee") {
      const person = await saveAttendancePerson(
        client,
        payload.person ?? payload.employee,
      )
      return privateJson({ success: true, person })
    }
    if (action === "remove-person") {
      const person = await removeAttendancePerson(client, payload.id)
      return privateJson({ success: true, person })
    }
    if (action === "save-leave") {
      const leaveEntries = await saveAttendanceLeaveRange(client, payload.leave, actor)
      return privateJson({ success: true, leaveEntries })
    }
    if (action === "delete-leave") {
      await deleteAttendanceLeave(client, payload.id)
      return privateJson({ success: true })
    }
    if (action === "save-day-edit") {
      const dayEdit = await saveAttendanceDayEdit(client, payload.dayEdit, actor)
      return privateJson({ success: true, ...dayEdit })
    }
    if (action === "save-work-mode") {
      const workModeOverride = await saveAttendanceWorkMode(
        client,
        payload.workMode,
        actor,
      )
      return privateJson({ success: true, workModeOverride })
    }
    if (action === "save-override") {
      const requested = Array.isArray(payload.overrides)
        ? payload.overrides
        : [payload.override]
      if (!requested.length || requested.length > 20) {
        throw new AttendanceValidationError("One to twenty overrides are required.")
      }
      const overrides = []
      for (const input of requested) {
        overrides.push(await saveAttendanceOverride(client, input, actor))
      }
      return privateJson({
        success: true,
        overrides,
        override: overrides.length === 1 ? overrides[0] : undefined,
      })
    }
    if (action === "delete-override") {
      await deleteAttendanceOverride(client, payload.id)
      return privateJson({ success: true })
    }
    if (action === "save-entitlement") {
      const entitlement = await saveAttendanceEntitlement(
        client,
        payload.entitlement,
        actor,
      )
      return privateJson({ success: true, entitlement })
    }
    if (action === "save-monthly-adjustment") {
      const adjustment = await saveAttendanceMonthlyAdjustment(
        client,
        payload.adjustment,
        actor,
      )
      return privateJson({ success: true, adjustment })
    }
    if (action === "delete-monthly-adjustment") {
      await deleteAttendanceMonthlyAdjustment(client, payload.id)
      return privateJson({ success: true })
    }
    if (action === "send-reminder") {
      const reminder = await sendAttendanceConfirmationReminders(
        client,
        payload,
        actor,
      )
      if (reminder.failed > 0) {
        return privateJson(
          {
            success: false,
            message: `${reminder.sent} reminder(s) sent; ${reminder.failed} failed. Try the failed recipients again.`,
            reminder,
          },
          { status: 502 },
        )
      }
      const skippedMessage = reminder.skipped
        ? ` ${reminder.skipped} recently sent reminder(s) were not sent again.`
        : ""
      return privateJson({
        success: true,
        message: `${reminder.sent} reminder(s) sent.${skippedMessage}`,
        reminder,
      })
    }
    if (action === "sync" || action === "sync-dingtalk") {
      const sync = await runAttendanceSync()
      return privateJson({ success: true, sync })
    }

    throw new AttendanceValidationError("Attendance action is unsupported.")
  } catch (error) {
    const status = errorStatus(error)
    if (status >= 500) console.error("Attendance mutation failed", error)
    return privateJson(
      { message: publicError(error, "Could not update attendance records.") },
      { status },
    )
  }
}
