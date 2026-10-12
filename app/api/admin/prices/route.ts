import { NextResponse } from "next/server"
import { requireAdminPagePermissionForRequest } from "@/lib/adminAuth"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import { confirmPriceSetterCreation, confirmPriceSetterDeletion, confirmPriceSetterSave, PriceSetterValidationError, validatePriceSetterDeletion, validatePriceSetterSave } from "@/lib/priceSetterMutation"
import { getMarketDateKey } from "@/lib/priceHistoryRecords"
import { confirmPriceSetterDivider, parsePriceSetterFallbacks, validatePriceSetterSettingChange } from "@/lib/priceSetterSettings"
import { confirmPriceSetterOrder, validatePriceSetterReorder } from "@/lib/priceSetterOrder"
import { confirmPriceSetterInventory } from "@/lib/priceSetterInventory"
import { authenticatedCreationActor, validateOwnedPriceSetterCreation } from "@/lib/priceSetterCreationRecovery"
import { readPriceSetterJsonBody as readBody } from "@/lib/priceSetterRequest"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" }

function reply(value: unknown, status = 200) { return NextResponse.json(value, { status, headers: HEADERS }) }

export async function GET(request: Request) {
  try {
    const session = await requireAdminPagePermissionForRequest(request, "pricesetter", "view")
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw Error("Read unavailable")
    const client = createAdminAuditedSupabaseClient(createAdminAuditContext(session, undefined, "pricesetter"), { useServiceRole: true })
    const { data, error } = await client.rpc("read_price_setter_inventory", {})
    if (error) throw Error("Read unavailable")
    return reply(confirmPriceSetterInventory(data))
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") return reply({ message: "Please sign in to load saved ports." }, 401)
    if (error instanceof Error && error.message === "Forbidden") return reply({ message: "You do not have permission to view saved ports." }, 403)
    return reply({ message: "Could not load the complete saved port list. Please try again." }, 503)
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requireAdminPagePermissionForRequest(request, "pricesetter", "edit")
    const actorId = authenticatedCreationActor(session.adminUserId)
    const input = validateOwnedPriceSetterCreation(await readBody(request))
    if (input.actorId !== actorId) return reply({ code: "CREATION_ACCOUNT_CHANGED", message: "Your signed-in account changed. Reload the page before adding a row." }, 409)
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw Error("Creation unavailable")
    const client = createAdminAuditedSupabaseClient(createAdminAuditContext(session, undefined, "pricesetter"), { useServiceRole: true })
    const { data, error } = await client.rpc("create_owned_price_setter_port", { p_actor_id: actorId, p_request_id: input.requestId, p_kind: input.kind, p_expected_version: input.expectedVersion })
    const conflicts: Record<string, string> = {
      CREATION_OWNER_MISMATCH: "The earlier addition belongs to a different account. Reload the page before continuing.",
      CREATION_PENDING: "An earlier addition still needs to be checked. Reload previous additions before trying again.",
      CREATION_VERSION_CHANGED: "Another addition was completed while this page was open. Reload previous additions before adding a row.",
    }
    if (error?.code === "P0002" && Object.hasOwn(conflicts, error.message)) return reply({ code: error.message, message: conflicts[error.message] }, 409)
    if (error?.code === "P0002" && error.message === "CREATION_KIND_CHANGED") return reply({ code: "CREATION_KIND_CHANGED", message: "Retry the original addition before choosing a different row type." }, 409)
    if (error?.code === "P0002" && error.message === "CREATION_ORDER_FULL") return reply({ code: "CREATION_ORDER_FULL", message: "Save a new port order before adding another row." }, 409)
    if (error?.code === "22023") return reply({ message: "Choose Add Port or Add Divider and try again." }, 400)
    if (error) throw Error("Creation unconfirmed")
    // A retired receipt is a confirmed read-only outcome, not permission to
    // recreate the deleted row. Keep its receipt in the success response so the
    // client can validate the exact request before clearing a pending attempt.
    confirmPriceSetterCreation(data, input)
    return reply(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message === "Unauthorized") return reply({ message: "Please sign in before adding a row." }, 401)
    if (message === "Forbidden") return reply({ message: "You do not have permission to add rows." }, 403)
    if (error instanceof PriceSetterValidationError) return reply({ message: error.message }, 400)
    return reply({ message: "The addition could not be confirmed. Reload saved ports before retrying the same addition." }, 503)
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermissionForRequest(request, "pricesetter", "edit")
    const input = validatePriceSetterSave(await readBody(request))
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Price save is unavailable")
    // Pin audit attribution to this route's page, not an arbitrary Referer.
    const context = createAdminAuditContext(session, undefined, "pricesetter")
    const client = createAdminAuditedSupabaseClient(context, { useServiceRole: true })
    const recordedAt = new Date().toISOString()
    const { data, error } = await client.rpc("save_price_setter_port", {
      p_port_id: input.portId, p_expected: input.expected, p_changes: input.changes,
      p_recorded_at: recordedAt,
    })
    if (error?.code === "P0002") return reply({ code: "PRICE_CONFLICT", message: "Saved prices changed while you were editing. Your draft is still here. Reload saved ports before trying again." }, 409)
    if (error?.code === "23503" && error.message === "PORT_REQUIRED_NAME") return reply({ code: "PORT_REQUIRED", message: "This port name is required by a market report. Keep its existing name; you can still edit its prices and other details. Your draft is still here." }, 409)
    if (error?.code === "22023") return reply({ message: "Check the port name and formulas. References must identify one existing port and cannot form a loop." }, 400)
    if (error) throw new Error("Price save was not confirmed")
    confirmPriceSetterSave(data, input.portId, input.changes, getMarketDateKey(recordedAt))
    return reply(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message === "Unauthorized") return reply({ message: "Please sign in before saving prices." }, 401)
    if (message === "Forbidden") return reply({ message: "You do not have permission to edit prices." }, 403)
    if (error instanceof PriceSetterValidationError) return reply({ message: error.message }, 400)
    return reply({ message: "The save could not be confirmed. Your draft is still here; reload saved ports to check before retrying." }, 503)
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireAdminPagePermissionForRequest(request, "pricesetter", "edit")
    // Bound transport size, not inventory row count. A complete list larger
    // than the platform-safe request budget is rejected explicitly, never cut.
    const body = await readBody(request, 4_000_000)
    let input
    try { input = (body as { operation?: unknown })?.operation === "reorder" ? validatePriceSetterReorder(body) : validatePriceSetterSettingChange(body) }
    catch { throw new PriceSetterValidationError("Check the setting or reload saved ports before trying again.") }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Save unavailable")
    const client = createAdminAuditedSupabaseClient(createAdminAuditContext(session, undefined, "pricesetter"), { useServiceRole: true })
    const { data, error } = input.operation === "fallback"
      ? await client.rpc("save_price_setter_fallback", { p_key: input.key, p_expected_value: input.expectedValue, p_value: input.value })
      : input.operation === "reorder"
        ? await client.rpc("reorder_price_setter_ports", { p_expected: input.expected, p_order: input.order })
        : await client.rpc("rename_price_setter_divider", { p_port_id: input.portId, p_expected_name: input.expectedName, p_name: input.name })
    if (error?.code === "P0002") return reply({ code: "PRICE_CONFLICT", message: "This saved value changed while you were editing. Your draft is still here. Reload the saved values before trying again." }, 409)
    if (error?.code === "22023") return reply({ message: "Check the report setting or divider name before saving." }, 400)
    if (error || !data) throw new Error("Save unconfirmed")
    // Response validation is not input validation: a broken success response
    // means an uncertain save, not a mistake in the user's draft.
    try {
      if (input.operation === "fallback") {
        const confirmed = parsePriceSetterFallbacks(JSON.stringify(data.fallbacks))
        if (data.key !== input.key || confirmed[input.key] !== input.value) throw new Error("Save unconfirmed")
      } else if (input.operation === "reorder") confirmPriceSetterOrder(data, input.order)
      else confirmPriceSetterDivider(data, input.portId, input.name)
    } catch { throw new Error("Save unconfirmed") }
    return reply(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message === "Unauthorized") return reply({ message: "Please sign in before saving." }, 401)
    if (message === "Forbidden") return reply({ message: "You do not have permission to edit these settings." }, 403)
    if (error instanceof PriceSetterValidationError) return reply({ message: error.message }, 400)
    return reply({ message: "The save could not be confirmed. Your draft is still here; reload saved values to check before retrying." }, 503)
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireAdminPagePermissionForRequest(request, "pricesetter", "edit")
    const input = validatePriceSetterDeletion(await readBody(request))
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw Error("Deletion unavailable")
    const client = createAdminAuditedSupabaseClient(createAdminAuditContext(session, undefined, "pricesetter"), { useServiceRole: true })
    const { data, error } = await client.rpc("delete_price_setter_port", {
      p_port_id: input.portId, p_expected: input.expected, p_expected_fallbacks: input.expectedFallbacks,
    })
    if (error?.code === "P0002") return reply({ code: "PRICE_CONFLICT", message: "This port or its report settings changed. Nothing was deleted. Reload saved ports and settings before trying again." }, 409)
    if (error?.code === "23503") {
      const messages: Record<string, string> = {
        PORT_REQUIRED: "This port is required by a market report and cannot be deleted.",
        PORT_FORMULA: "Other ports use this port's prices. Change their formulas before deleting it.",
        PORT_FORMULA_INVALID: "Some saved price formulas could not be read. Correct them before deleting a port.",
        PORT_HISTORY: "This port has saved price history. Deletion is blocked to preserve those records.",
        PORT_NAME: "Another port has the same name. Resolve the duplicate names before deleting it.",
      }
      return reply({ code: "PORT_IN_USE", message: messages[error.message] || "This port is still in use. Nothing was deleted." }, 409)
    }
    if (error?.code === "22023") return reply({ message: "Reload saved ports and settings before deleting." }, 400)
    if (error) throw Error("Deletion unconfirmed")
    try { confirmPriceSetterDeletion(data, input.portId) } catch { throw Error("Deletion unconfirmed") }
    return reply(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message === "Unauthorized") return reply({ message: "Please sign in before deleting a port." }, 401)
    if (message === "Forbidden") return reply({ message: "You do not have permission to delete ports." }, 403)
    if (error instanceof PriceSetterValidationError) return reply({ message: error.message }, 400)
    return reply({ message: "Could not confirm deletion. The row is still shown; reload saved ports to check before trying again." }, 503)
  }
}
