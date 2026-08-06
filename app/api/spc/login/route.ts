import { NextResponse } from "next/server"
import {
  clearSpcSession,
  setSpcSession,
  validateSpcCredentials,
} from "@/lib/spcAuth"
import {
  beginSpcLoginAttempt,
  cancelSpcLoginAttempt,
  completeSpcLoginAttempt,
  hashSpcLoginUsername,
  type SpcLoginCancellationReason,
} from "@/lib/spcLoginSecurity"
import { SPC_PAGE_DEFINITIONS } from "@/lib/spcPages"
import { createTrustedRequestContext } from "@/lib/trustedRequestContext"

const SPC_LOGIN_USERNAME_MAX_LENGTH = 320
const SPC_LOGIN_PASSWORD_MAX_LENGTH = 256

function loginResponse(
  body: Record<string, unknown>,
  status: number,
  headers?: Record<string, string>,
) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      ...headers,
    },
  })
}

function developmentSourceIp(sourceIp: string | null) {
  if (sourceIp) return sourceIp
  if (process.env.NODE_ENV === "development" && process.env.VERCEL !== "1") {
    return "127.0.0.1"
  }
  return null
}

type LoginSecurityLogDetails = {
  requestId: string
  platformRequestId: string | null
  retryAfterSeconds?: number
  blockedCount?: string
  error?: unknown
}

function logLoginSecurityEvent(event: string, details: LoginSecurityLogDetails) {
  const payload = {
    event,
    requestId: details.requestId,
    platformRequestId: details.platformRequestId,
    retryAfterSeconds: details.retryAfterSeconds,
    blockedCount: details.blockedCount,
    error:
      details.error instanceof Error
        ? details.error.message
        : details.error
          ? "unknown"
          : undefined,
  }

  if (event.endsWith("unavailable")) {
    console.error("[spc-login-security]", payload)
  } else if (event === "rate_limited" || event === "credentials_rejected") {
    console.warn("[spc-login-security]", payload)
  } else {
    console.info("[spc-login-security]", payload)
  }
}

async function bestEffortCancelSpcLoginAttempt(
  attemptId: string,
  reason: SpcLoginCancellationReason,
  logDetails: LoginSecurityLogDetails,
) {
  try {
    await cancelSpcLoginAttempt({ attemptId, reason })
  } catch (error) {
    logLoginSecurityEvent("attempt_cancellation_unavailable", {
      ...logDetails,
      error,
    })
  }
}

export async function POST(request: Request) {
  const requestContext = createTrustedRequestContext(request)
  const sourceIp = developmentSourceIp(requestContext.sourceIp)
  const payload = await request.json().catch(() => ({})) as {
    username?: unknown
    password?: unknown
  }
  const username = typeof payload.username === "string" ? payload.username : ""
  const password = typeof payload.password === "string" ? payload.password : ""
  const limitedUsername = username.slice(0, SPC_LOGIN_USERNAME_MAX_LENGTH)
  const usernameHash = hashSpcLoginUsername(limitedUsername)
  const logDetails = {
    requestId: requestContext.requestId,
    platformRequestId: requestContext.platformRequestId,
    sourceIp,
    usernameHash,
  }

  if (!sourceIp) {
    logLoginSecurityEvent("rate_limit_unavailable", logDetails)
    return loginResponse(
      { success: false, message: "Sign-in is temporarily unavailable. Please try again." },
      503,
    )
  }

  let attempt
  try {
    attempt = await beginSpcLoginAttempt({
      username: limitedUsername,
      trustedSourceIp: sourceIp,
      requestId: requestContext.requestId,
    })
  } catch (error) {
    logLoginSecurityEvent("rate_limit_unavailable", { ...logDetails, error })
    return loginResponse(
      { success: false, message: "Sign-in is temporarily unavailable. Please try again." },
      503,
    )
  }

  if (!attempt.allowed) {
    if (attempt.shouldLogRateLimit) {
      logLoginSecurityEvent("rate_limited", {
        ...logDetails,
        retryAfterSeconds: attempt.retryAfterSeconds,
        blockedCount: attempt.blockedCount,
      })
    }
    return loginResponse(
      { success: false, message: "Too many sign-in attempts. Please try again later." },
      429,
      { "Retry-After": String(attempt.retryAfterSeconds) },
    )
  }

  let user = null

  try {
    if (
      username.length <= SPC_LOGIN_USERNAME_MAX_LENGTH &&
      password.length <= SPC_LOGIN_PASSWORD_MAX_LENGTH
    ) {
      user = await validateSpcCredentials(username, password)
    }
  } catch (error) {
    await bestEffortCancelSpcLoginAttempt(
      attempt.attemptId,
      "authentication_unavailable",
      logDetails,
    )
    logLoginSecurityEvent("authentication_unavailable", { ...logDetails, error })
    return loginResponse(
      { success: false, message: "Sign-in is temporarily unavailable. Please try again." },
      503,
    )
  }

  if (!user) {
    try {
      await completeSpcLoginAttempt({
        attemptId: attempt.attemptId,
        succeeded: false,
      })
    } catch (error) {
      await bestEffortCancelSpcLoginAttempt(
        attempt.attemptId,
        "attempt_monitoring_unavailable",
        logDetails,
      )
      logLoginSecurityEvent("attempt_monitoring_unavailable", {
        ...logDetails,
        error,
      })
      return loginResponse(
        { success: false, message: "Sign-in is temporarily unavailable. Please try again." },
        503,
      )
    }

    logLoginSecurityEvent("credentials_rejected", logDetails)
    return loginResponse(
      { success: false, message: "Invalid username or password." },
      401,
    )
  }

  try {
    await setSpcSession(user)
  } catch (error) {
    await clearSpcSession().catch(() => undefined)
    await bestEffortCancelSpcLoginAttempt(
      attempt.attemptId,
      "session_unavailable",
      logDetails,
    )
    logLoginSecurityEvent("authentication_unavailable", { ...logDetails, error })
    return loginResponse(
      { success: false, message: "Sign-in is temporarily unavailable. Please try again." },
      503,
    )
  }

  try {
    await completeSpcLoginAttempt({
      attemptId: attempt.attemptId,
      succeeded: true,
    })
  } catch (error) {
    await clearSpcSession().catch(() => undefined)
    await bestEffortCancelSpcLoginAttempt(
      attempt.attemptId,
      "attempt_monitoring_unavailable",
      logDetails,
    )
    logLoginSecurityEvent("attempt_monitoring_unavailable", {
      ...logDetails,
      error,
    })
    return loginResponse(
      { success: false, message: "Sign-in is temporarily unavailable. Please try again." },
      503,
    )
  }

  logLoginSecurityEvent("authenticated", logDetails)

  return loginResponse(
    {
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
    },
    200,
  )
}
