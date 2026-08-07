import { getGraphConfig, requireAdminAccess, saveGraphStore } from "../_shared"
import { graphCallbackHtmlResponse } from "./response"

export async function GET(request: Request) {
  try {
    await requireAdminAccess("edit")
  } catch (error) {
    return graphCallbackHtmlResponse(
      "Microsoft Graph Consent Failed",
      error instanceof Error ? error.message : "Permission denied."
    )
  }

  const url = new URL(request.url)
  const config = getGraphConfig(request)
  const state = url.searchParams.get("state") || ""
  const adminConsent = url.searchParams.get("admin_consent") === "True"
  const tenantId = url.searchParams.get("tenant") || ""
  const error = url.searchParams.get("error_description") || url.searchParams.get("error")

  if (error) return graphCallbackHtmlResponse("Microsoft Graph Consent Failed", error)
  if (state !== config.state) return graphCallbackHtmlResponse("Microsoft Graph Consent Failed", "The consent state did not match.")
  if (!adminConsent || !tenantId) return graphCallbackHtmlResponse("Microsoft Graph Consent Failed", "Admin consent was not completed.")

  await saveGraphStore({
    tenantId,
    adminConsent: true,
    consentedAt: new Date().toISOString(),
  })

  return graphCallbackHtmlResponse("Microsoft Graph Consent Saved", "Admin consent has been recorded for this tenant.")
}
