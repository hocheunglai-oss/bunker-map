import { getRefreshedSpcSession } from "@/lib/spcAuth"
import { SPC_PAGE_DEFINITIONS } from "@/lib/spcPages"
import { spcPrivateJson } from "@/lib/spcResponse"

export async function GET() {
  const session = await getRefreshedSpcSession()

  return spcPrivateJson({
    authenticated: session.authenticated,
    username: session.username,
    displayName: session.displayName,
    role: session.role,
    office: session.office,
    mustChangePassword: session.mustChangePassword,
    permissions: session.permissions,
    pages: session.authenticated ? SPC_PAGE_DEFINITIONS : [],
  })
}
