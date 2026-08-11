import {
  hasSpcPagePermission,
  hasSpcRole,
  requireSpcPagePermission,
  requireSpcSession,
} from "@/lib/spcAuth"
import {
  canUndoAuditLogRecord,
  getAuditLogRecord,
  isUserAuditRecord,
  isSpcUserManagementAuditRecord,
  listAuditLogs,
  matchesAuditActor,
  matchesAuditScope,
  presentAuditLogs,
  redactSpcUserManagementInvestigation,
  type PresentedAuditLogRecord,
  undoAuditLog,
} from "@/lib/auditLog"
import {
  createSpcAuditContext,
  recordSpcUserManagementAuditEvent,
  type SpcAuditContext,
} from "@/lib/spcAudit"
import {
  listSpcAuditUserOptions,
} from "@/lib/spcUsers"
import { SPC_PAGE_DEFINITIONS } from "@/lib/spcPages"
import { timedJson } from "@/lib/serverTiming"
import { spcPrivateJson } from "@/lib/spcResponse"

const PAGE_TABLES: Record<string, string[]> = {
  "spc-user-management": [
    "spc_users",
    "spc_role_defaults",
    "spc_user_management_events",
    "office_calendar_store",
  ],
  "spc-mfa-test": ["spc_mfa_test_events"],
  "spc-buyer-enquiries": ["spc_enquiries", "office_calendar_store"],
  "spc-fixtures": ["spc_enquiries", "spc_fixtures"],
  "spc-lost-record": ["spc_enquiries"],
  "spc-statistics": ["spc_enquiries", "spc_fixtures"],
  "spc-suppliers": ["spc_suppliers", "office_calendar_store"],
  "spc-readme": ["spc_presentation_chunks"],
}

const RETIRED_ADMIN_AUDIT_PAGES = [
  { id: "spc-mfa-test", label: "SPC MFA TEST (RETIRED)" },
] as const

const AUDIT_USER_CACHE_MS = 30_000
let auditUserMapCache: { value: Map<string, string>; expiresAt: number } | null = null
let auditUserMapPromise: Promise<Map<string, string>> | null = null

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
  if (auditUserMapCache && auditUserMapCache.expiresAt > Date.now()) {
    return auditUserMapCache.value
  }
  if (auditUserMapPromise) return auditUserMapPromise

  auditUserMapPromise = listSpcAuditUserOptions()
    .then((users) => {
      const value = new Map(
        users.map((user) => [user.username.trim().toLowerCase(), user.displayName.trim() || user.username]),
      )
      auditUserMapCache = { value, expiresAt: Date.now() + AUDIT_USER_CACHE_MS }
      return value
    })
    .finally(() => {
      auditUserMapPromise = null
    })

  return auditUserMapPromise
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

function presentAuditLogForClient(
  record: PresentedAuditLogRecord,
  detailsLoaded = false,
  viewerIsAdmin = false,
) {
  const visibleRecord = redactSpcUserManagementInvestigation(
    record,
    viewerIsAdmin,
  )
  return {
    id: visibleRecord.id,
    occurredAt: visibleRecord.occurredAt,
    actorUserId: visibleRecord.actorUserId,
    actorId: visibleRecord.actorId,
    actorName: visibleRecord.actorName,
    displayOperation: visibleRecord.displayOperation,
    pageId: visibleRecord.pageId,
    pageLabel: visibleRecord.pageLabel,
    recordLabel: visibleRecord.recordLabel,
    summary: visibleRecord.summary,
    details: detailsLoaded ? visibleRecord.details : [],
    detailsLoaded,
    sourceIp: visibleRecord.sourceIp,
    correlationId: visibleRecord.correlationId,
    requestId: visibleRecord.requestId,
    platformRequestId: visibleRecord.platformRequestId,
    actorRole: visibleRecord.actorRole,
    auditAction: visibleRecord.auditAction,
    auditOutcome: visibleRecord.auditOutcome,
    targetType: visibleRecord.targetType,
    targetId: visibleRecord.targetId,
    targetUsername: visibleRecord.targetUsername,
    approvalReference: visibleRecord.approvalReference,
    errorCode: visibleRecord.errorCode,
    undoOfLogId: visibleRecord.undoOfLogId,
    undoneAt: visibleRecord.undoneAt,
    undoable: visibleRecord.undoable,
  }
}

export async function GET(request: Request) {
  const startedAt = Date.now()
  try {
    const session = await requireSpcPagePermission("spc-audit-log", "view")
    const viewerIsAdmin = hasSpcRole(session, "ADMIN")
    const url = new URL(request.url)
    const requestedId = url.searchParams.get("id")?.trim()
    if (requestedId) {
      const [record, usersByUsername] = await Promise.all([
        getAuditLogRecord(requestedId),
        loadAuditUserMap(),
      ])
      if (!record || !isUserAuditRecord(record) || !matchesAuditScope(record, "spc")) {
        return spcPrivateJson({ message: "Audit log not found." }, { status: 404 })
      }

      const [presented] = normalizeSpcAuditActors(
        await presentAuditLogs([record], SPC_PAGE_DEFINITIONS),
        usersByUsername,
      )
      if (!presented?.pageId.startsWith("spc-")) {
        return spcPrivateJson({ message: "Audit log not found." }, { status: 404 })
      }
      if (!viewerIsAdmin && presented.pageId === "spc-mfa-test") {
        return spcPrivateJson({ message: "Audit log not found." }, { status: 404 })
      }

      return timedJson(
        "/api/spc/audit-logs",
        startedAt,
        { log: presentAuditLogForClient(presented, true, viewerIsAdmin) },
        undefined,
        { mode: "detail" },
      )
    }

    const requestedLimit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100), 1), 150)
    const pageId = url.searchParams.get("page")
    const operation = url.searchParams.get("operation")?.toUpperCase()
    const actor = url.searchParams.get("actor")
    const tableNames = pageId && pageId !== "all" ? PAGE_TABLES[pageId] : undefined
    const operations = rawOperationsForDisplay(operation)
    const candidateLimit = Math.min(requestedLimit * (tableNames ? 2 : 3), 500)
    const [records, usersByUsername] = await Promise.all([
      listAuditLogs({
        limit: candidateLimit,
        tableNames,
        operations: operations ? [...operations] : undefined,
        actorId: actor && actor !== "all" ? actor : undefined,
        scope: "spc",
        includeRows: false,
      }),
      loadAuditUserMap(),
    ])
    const presented = normalizeSpcAuditActors(
      await presentAuditLogs(records, SPC_PAGE_DEFINITIONS),
      usersByUsername,
    )
    const visiblePresented = presented.filter(
      (record) => viewerIsAdmin || record.pageId !== "spc-mfa-test",
    )
    const logs = visiblePresented
      .filter((record) => record.pageId.startsWith("spc-"))
      .filter((record) => !pageId || pageId === "all" || record.pageId === pageId)
      .filter((record) => !operation || operation === "ALL" || record.displayOperation === operation)
      .filter((record) => matchesAuditActor(record, actor))
      .slice(0, requestedLimit)
      .map((record) =>
        presentAuditLogForClient(record, false, viewerIsAdmin),
      )

    return timedJson(
      "/api/spc/audit-logs",
      startedAt,
      {
        logs,
        pages: [
          ...SPC_PAGE_DEFINITIONS.map(({ id, label }) => ({ id, label })),
          ...(viewerIsAdmin ? RETIRED_ADMIN_AUDIT_PAGES : []),
        ],
        users: buildAuditUserFilters(session, usersByUsername, visiblePresented),
      },
      undefined,
      { mode: "index", returned: logs.length, candidateLimit },
    )
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return spcPrivateJson(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 },
      )
    }

    return spcPrivateJson(
      { message: error instanceof Error ? error.message : "Failed to load SPC audit logs." },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  let auditContext: SpcAuditContext | null = null
  let outcomeAuditAttempted = false

  try {
    const session = await requireSpcSession()
    if (!hasSpcPagePermission(session, "spc-audit-log", "edit")) {
      auditContext = createSpcAuditContext(
        session,
        request,
        "spc-user-management",
        {
          action: "undo-user-management-audit",
          targetType: "spc-user-management-audit",
          outcome: "denied",
        },
      )
      outcomeAuditAttempted = true
      await recordSpcUserManagementAuditEvent(auditContext, {
        operation: "UPDATE",
        errorCode: "forbidden",
      })
      throw new Error("Forbidden")
    }

    const payload = (await request.json()) as { action?: string; id?: string }

    if (payload.action !== "undo") {
      return spcPrivateJson({ message: "Unsupported action." }, { status: 400 })
    }
    if (!payload.id) {
      return spcPrivateJson({ message: "Missing audit log id." }, { status: 400 })
    }
    const target = await getAuditLogRecord(payload.id)
    if (!target || !isUserAuditRecord(target) || !matchesAuditScope(target, "spc")) {
      return spcPrivateJson({ message: "Audit log was not found." }, { status: 404 })
    }
    if (isSpcUserManagementAuditRecord(target)) {
      auditContext = createSpcAuditContext(
        session,
        request,
        "spc-user-management",
        {
          action: "undo-user-management-audit",
          targetType: "audit-log",
          targetId: target.id,
          outcome: hasSpcRole(session, "ADMIN") ? "success" : "denied",
        },
      )
      if (!hasSpcRole(session, "ADMIN")) {
        outcomeAuditAttempted = true
        await recordSpcUserManagementAuditEvent(auditContext, {
          operation: "UPDATE",
          errorCode: "forbidden",
        })
        throw new Error("Forbidden")
      }
    }
    if (!canUndoAuditLogRecord(target)) {
      if (auditContext) {
        outcomeAuditAttempted = true
        await recordSpcUserManagementAuditEvent(
          { ...auditContext, outcome: "failed" },
          { operation: "UPDATE", errorCode: "not_undoable" },
        )
      }
      return spcPrivateJson(
        { message: "This change must be corrected from its management page." },
        { status: 400 },
      )
    }

    const undoLogId = await undoAuditLog(
      payload.id,
      {
        username: session.username ? `spc:${session.username}` : null,
        displayName: session.displayName,
      },
      auditContext || undefined,
    )
    return spcPrivateJson({ success: true, undoLogId })
  } catch (error) {
    if (auditContext && !outcomeAuditAttempted) {
      outcomeAuditAttempted = true
      try {
        await recordSpcUserManagementAuditEvent(
          { ...auditContext, outcome: "failed" },
          { operation: "UPDATE", errorCode: "operation_failed" },
        )
      } catch {
        return spcPrivateJson(
          {
            message: `Audit evidence could not be recorded. Reference: ${auditContext.correlationId}.`,
          },
          {
            status: 500,
            headers: { "Cache-Control": "private, no-store" },
          },
        )
      }
    }

    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return spcPrivateJson(
        { message: error.message },
        {
          status: error.message === "Unauthorized" ? 401 : 403,
          headers: { "Cache-Control": "private, no-store" },
        },
      )
    }

    return spcPrivateJson(
      {
        message: `Failed to apply SPC audit undo.${auditContext ? ` Reference: ${auditContext.correlationId}.` : ""}`,
      },
      {
        status: 500,
        headers: { "Cache-Control": "private, no-store" },
      },
    )
  }
}
