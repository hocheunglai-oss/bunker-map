import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import {
  canUndoAuditLogRecord,
  getAuditLogRecord,
  listAuditLogs,
  matchesAuditActor,
  presentAuditLogs,
  type PresentedAuditLogRecord,
  undoAuditLog,
} from "@/lib/auditLog"
import { listSpcAuditUserOptions } from "@/lib/spcUsers"
import { SPC_PAGE_DEFINITIONS } from "@/lib/spcPages"

const PAGE_TABLES: Record<string, string[]> = {
  "spc-user-management": ["spc_users", "office_calendar_store"],
  "spc-buyer-enquiries": ["spc_enquiries", "office_calendar_store"],
  "spc-fixtures": ["spc_enquiries", "spc_fixtures"],
  "spc-lost-record": ["spc_enquiries"],
  "spc-statistics": ["spc_enquiries", "spc_fixtures"],
  "spc-suppliers": ["spc_suppliers", "office_calendar_store"],
}

function rawOperationsForDisplay(operation: string | undefined) {
  if (!operation || operation === "ALL") return undefined
  if (operation === "UPDATE") return ["UPDATE", "INSERT"] as const
  if (operation === "INSERT" || operation === "DELETE") return [operation] as const
  return undefined
}

function actorUsername(actorId: string | null | undefined) {
  const clean = actorId?.trim().toLowerCase() || ""
  if (!clean) return ""
  return clean.startsWith("spc:") ? clean.slice(4) : clean
}

function normalizeSpcAuditActors(
  records: PresentedAuditLogRecord[],
  usersByUsername: Map<string, string>,
) {
  const ottoDisplayName = usersByUsername.get("otto@cosulich.com.hk") || "OTTO LAI"

  return records.map((record) => {
    const id = record.actorId?.trim().toLowerCase() || ""
    const name = record.actorName?.trim() || ""
    const username = actorUsername(id)
    const mappedName =
      usersByUsername.get(username) ||
      (id === "spc:spcadmin" || name.toUpperCase() === "SPC ADMIN" ? ottoDisplayName : "") ||
      (name.toUpperCase() === "OL" && username === "otto@cosulich.com.hk" ? ottoDisplayName : "") ||
      name

    return {
      ...record,
      actorName: mappedName,
    }
  })
}

function shouldOfferHistoricalActor(record: PresentedAuditLogRecord, usersByUsername: Map<string, string>) {
  const id = record.actorId?.trim().toLowerCase() || ""
  const name = record.actorName?.trim().toLowerCase() || ""
  if (!id) return false
  if (id.includes("codex") || name === "codex") return true
  if (id === "spc:spcadmin") return false
  if (usersByUsername.has(actorUsername(id))) return false
  return true
}

async function loadAuditUserMap() {
  const users = await listSpcAuditUserOptions()
  return new Map(
    users.map((user) => [user.username.trim().toLowerCase(), user.displayName.trim() || user.username]),
  )
}

function buildAuditUserFilters(
  session: { username: string | null; displayName: string | null },
  usersByUsername: Map<string, string>,
  presented: PresentedAuditLogRecord[],
) {
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
  usersByUsername.forEach((displayName, username) => addUser(`spc:${username}`, displayName))
  presented
    .filter((record) => shouldOfferHistoricalActor(record, usersByUsername))
    .forEach((record) => addUser(record.actorId, record.actorName || record.actorId))

  return Array.from(userMap.values()).sort((a, b) => a.label.localeCompare(b.label))
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
    const candidateLimit = tableNames ? Math.min(requestedLimit * 2, 250) : requestedLimit
    const [records, usersByUsername] = await Promise.all([
      listAuditLogs({
        limit: candidateLimit,
        tableNames,
        operations: operations ? [...operations] : undefined,
        actorId: actor && actor !== "all" ? actor : undefined,
        scope: "spc",
      }),
      loadAuditUserMap(),
    ])
    const presented = normalizeSpcAuditActors(
      await presentAuditLogs(records, SPC_PAGE_DEFINITIONS),
      usersByUsername,
    )
    const logs = presented
      .filter((record) => record.pageId.startsWith("spc-"))
      .filter((record) => !pageId || pageId === "all" || record.pageId === pageId)
      .filter((record) => !operation || operation === "ALL" || record.displayOperation === operation)
      .filter((record) => matchesAuditActor(record, actor))
      .slice(0, requestedLimit)

    return NextResponse.json({
      logs,
      pages: SPC_PAGE_DEFINITIONS.map(({ id, label }) => ({ id, label })),
      users: buildAuditUserFilters(session, usersByUsername, presented),
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
