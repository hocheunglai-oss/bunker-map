import { NextResponse } from "next/server"
import { getGraphAccessToken, graphGet, loadGraphStore, requireAdminAccess } from "../_shared"

export async function POST() {
  try {
    await requireAdminAccess("edit")
    const store = await loadGraphStore()
    if (!store?.tenantId || !store.adminConsent) {
      return NextResponse.json({ message: "Microsoft Graph admin consent has not been completed." }, { status: 400 })
    }

    const accessToken = await getGraphAccessToken(store.tenantId)
    const countData = await graphGet("/contacts/$count", accessToken)

    return NextResponse.json({
      ok: false,
      graphReachable: true,
      graphOrgContactCount: Number(countData),
      message:
        "Graph access is working, but Microsoft Graph organizational contacts are read-only. GAL updates still need Exchange PowerShell.",
    })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    return NextResponse.json({ message: error instanceof Error ? error.message : "Graph sync check failed." }, { status: 500 })
  }
}
