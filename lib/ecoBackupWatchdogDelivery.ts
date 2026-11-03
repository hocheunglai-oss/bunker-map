import "server-only"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { deliverHealthAlerts, type HealthAlertStore } from "@/lib/systemHealthAlerts"
import { buildEcoBackupAlertHtml, evaluateEcoBackup, unknownEcoBackupChecks, type BackupObservation } from "@/lib/ecoBackupWatchdog"

type Dependencies = {
  environment: string | undefined
  enabled: string | undefined
  cronSecret: string | undefined
  recipient: string | undefined
  read: () => Promise<BackupObservation>
  store: (recipient: string) => HealthAlertStore
  send: (message: { to: string[]; subject: string; html: string }) => Promise<{
    accepted: Array<string | { address: string }>
    rejected: Array<string | { address: string }>
  }>
  now?: () => number
}

export async function handleEcoBackupWatchdog(request: Request, dependencies: Dependencies): Promise<Response> {
  const expected = dependencies.cronSecret ? `Bearer ${dependencies.cronSecret}` : ""
  const authorization = request.headers.get("authorization") ?? ""
  if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(authorization) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(authorization))) {
    return Response.json({ message: "Unauthorized" }, { status: 401 })
  }
  if (dependencies.environment !== "production") return Response.json({ message: "Production only" }, { status: 403 })
  if (dependencies.enabled !== "true") return Response.json({ enabled: false })
  const recipient = dependencies.recipient?.trim().toLowerCase() ?? ""
  // Recipient comes exclusively from private server configuration. Request
  // query/body fields cannot choose a mailbox or supply message content.
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(recipient)) {
    return Response.json({ message: "Backup alert recipient is not configured" }, { status: 503 })
  }
  let verified = true
  let checks
  try {
    checks = evaluateEcoBackup(await dependencies.read())
  } catch {
    verified = false
    checks = unknownEcoBackupChecks(dependencies.now?.() ?? Date.now())
  }
  try {
    const notices = await deliverHealthAlerts({
      checks, muted: () => false, token: randomUUID(), store: dependencies.store(recipient),
      async send(claimed) {
        const result = await dependencies.send({ to: [recipient], subject: "ECO BACKUP NEEDS ATTENTION",
          html: buildEcoBackupAlertHtml(claimed, checks[0].checkedAt) })
        const address = (email: string | { address: string }) => (typeof email === "string" ? email : email.address).toLowerCase()
        if (!result.accepted.some((email) => address(email) === recipient) ||
            result.rejected.some((email) => address(email) === recipient)) {
          throw new Error("Alert recipient was not accepted")
        }
      },
    })
    return Response.json({ verified, sent: notices.length > 0, checks: checks.map(({ id, status }) => ({ id, status })) },
      { status: verified ? 200 : 502, headers: { "Cache-Control": "no-store" } })
  } catch {
    // No unclaimed fallback email: fail closed if persistent deduplication or
    // mail delivery is unavailable, without exposing provider diagnostics.
    return Response.json({ message: "Backup alert delivery could not be verified" }, { status: 503 })
  }
}
