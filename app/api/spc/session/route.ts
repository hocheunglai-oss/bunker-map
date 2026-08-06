import { NextResponse } from "next/server"
import { getSpcSession } from "@/lib/spcAuth"
import { SPC_PAGE_DEFINITIONS } from "@/lib/spcPages"

export async function GET() {
  const session = await getSpcSession()

  return NextResponse.json({
    ...session,
    pages: session.authenticated ? SPC_PAGE_DEFINITIONS : [],
  })
}
