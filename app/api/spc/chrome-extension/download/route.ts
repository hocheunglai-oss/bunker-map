import path from "node:path"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { spcPrivateJson } from "@/lib/spcResponse"
import { createStoredZip } from "@/lib/extensionZip"

export const runtime = "nodejs"

const ARCHIVE_ROOT = "fcuno-spc-whatsapp-board"
const EXTENSION_DIR = path.join(process.cwd(), "tools", "whatsapp-spc-speed-board")
const EXTENSION_FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "styles.css",
  "spc-sidebar-logo.png",
  "spc-enquiry-chat-button.webp",
  "README.md",
] as const

async function createExtensionZip() {
  return createStoredZip({
    archiveRoot: ARCHIVE_ROOT,
    sourceDirectory: EXTENSION_DIR,
    files: EXTENSION_FILES,
  })
}

export async function GET() {
  try {
    await requireSpcPagePermission("spc-chrome-extension", "view")
    const zip = await createExtensionZip()

    return new Response(zip, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": 'attachment; filename="fcuno-spc-whatsapp-board.zip"',
        "Content-Length": String(zip.length),
        "Content-Type": "application/zip",
      },
    })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return spcPrivateJson(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 },
      )
    }

    return spcPrivateJson(
      { message: error instanceof Error ? error.message : "Failed to download extension." },
      { status: 500 },
    )
  }
}
