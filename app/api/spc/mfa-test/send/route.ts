import { requireSpcAdminPagePermission } from "@/lib/spcAuth"
import { createSpcAuditContext } from "@/lib/spcAudit"
import {
  SpcMfaTestDeliveryError,
  SPC_MFA_TEST_MAX_ATTEMPTS,
  beginSpcMfaTestChallenge,
  completeSpcMfaTestDelivery,
  getSpcMfaTestTarget,
  isSameOriginSpcMfaTestRequest,
  isSpcMfaTestConfigured,
  recordSpcMfaTestAuditEvent,
  sendSpcMfaTestCode,
} from "@/lib/spcMfaTest"
import { spcPrivateJson } from "@/lib/spcResponse"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function unavailableResponse(status = 503) {
  return spcPrivateJson(
    { message: "The WhatsApp MFA test is temporarily unavailable." },
    { status },
  )
}

function retryPeriod(seconds: number) {
  if (seconds >= 60 * 60) {
    const hours = Math.ceil(seconds / (60 * 60))
    return `${hours} ${hours === 1 ? "hour" : "hours"}`
  }
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60)
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
  }
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`
}

export async function POST(request: Request) {
  if (!isSameOriginSpcMfaTestRequest(request)) {
    return spcPrivateJson({ message: "Forbidden" }, { status: 403 })
  }

  let challengeId: string | null = null
  let target: Awaited<ReturnType<typeof getSpcMfaTestTarget>> = null
  let session: Awaited<ReturnType<typeof requireSpcAdminPagePermission>> | null = null

  try {
    session = await requireSpcAdminPagePermission("spc-mfa-test", "edit")
    if (!session.userId) throw new Error("Unauthorized")
    if (!isSpcMfaTestConfigured()) return unavailableResponse()

    const body = await request.json().catch(() => ({})) as { targetUserId?: unknown }
    const targetUserId = typeof body.targetUserId === "string"
      ? body.targetUserId.trim()
      : ""
    if (!UUID_PATTERN.test(targetUserId)) {
      return spcPrivateJson({ message: "Select an inactive SPC test account." }, { status: 400 })
    }

    target = await getSpcMfaTestTarget(targetUserId)
    if (!target || !target.ready) {
      return spcPrivateJson(
        { message: "The inactive SPC test account does not have a usable WhatsApp number." },
        { status: 400 },
      )
    }

    const challenge = await beginSpcMfaTestChallenge({
      targetUserId: target.id,
      createdByUserId: session.userId,
    })
    if (!challenge.allowed) {
      return spcPrivateJson(
        {
          message: `Please wait ${retryPeriod(challenge.retryAfterSeconds)} before requesting another code.`,
          retryAfterSeconds: challenge.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(challenge.retryAfterSeconds) },
        },
      )
    }
    challengeId = challenge.challengeId

    const requestedContext = createSpcAuditContext(
      session,
      request,
      "spc-mfa-test",
      {
        action: "send-whatsapp-mfa-test-code",
        targetType: "spc-user",
        targetId: target.id,
        targetUsername: target.username,
        outcome: "success",
      },
    )

    try {
      await recordSpcMfaTestAuditEvent(requestedContext, {
        status: "challenge_created",
        outcome: "success",
        challengeId,
        target,
      })
    } catch {
      await completeSpcMfaTestDelivery({
        challengeId,
        createdByUserId: session.userId,
        succeeded: false,
      }).catch(() => undefined)
      return unavailableResponse()
    }

    let messageId = ""
    try {
      const delivery = await sendSpcMfaTestCode({
        to: target.whatsappPhone,
        code: challenge.code,
      })
      messageId = delivery.messageId
    } catch (error) {
      await completeSpcMfaTestDelivery({
        challengeId,
        createdByUserId: session.userId,
        succeeded: false,
      }).catch(() => undefined)

      const failureContext = { ...requestedContext, outcome: "failed" as const }
      await recordSpcMfaTestAuditEvent(failureContext, {
        status: "delivery_failed",
        outcome: "failed",
        challengeId,
        target,
      }).catch(() => undefined)

      const safeDetails = error instanceof SpcMfaTestDeliveryError
        ? {
            category: error.category,
            upstreamStatus: error.upstreamStatus,
            upstreamCode: error.upstreamCode,
            requestId: requestedContext.requestId,
          }
        : { category: "unknown", requestId: requestedContext.requestId }
      console.error("[spc-mfa-test-delivery]", safeDetails)
      return unavailableResponse(502)
    }

    try {
      await completeSpcMfaTestDelivery({
        challengeId,
        createdByUserId: session.userId,
        succeeded: true,
        messageId,
      })
    } catch {
      await recordSpcMfaTestAuditEvent({ ...requestedContext, outcome: "failed" }, {
        status: "activation_failed",
        outcome: "failed",
        challengeId,
        target,
        messageId,
      }).catch(() => undefined)
      return spcPrivateJson(
        {
          message: "WhatsApp accepted the send request, but SPC could not activate the test challenge.",
        },
        { status: 503 },
      )
    }

    let auditRecorded = true
    try {
      await recordSpcMfaTestAuditEvent(requestedContext, {
        status: "delivery_accepted",
        outcome: "success",
        challengeId,
        target,
        messageId,
      })
    } catch {
      auditRecorded = false
    }

    return spcPrivateJson({
      success: true,
      challengeId,
      expiresAt: challenge.expiresAt,
      attemptsRemaining: SPC_MFA_TEST_MAX_ATTEMPTS,
      phoneHint: target.phoneHint,
      message: `WhatsApp accepted a request to send a six-digit test code to ${target.phoneHint}.`,
      warning: auditRecorded
        ? undefined
        : "The code was sent, but the final delivery audit record could not be saved.",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 503
    if (status === 503) {
      console.error("[spc-mfa-test-send]", {
        requestFailed: true,
        challengeCreated: Boolean(challengeId),
        targetResolved: Boolean(target),
        sessionResolved: Boolean(session),
      })
    }
    return status === 503
      ? unavailableResponse()
      : spcPrivateJson({ message }, { status })
  }
}
