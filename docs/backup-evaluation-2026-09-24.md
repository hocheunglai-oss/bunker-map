# Backup operational assessment — 2026-09-24

## Verdict and constraints

The system has confirmed managed database restore points, useful independent
copies, and strong export-integrity checks, but a complete, measured disaster
recovery has not been demonstrated. A listed restore point or successful copy
is not proof that the whole application can be restored.
The user's constraints remain: no paid plan upgrade, a US$10/month backup
spending target, and retention of exactly the latest two verified database
JSON artifacts. Confirmed operational changes are recorded separately below;
the recommended recovery improvements have not been implemented by this
documentation update.

Evidence combines repository inspection at `6d2ea65` with live operational
checks reported in this task on 2026-09-24. No restore, source-file deletion, or
production cutover was performed for this assessment.

## What is established

| Area | Evidence and limit |
| --- | --- |
| Scheduled Drive copy | Cloud Run's 02:00 HKT primary execution ending `wtq94` succeeded. Its manifest was generated `2026-09-23T18:03:59.729Z` and finished `2026-09-23T18:06:10.264Z` (02:03–02:06 HKT on September 24), with 6,331 files verified, zero failed, zero uploaded, and 6,331 unchanged. Logs for the later 03:00, 04:00, and 05:00 slots explicitly confirm no retry was needed because today's completed backup and published manifest were verified. |
| File history policy | GCS versioning is enabled. Lifecycle deletes noncurrent generations with creation `age: 30`; soft delete is `604800` seconds (seven days). This is not 30 days since replacement. |
| Actual bucket footprint | Flat GCS listings measured 9,029,639,745 live bytes and 9,131,246,477 bytes including noncurrent versions, plus 32,699,415 soft-deleted bytes (eight objects): approximately 8.53 GiB combined. The source manifest's 4,190,922,564-byte estimate (3.90 GiB) is not total billed storage. Retained paths outside the current source set and manifests need classification before any cleanup; no objects were removed. |
| Supabase project and plan | The connector and dashboard confirmed healthy production project `gglyugbrnyvyfktgwert` (`bunker-map`) in `hocheunglai-oss's Org` (`yxyxcenpgqutvoctrdkj`), on the existing Pro plan. No upgrade was performed. |
| Managed database backups | The dashboard listed eight `PHYSICAL` restore points dated September 17–24, each with an enabled Restore button. The newest was `2026-09-24T02:04:38Z` (10:04:38 HKT); the oldest was `2026-09-17T02:05:45Z`. This is an observed approximately seven-day span, not a guarantee of eight-day retention. PITR was not enabled. No restore button was clicked and no recovery test was performed. The dashboard explicitly excludes Storage object bytes from these database backups. |
| Database export | Public-table inventory, mutation-fence checks, immutable-ledger checkpoints, section hashes, and predecessor anchors detect several classes of incomplete or inconsistent export. Ephemeral sessions and documented password hashes are deliberately excluded. |
| Upload verification | New JSON uploads pass Drive MD5 and size receipts before completion and pruning. System Health later downloads and SHA-256 checks the newest artifact and predecessor. This is staged verification, not fresh-upload SHA-256 readback before pruning. |
| Additional media | Supabase has one private bucket, `spc-presentation-media`, containing 15 objects and 224,309,367 bytes. Neither the database JSON nor the Drive-to-GCS job includes these bytes. Another independent copy has not been established. |
| Access and budget | Live IAM confirms the runner's bucket `storage.objectAdmin` and project `secretmanager.secretAccessor` grants. The whole-project alerts-only budget was preserved. |
| Configured Cloud Run cap | Saved under verified Google Cloud account `wider.custom@gmail.com` for project `210526897676`: monthly HKD77.50, Cloud Run only, budget `c7eaf91f-6d62-416c-b5f5-e55468e04b11`, with automatic 50%/80%/100% notifications. The UI reported `Configured`. This confirms configuration, not an exercised enforcement test or a whole-project spending ceiling. |
| Tests | All 44 focused runner, health, staging, and backup-contract tests passed locally. They are not a whole-database restore or file-restoration rehearsal. |

## Gaps and priorities within the existing budget

1. **Rehearse the existing managed database recovery first.** Use the physical
   restore points already included in the current Pro plan as the first
   recovery option; availability is now verified, but a successful isolated
   rehearsal and recovery time remain unproven. The two Drive JSON files are
   secondary logical archives, not the only database recovery history.
   `scripts/restore-backup-to-recovery.mjs` refuses JSON REST restores, so do
   not treat them as substitutes for the physical restore workflow. An
   additional off-provider owner-level dump can reduce provider dependency,
   but its destination, cost, credential handling, retention, and rehearsal
   require approval. Resolve access under `AGENTS.md`; do not infer permission
   to move credentials between projects. No plan upgrade or retention change
   is recommended as a prerequisite.

2. **Protect the confirmed missing media class.** Add independently verified
   copies and a restoration procedure for presentation video/audio. Their
   database rows contain references only, and replacement currently removes
   the preceding Supabase object. Record object-to-row mappings and test a
   representative restoration before claiming coverage.

3. **Alert on overdue database backups.** The inspected code turns age over
   36 hours into a warning and suppresses all database-backup warning emails.
   Missing verified backups also produce a warning. Deduplication should
   permit a first actionable notice and escalation; blanket suppression does
   not establish that protection. Check the production deployment separately
   before describing pending alert changes as live.

4. **Reconcile recovery points and verification labels.** Database and file
   jobs run separately, so there is no atomic database-plus-files snapshot.
   A later database copy can reference a file pending its next file backup.
   Recovery should prove the required object generations for the chosen DB
   point. The fresh-upload MD5 receipt and later SHA-256 check must remain
   distinguishable. Neither one proves that semantically bad source data is
   business-correct.

5. **Measure actual cost and recovery access.** The bucket footprint above
   exceeds the source-only estimate and the 5 GiB storage free-tier allowance.
   At approximately US$0.02/GiB-month, 8.53 GiB is roughly US$0.17/month for
   storage alone before any applicable allowance; this is not a total-cost
   forecast. Eligibility, operations, execution, data transfer, and other
   billed resources still require the actual billing report. Classify retained
   paths and manifests before cleanup, preserving necessary recovery
   generations. The configured monthly HKD77.50 native cap applies only to
   Cloud Run, not Storage or the whole project. It uses gross costs and is
   subject to billing/enforcement latency, so it is not an exact US$10
   whole-bill guarantee. Enforcement can pause future backup jobs and requires
   a manual cap lift before they resume; monitor backup freshness when the cap
   is reached. The separate whole-project budget remains alerts-only. Separately
   verify recovery-account access, MFA, required secrets, source revision,
   configuration, and least-privilege deletion rights without relying solely
   on the production application. Live IAM confirms bucket object-admin and
   project-wide secret-accessor grants for the runner; these do not establish
   independent deletion protection.

## Recommended division of responsibilities

Keep Google Drive as the working file system for ordinary access, sharing,
and collaboration; keep GCS as the independent recovery copy. Do not replace
the working Drive folder with GCS merely to save the small estimated storage
charge. Keep the user's two verified Drive JSON files as secondary database
evidence, use the confirmed Supabase physical backups for database recovery,
and prioritize covering presentation-media bytes and testing restoration.
This recommendation does not add a new backup job, change retention, or
authorize cleanup.

## Accepted limitations and open evidence

Two retained JSON files are two recovery points, not a guaranteed two-day
history: manual successful backups can shorten the interval. Hash-valid bad
changes may enter both copies after two rotations. That delayed-discovery
exposure applies to the chosen JSON retention; the separately confirmed
managed physical restore points currently provide additional database history.

Normal recovery-point age is approximately daily, not continuous. A file
changed just after 02:00 can remain pending until the next day's 06:00 deadline
(roughly 28 hours); unsuccessful runs remove any bound. Recovery time is
unknown until a full timed rehearsal succeeds. File health checks active DB
references against manifests, not every historical GCS generation's current
readability. Versioning and soft delete do not by themselves establish an
immutable, independently administered vault.

Still required: a successful full-database restore rehearsal, presentation-media
backup evidence, timed end-to-end recovery, actual cost totals, effective
access/deletion policy, deployed overdue-alert verification, and a documented
response when the configured Cloud Run cap interrupts backups.

The connector verified the Supabase project and plan but has no backup-list
method, and the local CLI was unavailable. After the user's authorization of
the browser fallback, a separate tab verified the exact production project,
organization, scheduled restore points, and disabled PITR through normal
dashboard content. The tab was closed afterward. No restore, configuration
change, or upgrade was performed during that Supabase check.

## Evidence pointers

- `app/api/backups/bunker-map-drive/route.ts`: `getBackupInventory`,
  `buildBackupFile`, `createBackup`, and `pruneOldDriveBackups`.
- `lib/systemHealth.ts`: `verifyStreamedBackupFile`, `checkDriveBackup`,
  `listActiveDriveBackupFiles`, and `DAILY_BACKUP_WARNING_AGE_HOURS`;
  `app/api/admin/system-health/notify/route.ts`: `isNonAlertingCheck`.
- `lib/spcPresentation.ts`: `PRESENTATION_BUCKET` and
  `completeSpcPresentationUpload`.
- `scripts/backup-google-drive-files-to-gcs.mjs`: `collectDriveFiles`,
  `metadataMatches`, `backupOneFile`, and `publishSuccessfulManifest`.
- [Backup and restore runbook](backup-restore-runbook.md),
  [Drive file backup operations](google-cloud-drive-file-backup.md), and
  [open continuity evidence](spc-security-evidence-index.md).
- Google's [lifecycle age semantics](https://docs.cloud.google.com/storage/docs/lifecycle#age)
  and [soft-delete behavior](https://docs.cloud.google.com/storage/docs/soft-delete).
