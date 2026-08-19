import path from "node:path"
import { readFile } from "node:fs/promises"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import {
  SPC_GROUP_DISPATCHER_FILES,
  type SpcGroupDispatcherFileName,
} from "@/lib/spcGroupDispatcherPackage"
import { SPC_GROUP_DISPATCHER_VERSION } from "@/lib/spcGroupDispatcherVersion"
import { spcPrivateJson } from "@/lib/spcResponse"

export const runtime = "nodejs"

const SOURCE_DIRECTORY = path.join(process.cwd(), "tools", "whatsapp-spc-group-dispatcher")

export async function GET() {
  try {
    await requireSpcPagePermission("spc-chrome-extension", "edit")
    const files = await Promise.all(
      SPC_GROUP_DISPATCHER_FILES.map(async (name: SpcGroupDispatcherFileName) => ({
        name,
        contentBase64: (await readFile(path.join(SOURCE_DIRECTORY, name))).toString("base64"),
      })),
    )
    return spcPrivateJson({
      version: SPC_GROUP_DISPATCHER_VERSION,
      files,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load group dispatcher files."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return spcPrivateJson({ message }, { status })
  }
}
