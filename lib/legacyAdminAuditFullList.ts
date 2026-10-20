import "server-only"
import { listAuditLogs, matchesAuditActor, presentAuditLogs } from "@/lib/auditLog"
import { listManagedAdminRoleDefaults, listManagedAdminUsers } from "@/lib/adminUsers"
import type { getDiscoveredAdminPages } from "@/lib/adminPageDiscovery"

// Exact production cdcb full-list compatibility pipeline. These capped recent
// feeds do not opt in to the new bounded cursor or its transport/key contract.
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
  "email-templates": [
    "email_templates",
    "outlook_template_insertion_attempts",
  ],
  "user-management": ["admin_users", "admin_role_defaults"],
  "event-calendar": ["office_calendar_store"],
  "task-calendar": ["office_calendar_store"],
  "enquiry-worksheet": ["office_calendar_store"],
  pricesetter: ["ports", "price_history", "remarks"],
  "hongkong-price-history": ["ports", "price_history", "remarks"],
  "taiwan-price-history": ["ports", "price_history", "remarks"],
  "taiwan-remarks": ["remarks"],
  "openai-usage": ["openai_usage_events"],
  "attendance-record": [
    "attendance_people",
    "attendance_team_assignments",
    "attendance_leave_entries",
    "attendance_manual_overrides",
    "attendance_work_mode_policies",
    "attendance_work_mode_overrides",
    "attendance_entitlements",
    "attendance_monthly_adjustments",
    "attendance_monthly_confirmations",
    "attendance_reminder_dispatches",
  ],
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

export async function readLegacyAdminAuditFullList(url: URL, pages: Awaited<ReturnType<typeof getDiscoveredAdminPages>>, session: { username: string | null; displayName?: string | null }) {
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
    const includeRows = url.searchParams.get("details") === "1"
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
      scope: "www",
      includeRows,
    })
    const presented = await presentAuditLogs(records, pages)
    const filteredLogs = presented
      .filter((record) => !pageId || pageId === "all" || record.pageId === pageId)
      .filter(
        (record) =>
          !operation ||
          operation === "ALL" ||
          record.displayOperation === operation
      )
      .filter((record) => matchesAuditActor(record, actor))
      .slice(0, requestedLimit)
    const logs = includeRows
      ? filteredLogs
      : filteredLogs.map((record) => serializeAuditIndex(record, false))

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

    return { payload: {
      logs,
      pages: pages.map(({ id, label }) => ({ id, label })),
      users: Array.from(userMap.values()).sort((a, b) =>
        a.label.localeCompare(b.label)
      ),
    }, timing: {
      mode: includeRows ? "full" : "index",
      returned: logs.length,
      candidateLimit,
    } }
}
