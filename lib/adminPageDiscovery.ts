import fs from "node:fs/promises"
import path from "node:path"
import {
  ADMIN_PAGE_DEFINITIONS,
  type AdminPageDefinition,
} from "@/lib/adminPages"

function titleFromSegment(segment: string) {
  return segment
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function getDiscoveredAdminPages(): Promise<AdminPageDefinition[]> {
  const adminRoot = path.join(process.cwd(), "app", "admin")
  const knownPaths = new Set(ADMIN_PAGE_DEFINITIONS.map((page) => page.path))
  const discovered: AdminPageDefinition[] = []

  try {
    const entries = await fs.readdir(adminRoot, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const pagePath = `/admin/${entry.name}`
      if (knownPaths.has(pagePath)) continue

      const hasPage = await pathExists(path.join(adminRoot, entry.name, "page.tsx"))
      if (!hasPage) continue

      discovered.push({
        id: entry.name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase(),
        label: titleFromSegment(entry.name),
        group: "management",
        path: pagePath,
      })
    }
  } catch {
    return ADMIN_PAGE_DEFINITIONS
  }

  return [...ADMIN_PAGE_DEFINITIONS, ...discovered.sort((a, b) => a.label.localeCompare(b.label))]
}
