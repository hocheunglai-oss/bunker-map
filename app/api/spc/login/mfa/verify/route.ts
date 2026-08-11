import {
  setSpcVerifiedSession,
} from "@/lib/spcAuth"
import { SPC_PAGE_DEFINITIONS } from "@/lib/spcPages"
import { spcPrivateJson } from "@/lib/spcResponse"
import { revokeDatabaseSpcSession } from "@/lib/spcSessions"
import { getDatabaseSpcUserById } from "@/lib/spcUsers"
import {
  clearSpcWhatsappLoginMfaPendingCookie,
  isSameOriginSpcWhatsappLoginMfaRequest,
  isSpcWhatsappLoginMfaConfigured,
  isSpcWhatsappLoginMfaEnabled,
  requiresSpcWhatsappLoginMfa,
  verifySpcWhatsappLoginMfaCode,
  type SpcWhatsappLoginMfaResult,
} from "@/lib/spcWhatsappLoginMfa"
import { createTrustedRequestContext } from "@/lib/trustedRequestContext"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const RESULT_STATUS: Record<Exclude<SpcWhatsappLoginMfaResult, "verified">, number> = {
  mismatch: 400,
  locked: 429,
  expired: 410,
  already_used: 409,
  cancelled: 410,
  user_changed: 410,
  unavailable: 410,
}

function unavailableResponse(status = 503) {
  return spcPrivateJson(
    { success: false, message: "Sign-in is temporarily unavailable. Please try again." },
    { status },
  )
}

export async function POST(request: Request) {
  if (!isSameOriginSpcWhatsappLoginMfaRequest(request)) {
    return spcPrivateJson({ success: false, message: "Forbidden" }, { status: 403 })
  }
  if (!isSpcWhatsappLoginMfaEnabled() || !isSpcWhatsappLoginMfaConfigured()) {
    await clearSpcWhatsappLoginMfaPendingCookie().catch(() => undefined)
    return unavailableResponse()
  }

  const body = await request.json().catch(() => ({})) as { code?: unknown }
  const code = typeof body.code === "string" ? body.code.trim() : ""
  if (!/^[0-9]{6}$/.test(code)) {
    return spcPrivateJson(
      { success: false, message: "Enter the six-digit code." },
      { status: 400 },
    )
  }

  let createdSessionToken = ""
  try {
    const verification = await verifySpcWhatsappLoginMfaCode(code)
    if (verification.result !== "verified") {
      if (verification.result !== "mismatch") {
        await clearSpcWhatsappLoginMfaPendingCookie().catch(() => undefined)
      }
      return spcPrivateJson(
        {
          success: false,
          result: verification.result,
          message:
            "The code could not be verified. Request a new code or sign in again.",
          attemptsRemaining: verification.attemptsRemaining,
          expiresAt: verification.expiresAt,
        },
        { status: RESULT_STATUS[verification.result] },
      )
    }

    createdSessionToken = verification.sessionToken
    const user = await getDatabaseSpcUserById(verification.spcUserId)
    if (
      !user ||
      user.credentialUpdatedAt !== verification.userUpdatedAt ||
      !requiresSpcWhatsappLoginMfa(user.username)
    ) {
      throw new Error("The verified SPC user changed before session activation.")
    }

    await setSpcVerifiedSession({
      token: verification.sessionToken,
      expiresAt: verification.sessionExpiresAt,
      mfaVerifiedAt: verification.mfaVerifiedAt,
    })
    await clearSpcWhatsappLoginMfaPendingCookie()

    const requestContext = createTrustedRequestContext(request)
    console.info("[spc-login-security]", {
      event: "mfa_authenticated",
      requestId: requestContext.requestId,
      platformRequestId: requestContext.platformRequestId,
    })

    return spcPrivateJson({
      success: true,
      user: {
        username: user.username,
        displayName: user.displayName || user.username,
        role: user.role,
        office: user.office,
        mustChangePassword: user.mustChangePassword,
        permissions: user.permissions,
      },
      pages: SPC_PAGE_DEFINITIONS,
      redirectTo: "/spc",
    })
  } catch (error) {
    if (createdSessionToken) {
      await revokeDatabaseSpcSession(createdSessionToken).catch(() => undefined)
    }
    await clearSpcWhatsappLoginMfaPendingCookie().catch(() => undefined)
    const requestContext = createTrustedRequestContext(request)
    console.error("[spc-login-security]", {
      event: "mfa_verification_unavailable",
      requestId: requestContext.requestId,
      platformRequestId: requestContext.platformRequestId,
      category: error instanceof Error ? error.name : "unknown",
    })
    return unavailableResponse()
  }
}
