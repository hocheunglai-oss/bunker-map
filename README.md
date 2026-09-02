# Bunker Map

A Next.js app for viewing bunker fuel prices on a map, managing port prices, and generating a Taiwan price report.

## Main Pages

- `/` - bunker map homepage
- `/reports/taiwan` - Taiwan posted price report
- `/admin/pricesetter` - admin page for updating port prices
- `/admin/taiwanremarks` - admin page for Taiwan report remarks

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Start the development server:

```bash
npm run dev
```

3. Open [http://localhost:3000](http://localhost:3000)

## Build

To create a production build:

```bash
npm run build
```

## Environment Variables

Create a `.env.local` file with:

```bash
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

## Tech Stack

- Next.js 16
- React 19
- TypeScript
- Supabase PostgreSQL 17
- Leaflet / React Leaflet
- Azure Automation / Exchange Online
- Google Drive verified database artifacts
- System Health live inventory, Exchange truth, and backup-chain verification

## Exchange Address Book Reliability

FCUNO's Supabase shared-address-book tables are authoritative. Microsoft Exchange is a rebuildable projection and must never be used to overwrite FCUNO. The Azure Automation runbook processes incremental work from the FCUNO webhook and an hourly `:31` HKT schedule, then performs a full exact-match reconciliation daily at `04:10` HKT and on demand. Successful incremental and full runs are silent when they make no Exchange change; a notice is sent only for an actual change or a failure that needs attention.

Every source change is linked through Audit Log, the durable Exchange queue, canonical snapshots, full certifications, and the append-only SHA-256 truth ledger. A full run is trusted only when its source fence is stable, the queue is settled, the Exchange contact/group/membership projection matches exactly, and the resulting certification has projection evidence. Successful notices and verified Drive backups preserve independent hashes outside the production database.

Worker release `fcuno-exchange-runbook/2026-09-02.18` also certifies every managed distribution group's exact lowercase primary SMTP address, retries known temporary Microsoft Exchange server errors three times inside the same reconciliation, and processes each incremental batch in dependency order: contact creates/updates, group reconciliation, then contact deletions. Incremental and full group reconciliation settle each missing external FCUNO member contact and address it by immutable Exchange identity, preventing contact propagation order from producing false missing-recipient failures. An exact-email Exchange contact already marked `FCUNO_SHARED_ADDRESSBOOK` transfers to the current canonical FCUNO source card through an explicit delete, verified absence, and recreation; a managed contact or distribution group whose authoritative Graph profile is invalid follows the same exact, race-checked remove, verified-absence, and recreation path, while unmanaged Exchange recipients remain protected. Bulk contact evidence is reused only for exact no-ops; mutation paths perform fresh targeted ownership reads, and only the exact legacy `ExternalDirectoryObjectId` Graph failure falls back to one unfiltered snapshot and local source/email resolution. Before recreation the worker reads the canonical email or alias first, reads the authoritative source key last, then revalidates the later object's strongest immutable identity, managed marker, source key, and email or alias. This prevents a stale first read, same-name replacement, or concurrent ownership change from authorizing deletion. If Exchange cannot provide both current ownership reads, recreation fails closed instead of trusting stale pre-mutation evidence. If a recipient removal returns the exact legacy Graph error after an authorized operation, the result is treated as ambiguous and recreation proceeds only after independent identity, source-key, and email or alias absence verification; deletion propagation settles through the same bounded checks. If a contact or group creation commits but Exchange fails while serializing that new recipient, the worker recovers only the exact unowned object just requested after two fresh reads prove the same immutable identity, exact directory name, display name, alias, and email address; any mismatch remains untouched and fails closed. Profile verification retries the same GUID or distinguished name through direct identity, tolerates a bounded propagation-time identity miss, and retains the immutable correlation check. Bulk Exchange projection reads receive the same bounded temporary-error retry, buffer each attempt transactionally so partial results from a failed read never escape into certification, and reclaim the failed remoting graph only after leaving its catch scope. Contact and group reconciliation now materialize and release their bulk projections in separate phases; the final authoritative projection is also released before membership certification and the source-fence reread. This bounds Azure Automation memory while preserving independent final snapshots and exact fail-closed certification. A temporary error that clears during those bounded retries stays silent; an unresolved error still fails closed and sends the required warning with its runbook line. Azure Automation variable `EXCHANGE_ADDRESSBOOK_DOMAIN` must be `cosulich1.onmicrosoft.com`; the worker and database certification both fail closed when the address is absent, differs from the FCUNO alias, or uses another domain. Full reconciliations hold a 180-minute mutation lease so a slow Exchange Online command cannot expose a second writer; incremental runs retain the normal 30-minute lease. Projection validation, raw-source capture, the final source-fenced certification, and Outlook-template reconciliation are four separately retryable transactions. The final certification consumes only immutable snapshot hashes and small receipts, so neither derived template work nor two multi-megabyte snapshots can roll back or exhaust the source-of-truth transaction. Outlook Templates resolve managed recipients only from the latest settled certified projection, so stale, missing, or ambiguous recipient evidence cannot be inserted.

Live Azure configuration was verified on 2026-07-23 in Automation Account `fcuno-exchange-sync`: runbook `Sync-FCUno-OutlookAddressBook`; schedules `FCUNO-Exchange-Incremental-Hourly` and `FCUNO-Exchange-Full-Daily-0410`; webhook `FC Uno Exchange Sync`, enabled through 2035-05-29. An on-demand **full** certification must be started in Azure with `WebhookData.syncMode = "full"`; FCUNO's **Sync Exchange** button starts an incremental run only. Recheck Azure before relying on this dated operational record.

## Deployment

This project can be deployed on Vercel. Pushing to the connected GitHub repository will trigger a new deployment.

## Hosted Backups

Vercel runs `/api/backups/bunker-map-drive` daily at `2 19 * * *` UTC, which is 03:02 in Hong Kong. The two-minute offset lets the 03:00 attendance sync finish before the database-wide mutation epoch fences the export; any committed source change during the paged reads still makes the run fail closed and retry from a fresh checkpoint. The route writes the registered sources into a bounded temporary data spool, streams the compact backup-format-v2 artifact directly to Drive, and stream-downloads it again to verify the exact byte length and SHA-256 without holding the full backup in memory. The artifact contains the complete registered Supabase table inventory, Google Contacts, Google Calendar, and the Exchange truth ledger, canonical snapshots, and certifications. Administrators can also use `BACK UP NOW` from System Health.

Each artifact records per-section hashes, an exact-file SHA-256, the deployed commit and migration head, and the immediately preceding verified Drive artifact. The newest two verified artifacts are retained so the latest artifact and its verification predecessor remain available; older verified artifacts are permanently removed only after a new artifact completes every verification. System Health independently downloads and verifies the latest artifact, its immediate predecessor, live database inventory, and Exchange evidence.

This artifact chain complements, but does not replace, an owner-level Supabase managed backup/PITR or `pg_dump` restore. JSON-over-REST restore is deliberately refused because it cannot reproduce database objects, immutable ledger ordering, or sequence state exactly. Uploaded CCINFO file contents are handled separately by the Google Cloud Drive file backup job. See [docs/backup-restore-runbook.md](docs/backup-restore-runbook.md) and [docs/google-cloud-drive-file-backup.md](docs/google-cloud-drive-file-backup.md).

Required production environment variables:

```bash
CRON_SECRET=your_cron_secret
GOOGLE_OAUTH_CLIENT_ID=your_google_oauth_client_id
GOOGLE_OAUTH_CLIENT_SECRET=your_google_oauth_client_secret
GOOGLE_DRIVE_REFRESH_TOKEN=your_google_drive_refresh_token
GOOGLE_DRIVE_COMPANY_FOLDER_ID=your_google_drive_folder_id
# Optional override:
GOOGLE_DRIVE_BACKUP_FOLDER_ID=your_backup_root_folder_id
GOOGLE_DRIVE_SHARED_DRIVE_ID=your_shared_drive_id
```

## System Health Alerts

Vercel runs `/api/admin/system-health/notify` daily at `30 0 * * *` UTC, which is 08:30 in Hong Kong. It sends an email only when the System Health status is `warning` or `error`.

Recipients come from `SYSTEM_HEALTH_EMAIL_RECIPIENTS`; if that is not set, the app falls back to `EVENT_CALENDAR_EMAIL_RECIPIENTS`.

Email notices are sent through the Exchange Online mailbox `info@cosulich.com.hk`. The app defaults to Microsoft 365 SMTP submission at `smtp.office365.com:587`; production only needs the mailbox password configured unless the mailbox username or SMTP endpoint differs.

```bash
EXCHANGE_SMTP_PASSWORD=your_exchange_mailbox_or_app_password
# Optional overrides:
EMAIL_NOTICE_FROM="FC Uno <info@cosulich.com.hk>"
EXCHANGE_SMTP_USER=info@cosulich.com.hk
EXCHANGE_SMTP_HOST=smtp.office365.com
EXCHANGE_SMTP_PORT=587
```

Before relying on production, run:

```bash
npm run release:check
```

The live app exposes `/api/deploy-info` so the deployed commit can be compared
with `git rev-parse origin/main`.
