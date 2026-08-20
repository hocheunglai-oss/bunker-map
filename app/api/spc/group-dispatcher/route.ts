import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import {
  SPC_GROUP_DISPATCHER_VERSION,
  claimSpcGroupDelivery,
  completeSpcGroupDelivery,
  getActiveSpcGroupDispatcher,
  getLatestSpcGroupDelivery,
  heartbeatSpcGroupDispatcher,
  pairSpcGroupDispatcher,
  revokeSpcGroupDispatcher,
} from "@/lib/spcGroupDispatcher"
import { getSpcGroupDeliveryHealth } from "@/lib/spcDeliveryRoutes"

export const runtime = "nodejs"

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  })
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") || ""
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : ""
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "SPC group dispatcher request failed."
  const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 400
  return privateJson({ message }, status)
}

export async function GET() {
  try {
    await requireSpcPagePermission("spc-chrome-extension", "view")
    const [dispatcher, health] = await Promise.all([
      getActiveSpcGroupDispatcher(),
      getSpcGroupDeliveryHealth(),
    ])
    return privateJson({
      dispatcher,
      health,
      version: SPC_GROUP_DISPATCHER_VERSION,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>
    const action = typeof payload.action === "string" ? payload.action : ""

    if (action === "pair") {
      const session = await requireSpcPagePermission("spc-chrome-extension", "edit")
      const paired = await pairSpcGroupDispatcher({
        session,
        request,
        dispatcherId: typeof payload.dispatcherId === "string" ? payload.dispatcherId : undefined,
        deviceLabel: typeof payload.deviceLabel === "string" ? payload.deviceLabel : "",
        groupName: typeof payload.groupName === "string" ? payload.groupName : "",
        extensionVersion: typeof payload.extensionVersion === "string" ? payload.extensionVersion : "",
      })
      return privateJson({ success: true, ...paired, version: SPC_GROUP_DISPATCHER_VERSION })
    }

    if (action === "revoke") {
      const session = await requireSpcPagePermission("spc-chrome-extension", "edit")
      await revokeSpcGroupDispatcher(session, request)
      return privateJson({ success: true })
    }

    const token = bearerToken(request)
    if (!token) return privateJson({ message: "Unauthorized" }, 401)
    const extensionVersion = typeof payload.extensionVersion === "string" ? payload.extensionVersion : ""

    if (action === "heartbeat") {
      const dispatcher = await heartbeatSpcGroupDispatcher(token, extensionVersion)
      return dispatcher
        ? privateJson({ success: true, dispatcher })
        : privateJson({ message: "Unauthorized" }, 401)
    }

    if (action === "claim") {
      const claimed = await claimSpcGroupDelivery(token, extensionVersion)
      return claimed
        ? privateJson({ success: true, ...claimed })
        : privateJson({ message: "Unauthorized" }, 401)
    }

    if (action === "latest") {
      const job = await getLatestSpcGroupDelivery(token)
      return privateJson({ success: true, job })
    }

    if (action === "complete") {
      const result = payload.result === "sent" || payload.result === "failed" || payload.result === "manual_review"
        ? payload.result
        : null
      if (!result) return privateJson({ message: "Invalid delivery result." }, 400)
      const completed = await completeSpcGroupDelivery({
        token,
        jobId: typeof payload.jobId === "string" ? payload.jobId : "",
        claimToken: typeof payload.claimToken === "string" ? payload.claimToken : "",
        result,
        error: typeof payload.error === "string" ? payload.error : undefined,
      })
      return completed
        ? privateJson({ success: true, job: completed })
        : privateJson({ message: "Delivery claim is no longer valid." }, 409)
    }

    return privateJson({ message: "Unsupported dispatcher action." }, 400)
  } catch (error) {
    return errorResponse(error)
  }
}
