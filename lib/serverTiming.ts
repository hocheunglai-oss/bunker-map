import { NextResponse } from "next/server"

export function timedJson(
  route: string,
  startedAt: number,
  payload: unknown,
  init?: ResponseInit,
  details: Record<string, string | number | boolean | null> = {},
) {
  const durationMs = Date.now() - startedAt
  console.log(JSON.stringify({
    level: "info",
    message: "request_complete",
    route,
    durationMs,
    ...details,
  }))

  const response = NextResponse.json(payload, init)
  response.headers.set("Server-Timing", `total;dur=${durationMs}`)
  return response
}
