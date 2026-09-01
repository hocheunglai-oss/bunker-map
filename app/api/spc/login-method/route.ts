import { NextResponse } from "next/server"
import { beginSpcLoginDiscovery } from "@/lib/spcLoginDiscovery"
import { shouldLogSpcRateLimitCount } from "@/lib/spcLoginSecurity"
import { getSpcLoginMethod } from "@/lib/spcUsers"
import { isSameOriginSpcWhatsappLoginMfaRequest } from "@/lib/spcWhatsappLoginMfa"
import { createTrustedRequestContext } from "@/lib/trustedRequestContext"

const USERNAME_MAX_LENGTH = 320

function response(
  body: Record<string, unknown>,
  status = 200,
  headers?: Record<string, string>,
) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
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

export async function POST(request: Request) {
  if (!isSameOriginSpcWhatsappLoginMfaRequest(request)) {
    return response({ message: "Forbidden" }, 403)
  }

  const payload = await request.json().catch(() => ({})) as { username?: unknown }
  const username = typeof payload.username === "string" ? payload.username.trim() : ""
  if (!username || username.length > USERNAME_MAX_LENGTH) {
    return response({ method: "password" })
  }
  if (process.env.FCUNO_SPC_LOGIN_ENABLED !== "true") {
    return response({ method: "password" })
  }

  const context = createTrustedRequestContext(request)
  const sourceIp = developmentSourceIp(context.sourceIp)
  if (!sourceIp) {
    return response(
      { message: "Sign-in is temporarily unavailable. Please try again." },
      503,
    )
  }

  try {
    const decision = await beginSpcLoginDiscovery({
      username,
      trustedSourceIp: sourceIp,
      requestId: context.requestId,
    })
    if (!decision.allowed) {
      if (shouldLogSpcRateLimitCount(decision.blockedCount)) {
        console.warn("[spc-login-discovery]", {
          event: "rate_limited",
          requestId: context.requestId,
          platformRequestId: context.platformRequestId,
          retryAfterSeconds: decision.retryAfterSeconds,
          blockedCount: decision.blockedCount,
        })
      }
      return response(
        { message: "Too many sign-in attempts. Please try again later." },
        429,
        { "Retry-After": String(decision.retryAfterSeconds) },
      )
    }

    return response({ method: await getSpcLoginMethod(username) })
  } catch (error) {
    console.error("[spc-login-discovery]", {
      requestId: context.requestId,
      platformRequestId: context.platformRequestId,
      error: error instanceof Error ? error.message : "unknown",
    })
    return response(
      { message: "Sign-in is temporarily unavailable. Please try again." },
      503,
    )
  }
}
