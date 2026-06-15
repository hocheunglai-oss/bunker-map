import fs from "node:fs/promises"
import path from "node:path"
import {
  ADMIN_PAGE_DEFINITIONS,
  type AdminPageDefinition,
} from "@/lib/adminPages"
import { getAdminPageByPathFromPages } from "@/lib/adminPageRegistry"

function titleFromSegment(segment: string) {
  return segment
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
}

async function findAdminPageRoutes(
  directory: string,
  segments: string[] = []
): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const routes: string[] = []
  const hasPage = entries.some(
    (entry) => entry.isFile() && /^page\.(?:js|jsx|ts|tsx)$/.test(entry.name)
  )

  if (segments.length > 0 && hasPage) {
    routes.push(`/admin/${segments.join("/")}`)
  }

  const nestedRoutes = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !entry.name.startsWith("_") &&
          !entry.name.startsWith("(") &&
          !entry.name.startsWith("[")
      )
      .map((entry) =>
        findAdminPageRoutes(path.join(directory, entry.name), [...segments, entry.name])
      )
  )

  return routes.concat(...nestedRoutes)
}

export async function getDiscoveredAdminPages(): Promise<AdminPageDefinition[]> {
  const adminRoots = [
    path.join(process.cwd(), "app", "admin"),
    path.join(process.cwd(), ".next", "server", "app", "admin"),
  ]
  const pageRoutes = new Set<string>()
  const discovered: AdminPageDefinition[] = []

  for (const adminRoot of adminRoots) {
    try {
      const routes = await findAdminPageRoutes(adminRoot)
      routes.forEach((route) => pageRoutes.add(route))
    } catch {
      // Some deployments only contain one of the source or compiled route trees.
    }
  }

  for (const pagePath of pageRoutes) {
    if (getAdminPageByPathFromPages(pagePath, ADMIN_PAGE_DEFINITIONS)) continue

    const routeSegments = pagePath.replace(/^\/admin\//, "").split("/")
    discovered.push({
      id: routeSegments
        .join("-")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .toLowerCase(),
      label: titleFromSegment(routeSegments[routeSegments.length - 1]),
      group: "management",
      path: pagePath,
    })
  }

  return [...ADMIN_PAGE_DEFINITIONS, ...discovered.sort((a, b) => a.label.localeCompare(b.label))]
}
