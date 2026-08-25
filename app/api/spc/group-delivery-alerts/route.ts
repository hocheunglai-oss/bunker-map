import { requireSpcPagePermission } from "@/lib/spcAuth"
import { listSpcGroupDeliveryAlerts } from "@/lib/spcGroupDispatcher"
import { spcPrivateJson } from "@/lib/spcResponse"

export const runtime = "nodejs"

export async function GET() {
  try {
    await requireSpcPagePermission("spc-chrome-extension", "view")
    const alerts = await listSpcGroupDeliveryAlerts(24, 50)
    return spcPrivateJson({ alerts })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load group delivery alerts."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return spcPrivateJson({ message }, { status })
  }
}
