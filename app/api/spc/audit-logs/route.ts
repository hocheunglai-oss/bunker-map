import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import {
  canUndoAuditLogRecord,
  getAuditLogRecord,
  listAuditLogs,
  matchesAuditActor,
  presentAuditLogs,
  undoAuditLog,
} from "@/lib/auditLog"
import { listManagedSpcRoleDefaults, listManagedSpcUsers } from "@/lib/spcUsers"
import { SPC_PAGE_DEFINITIONS } from "@/lib/spcPages"

const PAGE_TABLES: Record<string, string[]> = {
  "spc-user-management": ["spc_users", "office_calendar_store"],
  "spc-buyer-enquiries": ["spc_enquiries"],
  "spc-fixtures": ["spc_enquiries"],
  "spc-lost-record": ["spc_enquiries"],
  "spc-suppliers": ["spc_suppliers"],
}

function rawOperationsForDisplay(operation: string | undefined) {
  if (!operation || operation === "ALL") return undefined
  if (operation === "UPDATE") return ["UPDATE", "INSERT"] as const
  if (operation === "INSERT" || operation === "DELETE") return [operation] as const
  return undefined
}

export async function GET(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-audit-log", "view")
    const url = new URL(request.url)
    const requestedLimit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100), 1), 150)
    const pageId = url.searchParams.get("page")
    const operation = url.searchParams.get("operation")?.toUpperCase()
    const actor = url.searchParams.get("actor")
    const tableNames = pageId && pageId !== "all" ? PAGE_TABLES[pageId] : undefined
    const operations = rawOperationsForDisplay(operation)
    const candidateLimit = Math.min(Math.max(requestedLimit * (tableNames ? 2 : 3), requestedLimit), 500)
    const records = await listAuditLogs({
      limit: candidateLimit,
      tableNames,
      operations: operations ? [...operations] : undefined,
      actorId: actor && actor !== "all" ? actor : undefined,
      scope: "spc",
    })
    const presented = await presentAuditLogs(records, SPC_PAGE_DEFINITIONS)
    const logs = presented
      .filter((record) => record.pageId.startsWith("spc-"))
      .filter((record) => !pageId || pageId === "all" || record.pageId === pageId)
      .filter((record) => !operation || operation === "ALL" || record.displayOperation === operation)
      .filter((record) => matchesAuditActor(record, actor))
      .slice(0, requestedLimit)

    const roleDefaults = await listManagedSpcRoleDefaults(SPC_PAGE_DEFINITIONS)
    const users = await listManagedSpcUsers(roleDefaults, SPC_PAGE_DEFINITIONS)
    const userMap = new Map<string, { value: string; label: string }>()
    const addUser = (value: string | null | undefined, label?: string | null) => {
      const cleanValue = value?.trim()
      if (!cleanValue) return
      userMap.set(cleanValue.toLowerCase(), {
        value: cleanValue,
        label: label?.trim() || cleanValue,
      })
    }

    addUser(session.username ? `spc:${session.username}` : null, session.displayName)
    users.forEach((user) => addUser(`spc:${user.username}`, user.displayName))
    presented.forEach((record) => addUser(record.actorId, record.actorName || record.actorId))

    return NextResponse.json({
      logs,
      pages: SPC_PAGE_DEFINITIONS.map(({ id, label }) => ({ id, label })),
      users: Array.from(userMap.values()).sort((a, b) => a.label.localeCompare(b.label)),
    })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 },
      )
    }

    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load SPC audit logs." },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-audit-log", "edit")
    const payload = (await request.json()) as { action?: string; id?: string }

    if (payload.action !== "undo") {
      return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
    }
    if (!payload.id) {
      return NextResponse.json({ message: "Missing audit log id." }, { status: 400 })
    }
    const target = await getAuditLogRecord(payload.id)
    if (!target) {
      return NextResponse.json({ message: "Audit log was not found." }, { status: 404 })
    }
    if (!canUndoAuditLogRecord(target)) {
      return NextResponse.json({ message: "This SPC supplier change must be edited from the supplier database." }, { status: 400 })
    }

    const undoLogId = await undoAuditLog(payload.id, session)
    return NextResponse.json({ success: true, undoLogId })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 },
      )
    }

    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to apply SPC audit undo." },
      { status: 500 },
    )
  }
}
