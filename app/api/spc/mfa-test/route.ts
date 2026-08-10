import { requireSpcAdminPagePermission } from "@/lib/spcAuth"
import {
  getActiveSpcMfaTestChallenge,
  isSpcMfaTestConfigured,
  listSpcMfaTestTargets,
} from "@/lib/spcMfaTest"
import { spcPrivateJson } from "@/lib/spcResponse"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : ""
  const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 503
  return spcPrivateJson(
    { message: status === 503 ? "The WhatsApp MFA test is temporarily unavailable." : message },
    { status },
  )
}

export async function GET() {
  try {
    const session = await requireSpcAdminPagePermission("spc-mfa-test", "edit")
    if (!session.userId) throw new Error("Unauthorized")

    const [targets, activeChallenge] = await Promise.all([
      listSpcMfaTestTargets(),
      getActiveSpcMfaTestChallenge(session.userId),
    ])

    return spcPrivateJson({
      configured: isSpcMfaTestConfigured(),
      targets: targets.map((target) => ({
        id: target.id,
        username: target.username,
        displayName: target.displayName,
        phoneHint: target.phoneHint,
        ready: target.ready,
      })),
      activeChallenge,
      scope: "ADMIN-ONLY TEST; SPC LOGIN IS UNCHANGED",
    })
  } catch (error) {
    return errorResponse(error)
  }
}
