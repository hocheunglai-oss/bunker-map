import { clearSpcSession } from "@/lib/spcAuth"
import { spcPrivateJson } from "@/lib/spcResponse"
import {
  cancelCurrentSpcWhatsappLoginMfaChallenge,
  clearSpcWhatsappLoginMfaPendingCookie,
} from "@/lib/spcWhatsappLoginMfa"

export async function POST() {
  await cancelCurrentSpcWhatsappLoginMfaChallenge().catch(async () => {
    await clearSpcWhatsappLoginMfaPendingCookie().catch(() => undefined)
  })
  await clearSpcSession()

  return spcPrivateJson({ success: true })
}
