import { randomUUID } from "node:crypto"
import { isIP } from "node:net"

export type TrustedRequestContext = {
  sourceIp: string | null
  correlationId: string
  requestId: string
  platformRequestId: string | null
}

type TrustedRequestRuntime = {
  nodeEnv?: string
  vercel?: string
}

type TrustedRequestContextOptions = {
  runtime?: TrustedRequestRuntime
  createId?: () => string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VERCEL_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/

function isTrustedVercelRuntime(runtime: TrustedRequestRuntime) {
  return runtime.nodeEnv === "production" && runtime.vercel === "1"
}

function validatedIp(value: string | null) {
  const candidate = value?.trim() || ""
  return candidate && isIP(candidate) !== 0 ? candidate : null
}

function trustedSourceIp(request: Request | undefined, runtime: TrustedRequestRuntime) {
  if (!request || !isTrustedVercelRuntime(runtime)) return null

  return (
    validatedIp(request.headers.get("x-vercel-forwarded-for")) ||
    validatedIp(request.headers.get("x-forwarded-for"))
  )
}

function trustedPlatformRequestId(
  request: Request | undefined,
  runtime: TrustedRequestRuntime,
) {
  if (!request || !isTrustedVercelRuntime(runtime)) return null
  const value = request.headers.get("x-vercel-id")?.trim() || ""
  return VERCEL_REQUEST_ID_PATTERN.test(value) ? value : null
}

export function createTrustedRequestContext(
  request: Request | undefined,
  options: TrustedRequestContextOptions = {},
): TrustedRequestContext {
  const runtime = options.runtime || {
    nodeEnv: process.env.NODE_ENV,
    vercel: process.env.VERCEL,
  }
  const requestId = (options.createId || randomUUID)()
  if (!UUID_PATTERN.test(requestId)) {
    throw new Error("Trusted request ID generator returned an invalid UUID.")
  }

  return {
    sourceIp: trustedSourceIp(request, runtime),
    correlationId: requestId,
    requestId,
    platformRequestId: trustedPlatformRequestId(request, runtime),
  }
}
