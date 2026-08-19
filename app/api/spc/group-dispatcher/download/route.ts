import path from "node:path"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { createStoredZip } from "@/lib/extensionZip"
import { SPC_GROUP_DISPATCHER_FILES } from "@/lib/spcGroupDispatcherPackage"
import { SPC_GROUP_DISPATCHER_VERSION } from "@/lib/spcGroupDispatcherVersion"
import { spcPrivateJson } from "@/lib/spcResponse"

export const runtime = "nodejs"

const ARCHIVE_ROOT = "fcuno-spc-group-dispatcher"
const ARCHIVE_FILENAME = `${ARCHIVE_ROOT}-v${SPC_GROUP_DISPATCHER_VERSION}.zip`
const SOURCE_DIRECTORY = path.join(process.cwd(), "tools", "whatsapp-spc-group-dispatcher")
export async function GET() {
  try {
    await requireSpcPagePermission("spc-chrome-extension", "edit")
    const zip = await createStoredZip({
      archiveRoot: ARCHIVE_ROOT,
      sourceDirectory: SOURCE_DIRECTORY,
      files: SPC_GROUP_DISPATCHER_FILES,
    })
    return new Response(zip, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${ARCHIVE_FILENAME}"`,
        "Content-Length": String(zip.length),
        "Content-Type": "application/zip",
        "X-SPC-Dispatcher-Version": SPC_GROUP_DISPATCHER_VERSION,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to download group dispatcher."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return spcPrivateJson({ message }, { status })
  }
}
