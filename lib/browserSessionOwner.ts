import "server-only"
import { createHash } from "node:crypto"

/** Display-only cache ownership; never accepted as request authority or a session token. */
export function browserSessionActorKey(scope: "fcuno" | "spc", userId: string | null | undefined): string | null {
  if (!userId) return null
  return createHash("sha256")
    .update(`fcuno-browser-owner/v1\0${scope}\0${userId}`)
    .digest("hex")
}
