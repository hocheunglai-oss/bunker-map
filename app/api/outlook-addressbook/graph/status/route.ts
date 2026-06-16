import { NextResponse } from "next/server"
import { getGraphConfig, loadGraphStore, requireAdminAccess } from "../_shared"

export async function GET(request: Request) {
  try {
    await requireAdminAccess()
    const config = getGraphConfig(request)
    const store = await loadGraphStore()
    const consentUrl = config.configured
      ? `https://login.microsoftonline.com/common/adminconsent?${new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: config.redirectUri,
          state: config.state,
        }).toString()}`
      : ""

    return NextResponse.json({
      configured: config.configured,
      consented: Boolean(store?.tenantId && store?.adminConsent),
      tenantId: store?.tenantId || "",
      consentedAt: store?.consentedAt || "",
      consentUrl,
      limitation:
        "Microsoft Graph can read Exchange organizational contacts, but cannot create or update GAL mail contacts. Exchange PowerShell remains required for GAL writes.",
    })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    return NextResponse.json({ message: error instanceof Error ? error.message : "Could not load Graph status." }, { status: 500 })
  }
}
