import { NextResponse } from "next/server"
import { requireAdminPagePermissionForRequest } from "@/lib/adminAuth"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import { authenticatedCreationActor, confirmPriceSetterAcknowledgement, confirmPriceSetterCreationState, validatePriceSetterAcknowledgement } from "@/lib/priceSetterCreationRecovery"
import { PriceSetterValidationError } from "@/lib/priceSetterMutation"
import { readPriceSetterJsonBody } from "@/lib/priceSetterRequest"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" }
function reply(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: HEADERS }) }
function failure(error: unknown) {
  if (error instanceof Error && error.message === "Unauthorized") return reply({ message: "Please sign in before checking earlier additions." }, 401)
  if (error instanceof Error && error.message === "Forbidden") return reply({ message: "You do not have permission to add rows." }, 403)
  if (error instanceof PriceSetterValidationError) return reply({ message: error.message }, 400)
  return reply({ message: "Could not confirm the earlier addition. Please check it again before adding a new row." }, 503)
}

export async function GET(request: Request) {
  try {
    const session = await requireAdminPagePermissionForRequest(request, "pricesetter", "edit")
    const actorId = authenticatedCreationActor(session.adminUserId)
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw Error("Read unavailable")
    const client = createAdminAuditedSupabaseClient(createAdminAuditContext(session, undefined, "pricesetter"), { useServiceRole: true })
    const { data, error } = await client.rpc("read_price_setter_creation_state", { p_actor_id: actorId })
    if (error) throw Error("Read unconfirmed")
    return reply(confirmPriceSetterCreationState(data, actorId))
  } catch (error) { return failure(error) }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermissionForRequest(request, "pricesetter", "edit")
    const actorId = authenticatedCreationActor(session.adminUserId)
    const input = validatePriceSetterAcknowledgement(await readPriceSetterJsonBody(request))
    // The body binds an existing intention to a previously checked identity; it
    // never grants authority to choose the actor passed to the database.
    if (input.actorId !== actorId) return reply({ code: "CREATION_ACCOUNT_CHANGED", message: "Your signed-in account changed. Reload the page before continuing." }, 409)
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw Error("Acknowledgement unavailable")
    const client = createAdminAuditedSupabaseClient(createAdminAuditContext(session, undefined, "pricesetter"), { useServiceRole: true })
    const { data, error } = await client.rpc("acknowledge_price_setter_creation", { p_actor_id: actorId, p_request_id: input.requestId })
    if (error?.code === "P0002" && error.message === "CREATION_OWNER_MISMATCH") return reply({ code: "CREATION_ACCOUNT_CHANGED", message: "This addition cannot be checked with the current account. Reload the page." }, 409)
    if (error) throw Error("Acknowledgement unconfirmed")
    return reply(confirmPriceSetterAcknowledgement(data, input))
  } catch (error) { return failure(error) }
}
