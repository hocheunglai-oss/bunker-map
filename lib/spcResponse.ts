import { NextResponse } from "next/server"

export const SPC_PRIVATE_NO_STORE = "private, no-store"

export function spcPrivateJson(payload: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("Cache-Control", SPC_PRIVATE_NO_STORE)
  return NextResponse.json(payload, { ...init, headers })
}
