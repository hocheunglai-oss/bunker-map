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

const PAGE_TABLES: Record<string, string[]> = {
  ccinfo: [
    "cc_countries",
    "cc_companies",
    "cc_ports",
    "cc_documents",
    "cc_company_files",
    "cc_entry_files",
    "cc_entry_folders",
  ],
  phonebook: ["phonebook_contacts", "phonebook_companies"],
  "outlook-addressbook": [
    "shared_addressbook_contacts",
    "shared_addressbook_groups",
    "shared_addressbook_group_members",
  ],
  "email-templates": ["email_templates"],
  "user-management": ["admin_users", "admin_role_defaults"],
  "event-calendar": ["office_calendar_store"],
  "task-calendar": ["office_calendar_store"],
  pricesetter: ["ports", "price_history", "remarks"],
  "hongkong-price-history": ["ports", "price_history", "remarks"],
  "taiwan-price-history": ["ports", "price_history", "remarks"],
  "taiwan-remarks": ["remarks"],
}

const PAGE_ALIASES: Record<string, string> = {
  outlookaddressbook: "outlook-addressbook",
  outlooktemplates: "email-templates",
  emailtemplates: "email-templates",
}

let managedUsersCache:
  | {
      expiresAt: number
      users: Array<{ username: string; displayName: string }>
    }
  | undefined
let managedUsersPromise:
  | Promise<Array<{ username: string; displayName: string }>>
  | undefined

async function loadManagedUsersForFilters(
  pages: Awaited<ReturnType<typeof getDiscoveredAdminPages>>,
) {
  if (managedUsersCache && managedUsersCache.expiresAt > Date.now()) {
    return managedUsersCache.users
  }
  if (managedUsersPromise) return managedUsersPromise

  managedUsersPromise = (async () => {
    try {
      const roleDefaults = await listManagedAdminRoleDefaults(pages)
      const users = await listManagedAdminUsers(roleDefaults, pages)
      const mapped = users.map((user) => ({
        username: user.username,
        displayName: user.displayName,
      }))
      managedUsersCache = {
        expiresAt: Date.now() + 30_000,
        users: mapped,
      }
      return mapped
    } catch {
      return []
    } finally {
      managedUsersPromise = undefined
    }
  })()

  return managedUsersPromise
}

function rawOperationsForDisplay(operation: string | undefined) {
  if (!operation || operation === "ALL") return undefined
  if (operation === "UPDATE") return ["UPDATE", "INSERT"] as const
  if (operation === "INSERT" || operation === "DELETE") return [operation] as const
  return undefined
}

export async function GET(request: Request) {
  try {
    const session = await requireAdminPagePermission("audit-log", "view")

    const url = new URL(request.url)
    const requestedLimit = Math.min(
      Math.max(Number(url.searchParams.get("limit") || 100), 1),
      150
    )
    const requestedPageId =
      url.searchParams.get("page") || url.searchParams.get("table")
    const pageId = requestedPageId
      ? PAGE_ALIASES[requestedPageId] || requestedPageId
      : null
    const operation = url.searchParams.get("operation")?.toUpperCase()
    const actor = url.searchParams.get("actor")
    const pages = await getDiscoveredAdminPages()
    const tableNames =
      pageId && pageId !== "all" ? PAGE_TABLES[pageId] : undefined
    const operations = rawOperationsForDisplay(operation)
    const candidateLimit = Math.min(
      Math.max(requestedLimit * (tableNames ? 2 : 3), requestedLimit),
      500,
    )
    const records = await listAuditLogs({
      limit: candidateLimit,
      tableNames,
      operations: operations ? [...operations] : undefined,
      actorId: actor && actor !== "all" ? actor : undefined,
    })
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

    const managedUsers = await loadManagedUsersForFilters(pages)

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
