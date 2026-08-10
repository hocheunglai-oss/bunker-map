import { requireSpcAdminPagePermission } from "@/lib/spcAuth"
import { createSpcAuditContext } from "@/lib/spcAudit"
import {
  getSpcMfaTestTarget,
  isSameOriginSpcMfaTestRequest,
  recordSpcMfaTestAuditEvent,
  verifySpcMfaTestChallenge,
  type SpcMfaTestVerificationResult,
} from "@/lib/spcMfaTest"
import { spcPrivateJson } from "@/lib/spcResponse"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const RESULT_RESPONSE: Record<
  SpcMfaTestVerificationResult,
  { status: number; success: boolean; message: string }
> = {
  verified: {
    status: 200,
    success: true,
    message: "Code verified. This test did not change the SPC login session.",
  },
  mismatch: {
    status: 400,
    success: false,
    message: "The code is incorrect.",
  },
  locked: {
    status: 429,
    success: false,
    message: "Too many incorrect attempts. Send a new code after the cooldown.",
  },
  expired: {
    status: 410,
    success: false,
    message: "The code has expired. Send a new code.",
  },
  already_used: {
    status: 409,
    success: false,
    message: "This code has already been used.",
  },
  unavailable: {
    status: 404,
    success: false,
    message: "The test challenge is unavailable. Send a new code.",
  },
}

export async function POST(request: Request) {
  if (!isSameOriginSpcMfaTestRequest(request)) {
    return spcPrivateJson({ message: "Forbidden" }, { status: 403 })
  }

  try {
    const session = await requireSpcAdminPagePermission("spc-mfa-test", "edit")
    if (!session.userId) throw new Error("Unauthorized")

    const body = await request.json().catch(() => ({})) as {
      challengeId?: unknown
      targetUserId?: unknown
      code?: unknown
    }
    const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : ""
    const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId.trim() : ""
    const code = typeof body.code === "string" ? body.code.trim() : ""
    if (
      !UUID_PATTERN.test(challengeId) ||
      !UUID_PATTERN.test(targetUserId) ||
      !/^[0-9]{6}$/.test(code)
    ) {
      return spcPrivateJson({ message: "Enter the six-digit code." }, { status: 400 })
    }

    const target = await getSpcMfaTestTarget(targetUserId)
    if (!target) {
      return spcPrivateJson(
        { message: "The inactive SPC test account is unavailable." },
        { status: 400 },
      )
    }

    const requestedContext = createSpcAuditContext(
      session,
      request,
      "spc-mfa-test",
      {
        action: "verify-whatsapp-mfa-test-code",
        targetType: "spc-user",
        targetId: target.id,
        targetUsername: target.username,
        outcome: "success",
      },
    )

    try {
      await recordSpcMfaTestAuditEvent(requestedContext, {
        status: "verification_requested",
        outcome: "success",
        challengeId,
        target,
      })
    } catch {
      return spcPrivateJson(
        { message: "The WhatsApp MFA test audit service is temporarily unavailable." },
        { status: 503 },
      )
    }

    const verification = await verifySpcMfaTestChallenge({
      challengeId,
      targetUserId: target.id,
      createdByUserId: session.userId,
      code,
    })
    const response = RESULT_RESPONSE[verification.result]
    const outcome = verification.result === "verified" ? "success" : "failed"
    let auditRecorded = true
    try {
      await recordSpcMfaTestAuditEvent(
        { ...requestedContext, outcome },
        {
          status: verification.result,
          outcome,
          challengeId,
          target,
        },
      )
    } catch {
      auditRecorded = false
    }

    return spcPrivateJson(
      {
        success: response.success,
        result: verification.result,
        message: response.message,
        attemptsRemaining: verification.attemptsRemaining,
        expiresAt: verification.expiresAt,
        warning: auditRecorded
          ? undefined
          : "The verification completed, but the final audit record could not be saved.",
      },
      { status: response.status },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 503
    return spcPrivateJson(
      {
        message: status === 503
          ? "The WhatsApp MFA test is temporarily unavailable."
          : message,
      },
      { status },
    )
  }
}
