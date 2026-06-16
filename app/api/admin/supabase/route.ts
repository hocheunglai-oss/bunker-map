import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const PAGE_TABLES: Record<string, Set<string>> = {
  pricesetter: new Set(["ports", "price_history"]),
  "hongkong-price-history": new Set(["price_history"]),
  "taiwan-price-history": new Set(["price_history"]),
  "taiwan-remarks": new Set(["remarks"]),
  ccinfo: new Set([
    "cc_companies",
    "cc_company_files",
    "cc_countries",
    "cc_entry_files",
    "cc_entry_folders",
    "cc_ports",
  ]),
  phonebook: new Set(["phonebook_companies", "phonebook_contacts"]),
  "outlook-addressbook": new Set([
    "outlook_exchange_sync_queue",
    "shared_addressbook_contacts",
    "shared_addressbook_group_members",
    "shared_addressbook_groups",
  ]),
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Database action failed."
  const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
  return NextResponse.json({ message }, { status })
}

function getTarget(request: Request) {
  const targetValue = new URL(request.url).searchParams.get("target")
  if (!targetValue) throw new Error("Missing database target.")

  const target = new URL(targetValue)
  const supabaseOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "").origin
  if (target.origin !== supabaseOrigin || !target.pathname.startsWith("/rest/v1/")) {
    throw new Error("Invalid database target.")
  }

  return target
}

async function proxyMutation(request: Request) {
  try {
    const pageId = request.headers.get("x-bunker-admin-page-id") || ""
    const target = getTarget(request)
    const table = target.pathname.replace(/^\/rest\/v1\//, "").split("/")[0]

    if (!pageId || !PAGE_TABLES[pageId]?.has(table)) {
      return NextResponse.json({ message: "Forbidden" }, { status: 403 })
    }

    await requireAdminPagePermission(pageId, "edit")

    const headers = new Headers()
    ;[
      "accept",
      "accept-profile",
      "content-profile",
      "content-type",
      "prefer",
      "range",
      "x-bunker-admin-display-name",
      "x-bunker-admin-page-id",
      "x-bunker-admin-page-label",
      "x-bunker-admin-page-path",
      "x-bunker-admin-role",
      "x-bunker-admin-user",
    ].forEach((name) => {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    })

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!serviceKey) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.")
    }
    headers.set("apikey", serviceKey)
    headers.set("authorization", `Bearer ${serviceKey}`)

    const response = await fetch(target, {
      method: request.method,
      headers,
      body: await request.arrayBuffer(),
      cache: "no-store",
    })
    const responseHeaders = new Headers()
    ;["content-type", "content-range", "location", "preference-applied"].forEach((name) => {
      const value = response.headers.get(name)
      if (value) responseHeaders.set(name, value)
    })

    const responseBody =
      response.status === 204 || response.status === 205 ? null : await response.arrayBuffer()

    return new NextResponse(responseBody, {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export const POST = proxyMutation
export const PATCH = proxyMutation
export const DELETE = proxyMutation
