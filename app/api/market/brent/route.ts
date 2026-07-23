import { NextResponse } from "next/server"
import { getBrentMarketData } from "@/lib/brentMarketData"

export const dynamic = "force-dynamic"

const CACHE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=0, s-maxage=30, must-revalidate",
  "CDN-Cache-Control": "public, s-maxage=30, must-revalidate",
  "Vercel-CDN-Cache-Control": "public, s-maxage=30, must-revalidate",
  "X-Market-Data-Source": "ICE",
}
export async function GET() {
  try {
    const crude = await getBrentMarketData()
    return NextResponse.json(
      {
        crude,
        disclaimer: "ICE market data delayed by at least 15 minutes.",
      },
      { headers: CACHE_HEADERS },
    )
  } catch (error) {
    console.error("Verified Brent market data unavailable", error)
    return NextResponse.json(
      {
        message:
          "Verified ICE Brent data is temporarily unavailable. Do not use an unverified price.",
      },
      {
        status: 503,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "X-Market-Data-Source": "ICE",
        },
      },
    )
  }
}
