# System Health alert policy and release checklist

## Release status — 23 September 2026

Application alert policy implemented and tested locally; production activation
is pending the coordinated release checklist below. The Cloud Run runner has
been deployed and its scheduler is enabled for 02:00–05:00 Hong Kong time.
The recovery execution and application rollout must be verified separately;
accepting a deployment or execution request is not evidence of backup completion.

Local validation: application production build, TypeScript, targeted ESLint,
health policy tests, incremental runner/lease tests, notification delivery tests,
and isolated PostgreSQL migration tests pass. The build's data-fetch warnings
reflect the migrated local `redacted` API keys, so it is not a live-service test.

Google Cloud, Supabase and GitHub targets have been verified. The Vercel connector
does not expose the FCUNO project, so the verified GitHub integration and signed-in
Vercel project dashboard provide the release path. Existing cloud credentials,
bucket, versioning and retention are preserved. No notification smoke-test email
has been sent.

## User-facing behaviour

- File backups run daily at 02:00 Hong Kong time, with retries at 03:00,
  04:00 and 05:00. No scheduled file-backup work continues after 06:00.
- The existing System Health email check stays at 08:30 Hong Kong time.
- New or changed uploads are pending until the first 02:00 snapshot after
  their change has had its full retry window. Pending files remain visible
  on the dashboard but do not trigger email.
- A missed deadline, unverified completion or missing eligible file triggers
  one actionable notice. A new retry window does not hide an older incident.
- No verified successful backup for 48 hours escalates the same incident once.
- Identical unresolved incidents do not produce daily reminders. A verified
  recovery re-arms notification if the problem later returns. Unknown or
  in-progress checks do not count as recovery.
- Each email recipient has independent persistent notification state. A
  rejected mailbox can retry without emailing successful recipients again.
- Emails contain the issue, affected file names, last success and next action;
  the dashboard retains technical details. Existing attendance/schema and
  database-backup-warning email exclusions remain unchanged.

The two verified database-backup retention setting is unchanged. File-content
backups remain incremental. This change neither deletes backup files nor
upgrades any service plan.

## Notification storage

`private.system_health_alert_incidents` stores operational deduplication state,
not business records. It has RLS, no browser-role access, and narrow invoker
RPCs restricted to `service_role`. Recipient addresses are represented by
SHA-256 keys. It is intentionally outside the public business-data backup
inventory and its mutation fence; restoring a database without these rows may
produce one fresh notice for an existing incident.

Claims are serialized, leased for ten minutes, and acknowledged after SMTP
acceptance. Failed sends release their claim. A crash after SMTP acceptance but
before database acknowledgement can produce a later duplicate: SMTP has no
transactional idempotency guarantee. If the deduplication store is unavailable,
the endpoint returns an error rather than falling back to uncontrolled emails.

## Coordinated release (do not deploy the application alone)

1. Verify the FCUNO GitHub/Vercel/Supabase targets against
   `config/fcunoConnections.ts`. Verify the existing Google Cloud backup account,
   project, bucket, job, scheduler and service account independently. Do not
   substitute another project's credentials or migrated `redacted` values.
2. Inspect actual Cloud Run executions and the latest successful GCS and Drive
   manifests. Check the file reported missing from the September 17 upload explicitly.
   The old September 16 Drive manifest by itself does not prove GCS data loss.
3. Deploy the runner and the 02:00–06:00 schedule following
   `google-cloud-drive-file-backup.md`, preserving the existing bucket/prefix
   and secrets. Explicit manual recovery must finish and publish verified
   evidence before the new daily health policy is promoted.
4. Apply `20260923110417_system_health_alert_incidents.sql` to the FCUNO
   Supabase project. Verify service-role execution, browser-role denial and
   that `get_bunker_map_backup_inventory()` has no new public/unregistered
   table. Run database advisors. Do not apply this migration to FCOS.
5. Deploy an application preview and verify health responses. Promote only
   after the runner schedule, successful backup evidence and alert RPCs are
   verified. Keep the existing 08:30 health cron and database-backup cron slots.
6. Verify production with a read-only System Health request first. Do not
   trigger the email endpoint as a smoke test: it sends real email and claims
   real incidents. Check the next scheduled notification and backup execution.

## Verification commands

```sh
node --import tsx --test tests/drive-file-backup-health.test.ts tests/system-health-alerts.test.ts tests/system-health-backup-window.test.ts
node --test tests/drive-file-backup-runner.test.mjs
node --test tests/system-health-alerts-sql.test.mjs
bash -n scripts/deploy-google-cloud-drive-backup.sh
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/next/dist/bin/next build --webpack
```

The SQL integration test uses an isolated in-memory PGlite PostgreSQL instance.
Set `PGLITE_MODULE_PATH` to an installed PGlite entry point if it is not on the
module path. This optional test dependency is not shipped with the application;
without it the SQL test explicitly skips. Unit tests use no production secrets.
