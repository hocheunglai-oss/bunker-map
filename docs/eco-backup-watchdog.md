# ECO backup watchdog

This small FCUNO-owned monitor uses FCUNO's existing notice-email sender and
private incident store. It reads only public GitHub metadata for the exact ECO
backup repository, workflow, branch, job and capture step pinned in
`config/fcunoConnections.ts`. It does not read ECO documents, logs, artifacts,
credentials or database contents. It does not change the identity federation.

## Activation

The route is `/api/cron/eco-backup-watchdog`, scheduled at minutes 07 and 37 each
hour using the existing Vercel Pro plan. The existing full FCUNO health check
remains at 08:30 Hong Kong time; this monitor does not rerun its archive scans.
Usual Vercel Function usage applies; no new service account or paid plan is needed.

Only the existing `CRON_SECRET` can authorize the route. It refuses execution
outside Vercel production. It also requires `ECO_BACKUP_WATCHDOG_ENABLED=true`
and a single private `ECO_BACKUP_ALERT_RECIPIENT` selected by the owner. Neither
recipient nor message can be supplied by an HTTP caller. Preview and initial
deployment are inert until explicitly enabled. Do not place a mailbox address
or SMTP password in source control or copy FCUNO credentials to ECO.

Before enabling, verify the pinned FCUNO Vercel/Supabase targets, production
sender configuration, and existing `private.system_health_alert_incidents`,
`claim_system_health_alerts(jsonb,uuid,text)` and
`finish_system_health_alerts(uuid,boolean)`. These were verified present on
3 November 2026; no migration is needed. Today's existing scheduled FCUNO
notifier returned HTTP 200, but that alone does not prove an email was sent or
received. Verify one controlled message and subsequent scheduled execution.

## Evidence and notices

- Confirmed unsuccessful runs, skipped captures, disabled workflows and runs
  that have not completed within 90 minutes are reported.
- Missing verified-run success becomes overdue after 30 hours. This allows the observed
  several-hour GitHub scheduling delays. A known verified run older than
  48 hours escalates an incident once.
- A successful workflow is insufficient: the exact job and capture step in its
  current attempt must also finish successfully. Skipped guarded jobs cannot
  falsely report success. A later unsuccessful run takes precedence over an
  earlier success; an incomplete run does not clear an existing incident.
- API failures, rate limits, incomplete evidence and identity mismatches produce
  a separate unverified-monitor warning. They do not mark a backup failed or
  recovered. No retries or writes are sent to GitHub.
- The existing service-only incident store deduplicates by stable check ID and
  recipient, independently of GitHub run IDs. Identical unresolved incidents
  are quiet; escalation is delivered once and verified recovery re-arms a later
  failure. Failed SMTP acceptance releases the lease for retry. Missing incident
  storage fails closed rather than sending uncontrolled repeated emails.

At most twenty runs and the latest completed job plus three candidate successful
runs are inspected. Each HTTP request has an eight-second timeout, a one-megabyte
body limit, no credentials, and redirects disabled. The route's runtime is
bounded at 45 seconds. If the bounded history cannot establish a success, the
monitor does not invent one. Both backup capture and whole-workflow success are
required, so a failure after capture is conservatively reported.

This proves workflow/capture completion, not archive restorability, destination
availability or the exact timestamp of a reused daily archive. ECO's own backup
checks and real restoration exercises remain necessary. This scheduler is
independent of GitHub and ECO deployment, but depends on FCUNO/Vercel, FCUNO's
incident database, Microsoft 365 and GitHub's public API. It cannot self-notify
while all of those delivery dependencies are unavailable.

The SMTP helper currently uses Microsoft 365 username/password submission.
Microsoft's published plan disables Basic SMTP AUTH by default in December
2026 for existing tenants, while allowing administrators to re-enable it.
Plan a separately verified OAuth migration of FCUNO's existing sender; this
monitor neither broadens mailbox permissions nor changes existing email flows.

## Verification

Run `NODE_OPTIONS=--conditions=react-server npx --no-install tsx --test
tests/eco-backup-watchdog.test.ts tests/system-health-alerts.test.ts` and the
existing incident-store PostgreSQL integration tests. Run TypeScript, the
production build and the repository's security/release gates. CI includes the
focused watchdog tests and retains their evidence. No site layout is changed.

The canonical list accepts exactly the current Drive-only capture name and the
reviewed two-destination name, `Capture, encrypt and verify configured backup
copies`. One matching successful step is required; two matching steps are
ambiguous and rejected. If ECO changes workflow/job identity or the capture
contract again, update the canonical configuration and tests as part of that
release. Do not silently accept a different step or conclude that an unverified
backup is healthy.

Official references: [Vercel cron usage](https://vercel.com/docs/cron-jobs/usage-and-pricing),
[GitHub workflow runs](https://docs.github.com/en/rest/actions/workflow-runs),
[Microsoft SMTP timeline](https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835).

## Storage capacity and retention warnings

The reviewed post-verification step is `Check verified backup capacity`, pinned
in `config/fcunoConnections.ts`. If that step alone fails after the capture step
succeeds, the monitor retains the verified-copy result and opens a separate
`eco-backup-capacity` incident. Its email explicitly says that the copies passed
verification but capacity or retention needs attention. Public metadata reveals
no storage usage, file names, account identifiers or backup contents.

Another failed step, an unsuccessful capture, duplicate evidence or inconsistent
timestamps cannot be reclassified as capacity-only attention. Missing evidence
preserves any existing storage incident; only an explicit successful maintenance
step on a verified run clears it. The original 30-hour backup deadline and
48-hour escalation continue independently. Old workflow versions without the
new step remain valid capture evidence but cannot prove maintenance recovery.

Up to three earlier overall-failure runs are inspected alongside the successful
run candidates: a capacity-only warning must remain valid capture history after
a newer genuine backup failure. This avoids overstating the age of the last
verified copy when calculating the missed-backup escalation.
