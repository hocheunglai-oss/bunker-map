import {
  ADMIN_PAGE_DEFINITIONS,
  type AdminPageDefinition,
} from "@/lib/adminPages"

export function getAdminPageByPathFromPages(
  pathname: string,
  pages: AdminPageDefinition[] = ADMIN_PAGE_DEFINITIONS
) {
  return pages.find((page) => {
    if (pathname === page.path) return true
    return (page.matchPrefixes || []).some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )
  })
}

export function getAdminPagesByGroupFromPages(
  group: AdminPageDefinition["group"],
  pages: AdminPageDefinition[] = ADMIN_PAGE_DEFINITIONS
) {
  return pages.filter((page) => page.group === group)
}

export function normaliseAdminPageDefinitions(value: unknown): AdminPageDefinition[] {
  if (!Array.isArray(value)) return ADMIN_PAGE_DEFINITIONS

  const pages = value.filter((page): page is AdminPageDefinition => {
    if (!page || typeof page !== "object") return false

    const candidate = page as Partial<AdminPageDefinition>
    return (
      typeof candidate.id === "string" &&
      typeof candidate.label === "string" &&
      typeof candidate.path === "string" &&
      candidate.path.startsWith("/admin/") &&
      (candidate.group === "reports" ||
        candidate.group === "trading" ||
        candidate.group === "contacts" ||
        candidate.group === "office" ||
        candidate.group === "management")
    )
  })

  return pages.length > 0 ? pages : ADMIN_PAGE_DEFINITIONS
}
