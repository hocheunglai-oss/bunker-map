import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import {
  listAuditLogs,
  matchesAuditActor,
  presentAuditLogs,
  undoAuditLog,
} from "@/lib/auditLog"
import { getDiscoveredAdminPages } from "@/lib/adminPageDiscovery"
import {
  listManagedAdminRoleDefaults,
  listManagedAdminUsers,
} from "@/lib/adminUsers"

export async function GET(request: Request) {
  try {
    const session = await requireAdminPagePermission("audit-log", "view")

    const url = new URL(request.url)
    const requestedLimit = Math.min(
      Math.max(Number(url.searchParams.get("limit") || 100), 1),
      150
    )
    const pageId = url.searchParams.get("page")
    const operation = url.searchParams.get("operation")?.toUpperCase()
    const actor = url.searchParams.get("actor")
    const pages = await getDiscoveredAdminPages()
    const records = await listAuditLogs({ limit: 500 })
    const presented = await presentAuditLogs(records, pages)
    const logs = presented
      .filter((record) => !pageId || pageId === "all" || record.pageId === pageId)
      .filter(
        (record) =>
          !operation ||
          operation === "ALL" ||
          record.displayOperation === operation
      )
      .filter((record) => matchesAuditActor(record, actor))
      .slice(0, requestedLimit)

    let managedUsers: Array<{ username: string; displayName: string }> = []
    try {
      const roleDefaults = await listManagedAdminRoleDefaults(pages)
      managedUsers = await listManagedAdminUsers(roleDefaults, pages)
    } catch {
      managedUsers = []
    }

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
    presented.forEach((record) =>
      addUser(record.actorId || record.actorName, record.actorName || record.actorId)
    )

    return NextResponse.json({
      logs,
      pages: pages.map(({ id, label }) => ({ id, label })),
      users: Array.from(userMap.values()).sort((a, b) =>
        a.label.localeCompare(b.label)
      ),
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

    const undoLogId = await undoAuditLog(payload.id, session)

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
