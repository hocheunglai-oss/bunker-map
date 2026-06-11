export type AdminPagePermission = "none" | "view" | "edit"

export type AdminPagePermissionMap = Record<string, AdminPagePermission>

export const ADMIN_ROLE_IDS = ["ADMIN", "AC", "BT", "VN"] as const

export type AdminRoleId = (typeof ADMIN_ROLE_IDS)[number]

export type AdminPageDefinition = {
  id: string
  label: string
  group: "reports" | "trading" | "contacts" | "office" | "management"
  path: string
  matchPrefixes?: string[]
}

export const ADMIN_PAGE_DEFINITIONS: AdminPageDefinition[] = [
  {
    id: "pricesetter",
    label: "CHINA AND COMPACT",
    group: "reports",
    path: "/admin/pricesetter",
  },
  {
    id: "hongkong-price-history",
    label: "HONG KONG",
    group: "reports",
    path: "/admin/hongkongpricehistory",
  },
  {
    id: "taiwan-price-history",
    label: "TAIWAN",
    group: "reports",
    path: "/admin/taiwanpricehistory",
  },
  {
    id: "taiwan-remarks",
    label: "TAIWAN REMARKS",
    group: "reports",
    path: "/admin/taiwanremarks",
  },
  {
    id: "ccinfo",
    label: "COUNTRY AND COMPANY INFO",
    group: "trading",
    path: "/admin/ccinfo",
    matchPrefixes: ["/admin/ccinfo"],
  },
  {
    id: "phonebook",
    label: "PHONEBOOK",
    group: "contacts",
    path: "/admin/phonebook",
  },
  {
    id: "outlook-addressbook",
    label: "OUTLOOK ADDRESS BOOK",
    group: "contacts",
    path: "/admin/outlookaddressbook",
  },
  {
    id: "email-templates",
    label: "OUTLOOK TEMPLATES",
    group: "contacts",
    path: "/admin/outlooktemplates",
    matchPrefixes: ["/admin/emailtemplates", "/admin/outlooktemplates"],
  },
  {
    id: "event-calendar",
    label: "EVENT CALENDAR",
    group: "office",
    path: "/admin/eventcalendar",
  },
  {
    id: "task-calendar",
    label: "TASK CALENDAR",
    group: "office",
    path: "/admin/taskcalendar",
  },
  {
    id: "audit-log",
    label: "AUDIT LOG",
    group: "management",
    path: "/admin/auditlog",
  },
  {
    id: "user-management",
    label: "USER MANAGEMENT",
    group: "management",
    path: "/admin/usermanagement",
  },
]

export const ADMIN_PAGE_GROUP_LABELS: Record<AdminPageDefinition["group"], string> = {
  reports: "Report Tools",
  trading: "Trading Tools",
  contacts: "Contact Tools",
  office: "Office Tools",
  management: "Management Tools",
}

const ADMIN_PERMISSION_RANK: Record<AdminPagePermission, number> = {
  none: 0,
  view: 1,
  edit: 2,
}

export function normaliseAdminRole(role: string | null | undefined): AdminRoleId {
  const normalised = (role || "").trim().toUpperCase()
  if (normalised === "ADMIN") return "ADMIN"
  if (normalised === "BT") return "BT"
  if (normalised === "VN") return "VN"
  return "AC"
}

export function isAdminRole(role: string | null | undefined) {
  return normaliseAdminRole(role) === "ADMIN"
}

export function getFullAdminPagePermissions(
  pages: AdminPageDefinition[] = ADMIN_PAGE_DEFINITIONS
): AdminPagePermissionMap {
  return pages.reduce<AdminPagePermissionMap>((permissions, page) => {
    permissions[page.id] = "edit"
    return permissions
  }, {})
}

export function normaliseAdminPagePermissions(
  permissions: unknown,
  fallback: AdminPagePermission = "none",
  pages: AdminPageDefinition[] = ADMIN_PAGE_DEFINITIONS
): AdminPagePermissionMap {
  const source =
    permissions && typeof permissions === "object"
      ? (permissions as Record<string, unknown>)
      : {}

  const next = pages.reduce<AdminPagePermissionMap>((pagePermissions, page) => {
    const value = source[page.id]
    pagePermissions[page.id] =
      value === "edit" || value === "view" || value === "none" ? value : fallback
    return pagePermissions
  }, {})

  Object.entries(source).forEach(([pageId, value]) => {
    if (next[pageId]) return
    if (value === "edit" || value === "view" || value === "none") {
      next[pageId] = value
    }
  })

  return next
}

export function canAccessAdminPage(
  permissions: AdminPagePermissionMap | null | undefined,
  pageId: string,
  access: Exclude<AdminPagePermission, "none"> = "view"
) {
  if (!permissions) return false

  return ADMIN_PERMISSION_RANK[permissions[pageId] || "none"] >= ADMIN_PERMISSION_RANK[access]
}

export function getAdminPageByPath(pathname: string) {
  return ADMIN_PAGE_DEFINITIONS.find((page) => {
    if (pathname === page.path) return true
    return (page.matchPrefixes || []).some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )
  })
}

export function getAdminPagesByGroup(group: AdminPageDefinition["group"]) {
  return ADMIN_PAGE_DEFINITIONS.filter((page) => page.group === group)
}
