# System Health backup alert policy

## October 15 correction and verification scope

This document describes the October 15 correction. Activation requires the
coordinated migration, application gates and exact-deployment release checks
below; this source document alone does not certify production activation.
No notification endpoint was called and no smoke-test email was sent during
development or verification.

Previously, database-backup warnings were permanently muted, and capacity
advice shared a delivery incident with missing-file protection. The correction
removes those blind spots without restoring repetitive daily emails.

## Deadlines and notifications

- Database attempts remain at 03:02, 04:02 and 05:02 HKT. The existing six-hour
  receipt-reuse rule is honored: a valid manual receipt created at or after
  23:02 the preceding evening can cover all three attempts. Do not require
  every morning receipt to have started after 03:02.
- File snapshots remain at 02:00, with attempts at 03:00/04:00/05:00 and a hard
  06:00 execution cutoff. A changed file waits for its first eligible02:00
  snapshot. Both policies allow 15 minutes for publication/read visibility,
  assessing closed overnight obligations at 06:15.
- The email check stays at 08:30. Mature missing/stale protection sends one
  warning. Database availability escalates once after 48 hours without a
  trusted receipt or after an established missing deadline remains unresolved
  for 48 hours. An individual missing file escalates48 hours after its own
  first due deadline even if other files keep backing up successfully.
- Confirmed checksum/chain failure or invalid database inventory is actionable
  immediately. A read failure/timeout is unknown, not proof of corruption,
  data loss or recovery. Unknown results preserve clocks and incidents and do
  not send a new backup-failure email.
- A sufficient verified backup is not invalidated by later unverified
  leftovers or a failed manual attempt. Supported completed v2 manifests can
  prove an individual file generation even if another file failed; global
  scheduled recovery still requires a fully verified manifest.
- Estimated free-allowance usage at 80% and storage-region advice stay visible
  on the dashboard only. They cannot claim/escalate a protection incident or
  prevent verified protection recovery. Source-byte estimates are not total
  billable bucket usage or a spending cap.

## Durable clocks and proof-aware recovery

Only notification supplies the durable, state-writing observer to
`getSystemHealth`. Authenticated dashboard GETs supply a separate read-only
`preview_backup_protection_gaps` callback. It projects the same current evidence
onto the stored pinned requirements and proof-aware clocks without writing,
locking or materializing notification state. An overdue incident therefore does
not misleadingly become "waiting for tomorrow" on the dashboard, and genuine
intervening coverage can project a new edit as pending without mutating clocks.
Existing authorization and the 60-second health cache remain. Preview failure
returns an explicit unavailable error, not a cached healthy result. Raw gap
arrays, Drive IDs and internal target fingerprints are not returned in public
health responses or email.

Private operational tables serialize the `database`/`drive-file` domains and
store sparse pending/uncovered keys, not all healthy files. File IDs are
SHA-256 hashed. The service-only invoker RPC accepts at most 10,000 unique
gaps. These private tables are outside the public business-backup inventory
and mutation fence.

- Non-inventory gaps pin FIRST `requiredSinceAt` and first due time: actual file
  change, missing file-cycle snapshot, or database earliest reusable receipt.
  Repeated edits without intervening coverage cannot postpone an overdue gap.
- Trusted coverage reaching that pinned requirement retires the old version
  and pins the current change's fresh deadline. Late publication is supported:
  observation time is not misused as the original content-change time.
- Schema gaps pin their FIRST required migration head/catalog fingerprint.
  Their initial deadline is the next06:15 after first durable detection,
  never a guessed migration application time. Later uncovered deployments
  cannot postpone it. Verified coverage of that pinned target permits fresh
  grace for a genuinely new target. Fresh old/wrong-catalog artifacts cannot
  reset it; a future/restored head ahead of the current required head cannot
  reset it either.
- Complete authoritative coverage removes absent keys. Unknown/incomplete
  results never remove them. Older/equal observations cannot overwrite newer
  state. Storage failure/stale acknowledgement aborts notification before
  email claims or delivery.

These are first-detection clocks, not proof of exact historical failure or
migration application times. Once-daily notification means a schema change
first detected at 08:30 may receive an additional overnight cycle.
Persistent inability to read backup evidence has no independent escalation
condition in this correction and remains an explicit monitoring follow-up.

## Delivery and minimalist email

Database protection retains incident ID `backup`. The file dashboard retains
`drive-file-content-backup`, but both observation and delivery map it to NEW
`drive-file-content-protection`. Legacy combined capacity-notification state
cannot suppress its first protection warning. Arbitrary `alertKey` values are
not trusted as incident identities.

Existing independent per-recipient deduplication, ten-minute claims and
SMTP-acceptance acknowledgement remain. Failed mailboxes can retry without
repeating successful colleagues' email. Unknown/running checks do not re-arm;
verified protection can recover even while a storage advisory stays visible.
There is no uncontrolled-send fallback. SMTP cannot guarantee exactly-once:
a crash after acceptance but before acknowledgement can produce a duplicate.

Email shows only the plain-language problem, last verified HKT time, up to
three affected filenames (display-limited to 80 Unicode characters each) plus
remaining count, one next step and the System Health link. Technical hashes,
tables, migrations and job metadata stay on
the dashboard.

## Dated Cloud evidence and limitations

The separate October 15 read-only Cloud audit verified the intended account/
project and enabled `0 2-5 * * *` Asia/Hong_Kong scheduler. This morning's
succeeded/verified manifest started 02:03:32.674 HKT, finished 02:06:22.303 and
had verified Drive publication 02:06:25.729. It listed/checked 6,332 unique file
references: zero failed/uploaded, 6,332 unchanged. The later 05:03 execution log
recognized the completed backup and published manifest.

That audit did not independently download/hash all object bytes or restore
them. Bucket usage was about 8.654 GiB/14,316 objects versus about 3.903 GiB
current-source estimate; versions/soft deletion can increase billable storage.
Existing HKD77.50 enforced protection covers Cloud Run only; project-wide
budget is alerts-only and does not establish a USD10 whole-project hard cap
or cap Cloud Storage. This correction changes no objects, retention, budgets,
plans, workers or schedules.

The September 23 recovery receipt (6,331 verified files, one uploaded, zero
failed) and then-pending PR27 checklist are historical, not current release
status. Keeping the latest verified database artifact and predecessor is
unchanged.

## Coordinated release and verification

1. Verify pinned identities in `config/fcunoConnections.ts` and actual hosted
   schedules/evidence. Do not use notification as a smoke-test endpoint.
2. Apply only the reviewed append-only gap migration. Verify service-role
   access, browser-role/generic-proxy denial, no new public business tables,
   unchanged audit/outbox/backup fence and advisors.
3. Run pure policy, actual health/notify-route, real SQL integration,
   rollback/concurrency and all application release gates. Preserve unrelated
   attendance/schema notification exclusions.
4. Test an immutable deployment, promote that exact build, and inspect only
   read-only health plus naturally scheduled backup/notification outcomes.

Focused commands (Node24; PGlite installed outside production dependencies):

```sh
NODE_OPTIONS=--conditions=react-server node --import tsx --test tests/backup-protection-*.test.ts tests/drive-file-backup-health.test.ts tests/system-health-alerts.test.ts tests/system-health-backup-window.test.ts
PGLITE_MODULE_PATH=/path/to/pglite/dist/index.js node --test tests/backup-protection-flow.test.mjs tests/backup-protection-gaps-sql.test.mjs tests/system-health-alerts-sql.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Actual email HTML passed dedicated headless Chromium/WebKit at 320/390/1440,
light/dark, with long filenames and no horizontal overflow. Native Outlook
automatic dark-mode transformation is not simulated. Email has no signed-in/
signed-out UI. `tests/system-health-alert-email.browser.test.cjs` needs the
separate Playwright runtime/browser installation; all owned contexts/browser
instances close after verification.
