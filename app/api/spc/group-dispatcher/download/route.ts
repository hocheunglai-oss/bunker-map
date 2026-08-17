import path from "node:path"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { createStoredZip } from "@/lib/extensionZip"
import { spcPrivateJson } from "@/lib/spcResponse"

export const runtime = "nodejs"

const ARCHIVE_ROOT = "fcuno-spc-group-dispatcher"
const SOURCE_DIRECTORY = path.join(process.cwd(), "tools", "whatsapp-spc-group-dispatcher")
const FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "styles.css",
  "spc-sidebar-logo.png",
  "README.md",
] as const

export async function GET() {
  try {
    await requireSpcPagePermission("spc-chrome-extension", "edit")
    const zip = await createStoredZip({
      archiveRoot: ARCHIVE_ROOT,
      sourceDirectory: SOURCE_DIRECTORY,
      files: FILES,
    })
    return new Response(zip, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": 'attachment; filename="fcuno-spc-group-dispatcher.zip"',
        "Content-Length": String(zip.length),
        "Content-Type": "application/zip",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to download group dispatcher."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return spcPrivateJson({ message }, { status })
  }
}
