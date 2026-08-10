import { spcPrivateJson } from "@/lib/spcResponse"
import {
  cancelCurrentSpcWhatsappLoginMfaChallenge,
  isSameOriginSpcWhatsappLoginMfaRequest,
} from "@/lib/spcWhatsappLoginMfa"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request) {
  if (!isSameOriginSpcWhatsappLoginMfaRequest(request)) {
    return spcPrivateJson({ success: false, message: "Forbidden" }, { status: 403 })
  }

  try {
    await cancelCurrentSpcWhatsappLoginMfaChallenge()
    return spcPrivateJson({ success: true })
  } catch {
    return spcPrivateJson(
      { success: false, message: "Sign-in is temporarily unavailable. Please try again." },
      { status: 503 },
    )
  }
}
