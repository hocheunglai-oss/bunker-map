export function hasSpcSecurityMaintenanceAccess(
  request: Request,
  secret = process.env.CRON_SECRET,
) {
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  )
}
