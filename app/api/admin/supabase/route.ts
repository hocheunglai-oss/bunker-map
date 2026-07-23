import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const PAGE_TABLES: Record<string, Set<string>> = {
  pricesetter: new Set(["ports", "price_history", "remarks"]),
  "hongkong-price-history": new Set(["ports", "price_history", "remarks"]),
  "taiwan-price-history": new Set(["ports", "price_history", "remarks"]),
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
    "shared_addressbook_contacts",
    "shared_addressbook_group_members",
    "shared_addressbook_groups",
  ]),
}

const PAGE_AUDIT_CONTEXT: Record<string, { label: string; path: string }> = {
  pricesetter: { label: "PRICE SETTER", path: "/admin/pricesetter" },
  "hongkong-price-history": { label: "HONG KONG PRICE HISTORY", path: "/admin/hongkongpricehistory" },
  "taiwan-price-history": { label: "TAIWAN PRICE HISTORY", path: "/admin/taiwanpricehistory" },
  "taiwan-remarks": { label: "TAIWAN REMARKS", path: "/admin/taiwanremarks" },
  ccinfo: { label: "CCINFO", path: "/admin/ccinfo" },
  phonebook: { label: "PHONEBOOK", path: "/admin/phonebook" },
  "outlook-addressbook": { label: "OUTLOOK ADDRESS BOOK", path: "/admin/outlookaddressbook" },
  "email-templates": { label: "OUTLOOK TEMPLATES", path: "/admin/outlooktemplates" },
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Database action failed."
  const status =
    message === "Unauthorized"
      ? 401
      : message === "Forbidden"
        ? 403
        : message.startsWith("Select an existing phonebook company:")
          ? 400
          : 500
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

async function validatePhonebookContactCompanies(body: ArrayBuffer, serviceKey: string) {
  if (body.byteLength === 0) return

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return
  }

  const rows = Array.isArray(payload) ? payload : [payload]
  const companyNames = Array.from(
    new Set(
      rows.flatMap((row) => {
        if (!row || typeof row !== "object" || !("company" in row)) return []
        const company = (row as { company?: unknown }).company
        return typeof company === "string" && company.trim() ? [company.trim().toUpperCase()] : []
      }),
    ),
  )
  if (companyNames.length === 0) return

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || "", serviceKey)
  const { data, error } = await supabase
    .from("phonebook_companies")
    .select("name")
    .in("name", companyNames)

  if (error) throw error

  const existing = new Set((data || []).map((company) => company.name?.trim().toUpperCase()))
  const missing = companyNames.filter((company) => !existing.has(company))
  if (missing.length > 0) {
    throw new Error(`Select an existing phonebook company: ${missing.join(", ")}`)
  }
}

async function proxyRequest(request: Request) {
  try {
    const pageId = request.headers.get("x-bunker-admin-page-id") || ""
    const target = getTarget(request)
    const table = target.pathname.replace(/^\/rest\/v1\//, "").split("/")[0]
    const isRead = ["GET", "HEAD"].includes(request.method)

    if (!pageId || !PAGE_TABLES[pageId]?.has(table)) {
      return NextResponse.json({ message: "Forbidden" }, { status: 403 })
    }

    const session = await requireAdminPagePermission(pageId, isRead ? "view" : "edit")

    const headers = new Headers()
    ;[
      "accept",
      "accept-profile",
      "content-profile",
      "content-type",
      "prefer",
      "range",
    ].forEach((name) => {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    })

    if (!isRead) {
      if (!session.username) throw new Error("Unauthorized")
      const pageContext = PAGE_AUDIT_CONTEXT[pageId]
      headers.set("x-bunker-admin-user", session.username)
      headers.set(
        "x-bunker-admin-display-name",
        session.displayName || session.username,
      )
      if (session.role) headers.set("x-bunker-admin-role", session.role)
      headers.set("x-bunker-admin-page-id", pageId)
      headers.set("x-bunker-admin-page-label", pageContext?.label || pageId)
      headers.set("x-bunker-admin-page-path", pageContext?.path || `/admin/${pageId}`)
    }

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!serviceKey) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.")
    }
    headers.set("apikey", serviceKey)
    headers.set("authorization", `Bearer ${serviceKey}`)
    const requestBody = isRead ? undefined : await request.arrayBuffer()

    if (
      table === "phonebook_contacts" &&
      ["POST", "PATCH"].includes(request.method) &&
      requestBody
    ) {
      await validatePhonebookContactCompanies(requestBody, serviceKey)
    }

    const response = await fetch(target, {
      method: request.method,
      headers,
      body: requestBody,
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

export const GET = proxyRequest
export const HEAD = proxyRequest
export const POST = proxyRequest
export const PATCH = proxyRequest
export const DELETE = proxyRequest
