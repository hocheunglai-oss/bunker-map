import { cookies } from "next/headers"
import { createClient } from "@supabase/supabase-js"

export const GRAPH_STORE_KEY = "outlook-addressbook-graph"
const ADMIN_COOKIE_NAME = "bunker_admin_auth"

export type GraphStorePayload = {
  tenantId?: string
  consentedAt?: string
  adminConsent?: boolean
}

export function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

export function getGraphConfig(request?: Request) {
  const clientId = process.env.MICROSOFT_GRAPH_CLIENT_ID || ""
  const clientSecret = process.env.MICROSOFT_GRAPH_CLIENT_SECRET || ""
  const baseUrl =
    process.env.MICROSOFT_GRAPH_REDIRECT_BASE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    (request ? new URL(request.url).origin : "")
  const redirectUri = `${baseUrl.replace(/\/$/, "")}/api/outlook-addressbook/graph/callback`
  const state = process.env.MICROSOFT_GRAPH_CONSENT_STATE || "fcuno-outlook-addressbook"

  return {
    clientId,
    clientSecret,
    redirectUri,
    state,
    configured: Boolean(clientId && clientSecret && baseUrl),
  }
}

export function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
  )
}

export async function requireAdminAccess() {
  const cookieStore = await cookies()
  if (cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
    throw new Error("Unauthorized")
  }
}

export async function loadGraphStore(): Promise<GraphStorePayload | null> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from("office_calendar_store")
    .select("payload")
    .eq("key", GRAPH_STORE_KEY)
    .maybeSingle()

  if (error) throw error
  return (data?.payload as GraphStorePayload | null) || null
}

export async function saveGraphStore(payload: GraphStorePayload) {
  const supabase = getSupabaseClient()
  const { error } = await supabase.from("office_calendar_store").upsert({
    key: GRAPH_STORE_KEY,
    payload,
    updated_at: new Date().toISOString(),
  })
  if (error) throw error
}

export async function getGraphAccessToken(tenantId: string) {
  const config = getGraphConfig()
  if (!config.configured) throw new Error("Microsoft Graph is not configured.")

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  })

  const data = await response.json()
  if (!response.ok) throw new Error(data.error_description || data.error || "Could not get Microsoft Graph token.")
  return data.access_token as string
}

export async function graphGet(path: string, accessToken: string) {
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ConsistencyLevel: "eventual",
    },
  })
  const raw = await response.text()
  const data = raw ? JSON.parse(raw) : null
  if (!response.ok) throw new Error(data.error?.message || "Microsoft Graph request failed.")
  return data
}
