# Backup operational assessment — 2026-09-24

## Verdict and constraints

The system has useful independent copies and strong export-integrity checks,
but a complete, measured disaster recovery has not been demonstrated. A
successful copy is not proof that the whole application can be restored.
The user's constraints remain: no paid plan upgrade, a US$10/month backup
spending target, and retention of exactly the latest two verified database
JSON artifacts. This assessment does not change those settings or claim that
the improvements below have been implemented.

Evidence combines repository inspection at `6d2ea65` with live operational
checks reported in this task on 2026-09-24. No restore, source-file deletion, or
production cutover was performed for this assessment.

## What is established

| Area | Evidence and limit |
| --- | --- |
| Scheduled Drive copy | Cloud Run's 02:00 HKT primary execution ending `wtq94` succeeded. Its manifest was generated `2026-09-23T18:03:59.729Z` and finished `2026-09-23T18:06:10.264Z` (02:03–02:06 HKT on September 24), with 6,331 files verified, zero failed, zero uploaded, and 6,331 unchanged. Logs for the later 03:00, 04:00, and 05:00 slots explicitly confirm no retry was needed because today's completed backup and published manifest were verified. |
| File history policy | GCS versioning is enabled. Lifecycle deletes noncurrent generations with creation `age: 30`; soft delete is `604800` seconds (seven days). This is not 30 days since replacement. |
| Actual bucket footprint | Flat GCS listings measured 9,029,639,745 live bytes and 9,131,246,477 bytes including noncurrent versions, plus 32,699,415 soft-deleted bytes (eight objects): approximately 8.53 GiB combined. The source manifest's 4,190,922,564-byte estimate (3.90 GiB) is not total billed storage. Retained paths outside the current source set and manifests need classification before any cleanup; no objects were removed. |
| Supabase project and plan | The connector confirmed `gglyugbrnyvyfktgwert` is the healthy `bunker-map` project in `hocheunglai-oss's Org` (`yxyxcenpgqutvoctrdkj`), with existing plan `pro` / `tier_pro`. A plan label alone does not prove that a usable managed restore point exists; the backup list remains unverified. No upgrade was performed. |
| Database export | Public-table inventory, mutation-fence checks, immutable-ledger checkpoints, section hashes, and predecessor anchors detect several classes of incomplete or inconsistent export. Ephemeral sessions and documented password hashes are deliberately excluded. |
| Upload verification | New JSON uploads pass Drive MD5 and size receipts before completion and pruning. System Health later downloads and SHA-256 checks the newest artifact and predecessor. This is staged verification, not fresh-upload SHA-256 readback before pruning. |
| Additional media | Supabase has one private bucket, `spc-presentation-media`, containing 15 objects and 224,309,367 bytes. Neither the database JSON nor the Drive-to-GCS job includes these bytes. Another independent copy has not been established. |
| Access and budget | Live IAM confirms the runner's bucket `storage.objectAdmin` and project `secretmanager.secretAccessor` grants. The existing HKD budget was updated to HKD77.50 and read back. A native Cloud Run cap form was prepared but not saved; no cap activation or enforced total-bill ceiling is established. |
| Tests | All 44 focused runner, health, staging, and backup-contract tests passed locally. They are not a whole-database restore or file-restoration rehearsal. |

## Gaps and priorities within the existing budget

1. **Prove database recovery first.** The JSON is a logical archive, not a
   whole-database dump; `scripts/restore-backup-to-recovery.mjs` refuses all JSON
   REST restores. A current managed restore point or owner-level dump, plus a
   successful isolated rehearsal, was not established. Prefer a reviewed
   owner-level dump/restore workflow on existing infrastructure over buying a
   plan upgrade. Resolve access and credential handling under `AGENTS.md`;
   do not infer permission to move credentials between projects. Preserve the
   two-JSON policy; any new recovery artifact and retention needs explicit
   agreement.

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
   exceeds the source-only estimate and the 5 GiB storage free-tier allowance;
   eligibility, operations, execution, and other billed resources still need
   the actual billing report. Classify retained paths and manifests before
   cleanup, preserving necessary recovery generations. The HKD77.50 budget
   update has been read back; the native Cloud Run
   cap form was not saved. A billing budget is not a hard stop,
   and US$10 is not an established total-bill ceiling. Separately
   verify recovery-account access, MFA, required secrets, source revision,
   configuration, and least-privilege deletion rights without relying solely
   on the production application. Live IAM confirms bucket object-admin and
   project-wide secret-accessor grants for the runner; these do not establish
   independent deletion protection.

## Accepted limitations and open evidence

Two retained JSON files are two recovery points, not a guaranteed two-day
history: manual successful backups can shorten the interval. Hash-valid bad
changes may enter both copies after two rotations. That delayed-discovery
exposure remains part of the user's chosen retention policy.

Normal recovery-point age is approximately daily, not continuous. A file
changed just after 02:00 can remain pending until the next day's 06:00 deadline
(roughly 28 hours); unsuccessful runs remove any bound. Recovery time is
unknown until a full timed rehearsal succeeds. File health checks active DB
references against manifests, not every historical GCS generation's current
readability. Versioning and soft delete do not by themselves establish an
immutable, independently administered vault.

Still required: usable full-database restore evidence, presentation-media
backup evidence, timed end-to-end recovery, actual cost totals, effective
access/deletion policy, and deployed alert/cap verification.

Managed-backup availability could not be checked through the available
connector, which has no backup-list method, or the local CLI, which is not
installed. Browser fallback was paused because the available Chrome profile
name did not match the repository's pinned `Otto` profile. No backup dashboard
was accessed through an unverified profile, and no restore action was taken.

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
