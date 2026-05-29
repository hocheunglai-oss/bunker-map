import { NextResponse } from "next/server"

export function GET(request: Request) {
  return NextResponse.redirect(new URL("/api/outlook-addin/taskpane", request.url), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  })
}
