import { NextResponse } from "next/server"
import {
  getHomepageMarketData,
  publicMarketCacheHeaders,
} from "@/lib/publicMarketData"

export const revalidate = 120

export async function GET() {
  try {
    return NextResponse.json(await getHomepageMarketData(), {
      headers: publicMarketCacheHeaders(),
    })
  } catch (error) {
    console.error("Homepage data load failed", error)
    return NextResponse.json({ message: "Unable to load homepage data." }, { status: 502, headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
      Pragma: "no-cache",
    } })
  }
}
