export type SpcPagePermission = "none" | "view" | "edit"

export type SpcPagePermissionMap = Record<string, SpcPagePermission>

export const SPC_BUILT_IN_ROLE_IDS = ["SUPPLIER TRADER", "BUYER TRADER", "ADMIN"] as const

export type SpcRoleId = string

export type SpcPageDefinition = {
  id: string
  label: string
  group: "trading" | "records" | "market" | "management"
  path: string
  matchPrefixes?: string[]
}

export const SPC_PAGE_DEFINITIONS: SpcPageDefinition[] = [
  {
    id: "spc-buyer-enquiries",
    label: "ENQUIRIES",
    group: "trading",
    path: "/spc/enquiries",
    matchPrefixes: ["/buyer", "/spc/buyer", "/enquiries", "/spc/enquiries"],
  },
  {
    id: "spc-chrome-extension",
    label: "CHROME EXTENSION",
    group: "trading",
    path: "/spc/chrome",
    matchPrefixes: ["/chrome", "/spc/chrome"],
  },
  {
    id: "spc-fixtures",
    label: "FIXTURES",
    group: "records",
    path: "/spc/fixtures",
    matchPrefixes: ["/fixtures", "/spc/fixtures"],
  },
  {
    id: "spc-lost-record",
    label: "LOST RECORD",
    group: "records",
    path: "/spc/lost-record",
    matchPrefixes: ["/lost-record", "/spc/lost-record", "/lost", "/spc/lost"],
  },
  {
    id: "spc-suppliers",
    label: "SUPPLIER DATABASE",
    group: "market",
    path: "/spc/suppliers",
    matchPrefixes: ["/suppliers", "/spc/suppliers"],
  },
  {
    id: "spc-audit-log",
    label: "AUDIT LOG",
    group: "management",
    path: "/spc/auditlog",
    matchPrefixes: ["/auditlog", "/spc/auditlog"],
  },
  {
    id: "spc-user-management",
    label: "USER MANAGEMENT",
    group: "management",
    path: "/spc/usermanagement",
    matchPrefixes: ["/usermanagement", "/spc/usermanagement"],
  },
  {
    id: "spc-system-health",
    label: "SYSTEM HEALTH",
    group: "management",
    path: "/spc/systemhealth",
    matchPrefixes: ["/systemhealth", "/spc/systemhealth"],
  },
  {
    id: "spc-tech-stack",
    label: "TECH STACK",
    group: "management",
    path: "/spc/techstack",
    matchPrefixes: ["/techstack", "/spc/techstack"],
  },
]

export const SPC_PAGE_GROUP_LABELS: Record<SpcPageDefinition["group"], string> = {
  trading: "Trading Tools",
  records: "Trading Records",
  market: "Market Intelligence",
  management: "Management Tools",
}

const SPC_PERMISSION_RANK: Record<SpcPagePermission, number> = {
  none: 0,
  view: 1,
  edit: 2,
}

function roleText(role: string | null | undefined) {
  return (role || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
}

export function normaliseSpcRole(role: string | null | undefined): SpcRoleId {
  const normalised = roleText(role).toUpperCase().slice(0, 40)
  if (!normalised || normalised === "BUYER" || normalised === "BUYER TRADER") {
    return "BUYER TRADER"
  }
  if (normalised === "SUPPLIER" || normalised === "SUPPLIER TRADER") {
    return "SUPPLIER TRADER"
  }
  if (normalised === "ADMIN" || normalised === "ADMINISTRATOR") {
    return "ADMIN"
  }
  return normalised
}

export function getSpcRoleLabel(role: string | null | undefined) {
  return normaliseSpcRole(role)
}

export function isSpcBuiltInRole(role: string | null | undefined) {
  return SPC_BUILT_IN_ROLE_IDS.includes(
    normaliseSpcRole(role) as (typeof SPC_BUILT_IN_ROLE_IDS)[number],
  )
}

export function getFullSpcPagePermissions(
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
): SpcPagePermissionMap {
  return pages.reduce<SpcPagePermissionMap>((permissions, page) => {
    permissions[page.id] = "edit"
    return permissions
  }, {})
}

export function normaliseSpcPagePermissions(
  permissions: unknown,
  fallback: SpcPagePermission = "none",
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
): SpcPagePermissionMap {
  const source =
    permissions && typeof permissions === "object"
      ? (permissions as Record<string, unknown>)
      : {}

  return pages.reduce<SpcPagePermissionMap>((pagePermissions, page) => {
    const value = source[page.id]
    pagePermissions[page.id] =
      value === "edit" || value === "view" || value === "none" ? value : fallback
    return pagePermissions
  }, {})
}

export function getDefaultSpcPermissionsForRole(
  role: string | null | undefined,
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
) {
  const roleId = normaliseSpcRole(role)

  if (roleId === "BUYER TRADER" || roleId === "ADMIN") {
    return pages.reduce<SpcPagePermissionMap>((permissions, page) => {
      permissions[page.id] = "edit"
      return permissions
    }, {})
  }

  if (roleId === "SUPPLIER TRADER") {
    return pages.reduce<SpcPagePermissionMap>((permissions, page) => {
      permissions[page.id] =
        page.id === "spc-buyer-enquiries" ||
        page.id === "spc-chrome-extension" ||
        page.id === "spc-fixtures" ||
        page.id === "spc-lost-record"
          ? "view"
          : "none"
      return permissions
    }, {})
  }

  return normaliseSpcPagePermissions(null, "view", pages)
}

export function canAccessSpcPage(
  permissions: SpcPagePermissionMap | null | undefined,
  pageId: string,
  access: Exclude<SpcPagePermission, "none"> = "view",
) {
  if (!permissions) return false
  return SPC_PERMISSION_RANK[permissions[pageId] || "none"] >= SPC_PERMISSION_RANK[access]
}

export function getSpcPageByPath(pathname: string) {
  return SPC_PAGE_DEFINITIONS.find((page) => {
    if (pathname === page.path) return true
    return (page.matchPrefixes || []).some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  })
}

export function getDefaultSpcLandingPath(permissions: SpcPagePermissionMap | null | undefined) {
  const priority = [
    "spc-buyer-enquiries",
    "spc-chrome-extension",
    "spc-fixtures",
    "spc-lost-record",
    "spc-suppliers",
    "spc-user-management",
    "spc-audit-log",
    "spc-system-health",
    "spc-tech-stack",
  ]
  const pageId = priority.find((id) => canAccessSpcPage(permissions, id, "view"))
  return SPC_PAGE_DEFINITIONS.find((page) => page.id === pageId)?.path || "/spc"
}
