import { NextResponse } from "next/server"
import { clearSpcSession } from "@/lib/spcAuth"

export async function POST() {
  await clearSpcSession()

  return NextResponse.json({ success: true })
}
