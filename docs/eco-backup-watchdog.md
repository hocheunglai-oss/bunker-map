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
received. Validate failure-email behavior with isolated fixtures, then verify
scheduled execution without sending test, success or advisory messages. A real
backup failure remains the trigger for email.

## Evidence and notices

- The owner's 4 November 2026 preference is **failure-only email**. Only the
  `eco-nightly-backup` check can send a notice. Successful checks and recovery,
  storage/retention advice and unverified-monitor warnings remain silent.
  Their truthful health status and incident observations are retained.
- A failed, cancelled or timed-out run remains a visible warning but can recover
  quietly within 90 minutes of the earliest unresolved run's **original GitHub
  creation time**, while the previous verified capture is less than 30 hours old.
  This is a fixed window from run creation, not another 90 minutes after failure
  or after the monitor first notices it. A retry or a new failed run cannot reset
  the deadline. An active retry that passes the same deadline also alerts.
- Skipped captures, disabled workflows, no verified prior capture and the
  30-hour freshness deadline bypass that window. A known verified run at least
  48 hours old raises the health status to an error. The first scheduled monitor
  check after a deadline can send an alert. The monitor only observes backup runs.
- The recovery window requires complete inspected evidence for the unresolved
  completed runs after the latest verified capture. If the bounded inspection
  budget leaves any such run uninspected, no failure is suppressed. Missing,
  invalid or future original timestamps cannot start a new window.
- Missing verified-run success becomes overdue after 30 hours. This allows the
  observed several-hour GitHub scheduling delays.
- A successful workflow is insufficient: the exact job and capture step in its
  current attempt must also finish successfully. Skipped guarded jobs cannot
  falsely report success. A later unsuccessful run takes precedence over an
  earlier success; an incomplete run does not clear an existing incident.
- API failures, rate limits, incomplete evidence and identity mismatches produce
  a separate unverified-monitor warning without email. They do not mark a backup
  failed or recovered. No retries or writes are sent to GitHub.
- The existing service-only incident store deduplicates by stable check ID and
  recipient, independently of GitHub run IDs. One email is sent per unresolved
  outage, including when its health status later becomes an error. Verified
  recovery re-arms alerts for a later outage. Failed SMTP acceptance releases
  the lease for retry. Missing incident storage prevents delivery.
  A recovery-window observation has a null incident level: it neither sends an
  email nor closes an existing incident. Only verified recovery closes it,
  silently; there are no success or recovery emails.

At most twenty runs are read. Job details are inspected for the latest completed
run, up to three successful runs and up to three failed runs. Each HTTP request has an eight-second timeout, a one-megabyte
body limit, no credentials, and redirects disabled. The route's runtime is
bounded at 45 seconds. If the bounded history cannot establish a success, the
monitor does not invent one. Successful capture and workflow evidence are required;
the sole exception is the pinned post-verification capacity warning described below.
Other failures after capture remain conservatively reported.

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
succeeds, the monitor retains the verified-copy result and reports a passive
`eco-backup-capacity` warning. It does not email that advisory or open a new
notification incident. Public metadata reveals no storage usage, file names,
account identifiers or backup contents.

Another failed step, an unsuccessful capture, duplicate evidence or inconsistent
timestamps cannot be reclassified as capacity-only attention. Missing evidence
preserves any existing storage incident; only an explicit successful maintenance
step on a verified run clears it. The original 30-hour backup deadline and
48-hour health severity threshold continue independently. Older workflow
versions can prove capture. Maintenance recovery requires its own successful step.

Up to three earlier overall-failure runs are inspected alongside the successful
run candidates: a capacity-only warning must remain valid capture history after
a newer genuine backup failure. This avoids overstating the age of the last
verified copy when calculating how overdue the backup is.
