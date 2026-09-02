import { requireSpcPagePermission } from "@/lib/spcAuth"
import { spcPrivateJson } from "@/lib/spcResponse"
import { listSpcVesselHistory } from "@/lib/spcVesselHistory"

export async function GET(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-buyer-enquiries", "view")
    const searchParams = new URL(request.url).searchParams
    const vesselName = searchParams.get("vesselName")?.trim() || ""
    const imo = searchParams.get("imo")?.trim() || ""

    if (!vesselName && !imo) {
      return spcPrivateJson(
        { message: "Vessel name or IMO is required." },
        { status: 400 },
      )
    }

    const history = await listSpcVesselHistory(session, request, { vesselName, imo })
    return spcPrivateJson(history)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load vessel history."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return spcPrivateJson({ message }, { status })
  }
}
