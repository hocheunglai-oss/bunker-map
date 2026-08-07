import { getSpcSession } from "@/lib/spcAuth"
import { SPC_PAGE_DEFINITIONS } from "@/lib/spcPages"
import { spcPrivateJson } from "@/lib/spcResponse"

export async function GET() {
  const session = await getSpcSession()

  return spcPrivateJson({
    ...session,
    pages: session.authenticated ? SPC_PAGE_DEFINITIONS : [],
  })
}
