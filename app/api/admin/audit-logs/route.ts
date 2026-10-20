import { NextResponse } from "next/server"
import { hasAdminPagePermission, requireAdminIdentitySession, requireAdminPagePermission } from "@/lib/adminAuth"
import { browseAuditLogs } from "@/lib/auditBrowsing"
import { AuditBrowsingError } from "@/lib/auditBrowsingCursor"
import { loadAuditBrowsingUserNames } from "@/lib/auditBrowsingSource"
import { readLegacyAdminAuditFullList } from "@/lib/legacyAdminAuditFullList"
import {
  approvedCountryLabelNormalizationUndoMessage,
  canUndoAuditLogRecord,
  getAuditLogRecord,
  isUserAuditRecord,
  matchesAuditScope,
  presentAuditLogs,
  undoAuditLog,
} from "@/lib/auditLog"
import { getDiscoveredAdminPages } from "@/lib/adminPageDiscovery"
import { timedJson } from "@/lib/serverTiming"


const PAGE_ALIASES: Record<string, string> = {
  outlookaddressbook: "outlook-addressbook",
  outlooktemplates: "email-templates",
  emailtemplates: "email-templates",
}



function serializeAuditIndex(
  record: Awaited<ReturnType<typeof presentAuditLogs>>[number],
  detailsLoaded: boolean,
) {
  return {
    id: record.id,
    occurredAt: record.occurredAt,
    actorId: record.actorId,
    actorName: record.actorName,
    operation: record.operation,
    displayOperation: record.displayOperation,
    pageId: record.pageId,
    pageLabel: record.pageLabel,
    recordLabel: record.recordLabel,
    summary: record.summary,
    details: detailsLoaded ? record.details : [],
    detailsLoaded,
    undoable: record.undoable,
    undoOfLogId: record.undoOfLogId,
    undoneAt: record.undoneAt,
  }
}

export async function GET(request: Request) {
  const startedAt = Date.now()
  try {
    const entrySession = await requireAdminPagePermission("audit-log", "view")

    const url = new URL(request.url)
    const pages = await getDiscoveredAdminPages()
    const requestedId = url.searchParams.get("id")?.trim()
    if (requestedId) {
      const record = await getAuditLogRecord(requestedId)
      if (!record || !isUserAuditRecord(record) || !matchesAuditScope(record, "www")) {
        return NextResponse.json({ message: "Audit log not found." }, { status: 404 })
      }

      const [presented] = await presentAuditLogs([record], pages)
      return timedJson("/api/admin/audit-logs", startedAt, {
        log: serializeAuditIndex(presented, true),
      }, undefined, { mode: "detail" })
    }

    const includeRows = url.searchParams.get("details") === "1"
    if (includeRows && url.searchParams.get("browse") !== "1") {
      if (url.searchParams.has("cursor")) throw new AuditBrowsingError(400)
      const legacy = await readLegacyAdminAuditFullList(url, pages, entrySession)
      return timedJson("/api/admin/audit-logs", startedAt, legacy.payload, undefined, legacy.timing)
    }

    const session = await requireAdminIdentitySession()
    if (!hasAdminPagePermission(session, "audit-log", "view")) throw new Error("Forbidden")
    const result = await browseAuditLogs({
      request, scope: "www", viewerId: session.adminUserId,
      permissionState: { role: session.role, permission: session.permissions["audit-log"] },
      pages, aliases: PAGE_ALIASES, includeDetails: includeRows,
      loadContext: client => loadAuditBrowsingUserNames(client, "admin_users"),
      contextFingerprint: users => users,
    })
    const filteredLogs = result.records
    const logs = includeRows
      ? filteredLogs
      : filteredLogs.map((record) => serializeAuditIndex(record, false))

    const managedUsers = result.context

    const userMap = new Map<string, { value: string; label: string }>()
    const addUser = (value: string | null | undefined, label?: string | null) => {
      const cleanValue = value?.trim()
      if (!cleanValue) return
      userMap.set(cleanValue.toLowerCase(), {
        value: cleanValue,
        label: label?.trim() || cleanValue,
      })
    }

    addUser(session.username, session.displayName)
    managedUsers.forEach((user) => addUser(user.username, user.displayName))
    filteredLogs.forEach((record) =>
      addUser(record.actorId || record.actorName, record.actorName || record.actorId)
    )

    return timedJson("/api/admin/audit-logs", startedAt, {
      logs,
      pageInfo: result.pageInfo,
      totalMatches: result.totalMatches,
      usersComplete: false,
      pages: pages.map(({ id, label }) => ({ id, label })),
      users: Array.from(userMap.values()).sort((a, b) =>
        a.label.localeCompare(b.label)
      ),
    }, undefined, {
      mode: includeRows ? "full" : "index",
      returned: logs.length,
      state: result.pageInfo.state,
    })
  } catch (error) {
    if (error instanceof AuditBrowsingError) {
      return timedJson("/api/admin/audit-logs", startedAt, { message: error.message }, { status: error.status })
    }
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }

    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "Failed to load audit logs.",
      },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("audit-log", "edit")
    const payload = (await request.json()) as { action?: string; id?: string }

    if (payload.action !== "undo") {
      return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
    }

    if (!payload.id) {
      return NextResponse.json({ message: "Missing audit log id." }, { status: 400 })
    }

    const target = await getAuditLogRecord(payload.id)
    if (
      !target ||
      !isUserAuditRecord(target) ||
      !matchesAuditScope(target, "www")
    ) {
      return NextResponse.json(
        { message: "Audit log not found." },
        { status: 404 }
      )
    }
    if (!canUndoAuditLogRecord(target)) {
      return NextResponse.json(
        { message: approvedCountryLabelNormalizationUndoMessage(target) || "This audit record cannot be undone." },
        { status: 400 }
      )
    }

    const undoLogId = await undoAuditLog(target.id, session)

    return NextResponse.json({
      success: true,
      undoLogId,
    })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }

    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "Failed to apply audit undo.",
      },
      { status: 500 }
    )
  }
}
