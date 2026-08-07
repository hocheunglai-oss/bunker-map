import { clearSpcSession } from "@/lib/spcAuth"
import { spcPrivateJson } from "@/lib/spcResponse"

export async function POST() {
  await clearSpcSession()

  return spcPrivateJson({ success: true })
}
