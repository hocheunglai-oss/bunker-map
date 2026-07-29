# Backup and Restore Runbook

Last audited: 2026-07-29

## Recovery contract

FCUNO is the source of truth for the shared address book. The authoritative
desired state is held in:

- `shared_addressbook_contacts`
- `shared_addressbook_groups`
- `shared_addressbook_group_members`
- their user-change records in `audit_logs`
- the durable, mutable delivery state in `outlook_exchange_sync_queue`
- the immutable receipts and evidence in
  `outlook_exchange_sync_certifications`,
  `outlook_exchange_truth_snapshots`, and
  `outlook_exchange_truth_ledger`

Queue rows are operational state: they move through pending, processing,
completed, and failed states. Their significant transitions are captured in the
append-only truth ledger; the queue itself must not be treated as an immutable
audit record.

Microsoft Exchange is a rebuildable projection of that state. Exchange is
never used to overwrite FCUNO during recovery. A recovery is not complete
until a full Exchange reconciliation produces an exact-match certification and
a `full_projection_evidence` ledger entry.

The truth ledger is append-only and SHA-256 chained. A row records its exact
payload hash, the preceding entry hash, and any content-addressed source
snapshot it uses. This detects modification or deletion inside the retained
chain. Deleting only the tail cannot be detected from that shortened chain
alone; it is detected by comparing the expected external head anchor. A hash
chain inside one database is not by itself an independent backup, so the
external anchors below are part of the recovery contract.

## Daily off-site artifact

Vercel calls `/api/backups/bunker-map-drive` every day at `19:00` UTC
(`03:00` the following day in Hong Kong). It stores backup-format-v2 JSON files
in Google Drive under:

```text
Bunker Map Backups / Daily Supabase Backups
```

Only files named
`bunker-map-backup-*.json` are retention-managed. Verified files less than 35
days old are retained; older verified files are moved to Google Drive trash,
where they remain recoverable according to the Drive account's trash policy.
Retention is time-based, not a promise that exactly 35 files exist. An
authorized administrator can also create a copy immediately from System Health
using `BACK UP NOW`.

The route uses `SUPABASE_SERVICE_ROLE_KEY` to read the backup data. It does not
fall back to the public anonymous key. A backup is only published as successful
after its uploaded bytes are downloaded from Drive and their SHA-256 is
rechecked. Retention pruning happens only after that verification succeeds.
During export, the paged data body is held in a bounded gzip-compressed
temporary staging file and decompressed directly into the Drive upload stream.
The published artifact remains ordinary JSON, so existing validators and
restore evidence remain compatible while temporary storage no longer grows at
the full uncompressed database size.
System Health independently downloads the latest verified file and its
immediate verified predecessor, rechecks both artifacts and their Drive
application properties, and rejects a broken or skipped predecessor anchor.
Unverified managed backup files are surfaced for review rather than silently
treated as valid recovery points.

### Backup-format-v2 integrity manifest

Every v2 artifact includes:

- `schemaVersion: 2`;
- a unique backup run ID, trigger source, requesting identity, live database
  migration head, and deployed commit;
- a database inventory proving that every live public table is either exported
  or explicitly classified as ephemeral;
- a hash reference to the preceding verified Drive backup (after the first v2
  artifact), forming a retention-spanning external artifact chain;
- a generated-at timestamp and declared row counts;
- every required data section, including Exchange certifications, snapshots,
  and the complete truth-ledger prefix captured by the backup;
- a SHA-256 for each data section;
- the SHA-256 of the complete artifact payload covered by the manifest;
- the captured database checkpoint: ledger row count, head sequence, head
  SHA-256, and latest full-certification/projection evidence.

The checkpoint is taken before the export and defines its upper ledger bound.
The exported ledger must begin at the first entry and end at that exact head.
This is what lets the offline validator detect a missing tail, not only a
modified row in the middle.

The backup includes the application tables used by the map, price history,
remarks, legacy and current admin settings, email templates, FCUNO address book
and phonebook, CCINFO metadata, Audit Log, Exchange delivery/certification
evidence, SPC users/enquiries/fixtures/suppliers/presentation content, WhatsApp
conversations/messages, parser reports, plus point-in-time exports from Google
Contacts and Google Calendar. `admin_users.password_hash` and
`spc_users.password_hash` are deliberately excluded and listed in
`databaseInventory.excludedCredentialFields`. Inspect `databaseInventory`,
`counts`, and `integrity.sections` rather than relying only on this prose.

`email_templates` is the sole restorable Outlook-template source. The former
`office_calendar_store` template payload is retained only under an explicitly
archived key and must never be promoted merely because the canonical table is
empty. `admin_sessions` is explicitly ephemeral: it is not exported or
restored, so every recovery invalidates active admin sessions by design.

A trusted artifact has zero `warnings`. Google export failures, an unregistered
live table, an inconsistent Exchange queue, or failed truth verification abort
the backup instead of producing a partially trusted file.

### Independent anchors

The FCUNO shared-address-book and Exchange projection truth is anchored outside
Supabase in two ways:

1. A successful full Exchange notice records the run ID, truth-ledger sequence
   and SHA-256, canonical Exchange-projection snapshot SHA-256, and raw FCUNO
   snapshot SHA-256.
2. The daily Drive artifact records and verifies the ledger head plus its own
   artifact and section hashes. Each artifact also names and hashes the
   preceding verified Drive file.

During an address-book incident, compare the latest trustworthy email receipt
with a Drive artifact at or after that run. The ledger entry at the emailed
sequence must have the emailed entry hash and snapshot hashes. A later Drive
head is expected; an absent or different anchored entry is not. The notice email
does not independently anchor unrelated FCUNO tables, Google exports, SPC data,
WhatsApp data, or CCINFO metadata; use the Drive artifact, managed database
backup, and their own system evidence for those records.

The validator prints the SHA-256 of the exact downloaded file bytes. Compare it
with the Drive file's `uploadedFileSha256` application property or the backup
route's successful response. For every artifact after the first v2 file, also
confirm that `previousVerifiedBackup` matches the preceding file's Drive ID,
name, artifact SHA-256, and uploaded-file SHA-256.

Email and Drive are independent evidence locations, not magical
tamper-proofing. Restrict deletion rights, retain mailbox history, protect the
Google and Microsoft administrator accounts with MFA, and investigate any
anchor mismatch before restoring or resuming synchronization.

The JSON contains business contact details, audit history, messages, and other
personal or commercially sensitive data even though password hashes are
excluded. Store the backup folder in a dedicated least-privilege location,
limit download and deletion rights, and review its access log periodically.

## File-content backup

CCINFO uploaded documents are stored as file contents in Google Drive under
`Manual Uploads`. The daily JSON contains their metadata, including
`drive_file_id`, `drive_url`, names, paths, and soft-delete state in
`cc_company_files` and `cc_entry_files`.

The JSON cannot recreate those file bytes. The independent Google Cloud Storage
copy is documented in
[google-cloud-drive-file-backup.md](google-cloud-drive-file-backup.md), and its
latest manifest is monitored by System Health.

Google Calendar and Google Contacts remain their own live systems, although a
current API export is included for investigation. Google Drive remains the live
source for CCINFO file bytes; Google Cloud Storage is the independent copy.

## Supabase-managed backups and PITR

The Drive JSON is an independently verifiable logical archive. It is not a
replacement for a whole-database backup because it cannot, through the REST
API, reproduce PostgreSQL sequences, trigger creation order, grants, role
passwords, or the immutable truth tables exactly.

Supabase currently provides daily managed backups for Pro, Team, and Enterprise
projects with plan-dependent retention. They restore the whole database, cause
project downtime during restoration, do not restore deleted Storage API object
bytes, and do not retain passwords for custom roles. Confirm the production
project's current plan, available restore points, and most recent successful
backup in **Database > Backups**; do not infer availability from this
repository.

See the current
[Supabase Database Backups guide](https://supabase.com/docs/guides/platform/backups)
before a restore; plan limits and procedures can change.

Point-in-Time Recovery (PITR) is a paid add-on, requires at least a Small
compute add-on, and uses WAL archiving for a worst-case recovery point objective
of about two minutes. Enabling PITR replaces scheduled daily backups rather than
running alongside them. PITR is not enabled by this runbook or by application
code; enabling a paid service requires an explicit operational decision.

The safest recovery order is:

1. Supabase managed backup or PITR for exact whole-database recovery.
2. An owner-level `pg_dump`/`pg_restore` rehearsal when a current logical dump
   is available.
3. The validated Drive v2 JSON for independent integrity evidence and,
   only with reviewed owner-level tooling, last-resort business-data salvage.

## Non-destructive validation

Download a `bunker-map-backup-*.json` file and run:

```bash
npm run backup:validate -- /absolute/path/to/bunker-map-backup.json
```

The validator performs no writes. For v2 it verifies:

- required sections, declared counts, duplicate IDs, and major foreign keys;
- artifact and per-section SHA-256 values;
- every snapshot's exact UTF-8 byte length, canonical JSON SHA-256, kind,
  schema, and declared item counts;
- every ledger payload hash, canonical timestamp, exact hash material, entry
  hash, previous-entry link, snapshot reference, and uniqueness constraint;
- certification-to-raw-snapshot and projection-evidence pairing;
- the exported first entry and checkpoint head, including ledger count,
  sequence, and SHA-256, which detects a missing tail.

`RESULT: VALID` means the artifact is internally consistent with its
hash-covered content and captured database checkpoint. It does not prove that
the Google account, mailbox, or production database has never been compromised;
compare the independent anchors as well.

Do not restore a file that reports an error. Preserve the original bytes, record
its Drive file ID and SHA-256, and investigate the first reported mismatch.

## Exact recovery procedure

### 1. Contain and preserve

1. Stop FCUNO address-book writes and pause both incremental and scheduled full
   Exchange jobs. Record the incident time in UTC and HKT.
2. Do not delete, retry, or rewrite queue rows. Preserve the latest notice
   email, the latest two Drive artifacts around the incident, and their Drive
   file IDs.
3. Validate those artifacts locally. Record each artifact SHA-256, ledger head
   sequence/hash, and the latest certification run ID.
4. Select a recovery point before the first untrusted change, using the audit
   record, queue history, notice anchor, and available managed restore points.

### 2. Restore into an isolated project

Provision a separate recovery project. Never rehearse against production
project reference `gglyugbrnyvyfktgwert`.

For exact recovery, use one of these owner-level paths:

- restore/clone the chosen Supabase managed backup or PITR point; or
- restore a full owner-level PostgreSQL dump into the empty recovery database
  using the matching PostgreSQL client version and the Supabase database-owner
  connection, following
  [Supabase's backup/restore guide](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

A full logical dump must include pre-data, table data, sequences, and post-data
objects. Data is loaded before the immutable triggers are recreated, and
sequence values are restored, so the existing ledger rows and their order
remain exact. Do not pre-apply repository migrations on top of a full dump and
do not use a service-role REST client for this path.

For a populated recovery database whose applied migration head predates
`20260723121704_enforce_outlook_template_recipient_truth.sql`, migration replay
is a mandatory two-stage operation:

1. Apply repository migrations only through
   `20260723120455_outlook_template_recipient_truth.sql`.
2. Point the reconciliation command only at the isolated recovery project and
   run `npm run outlook-templates:reconcile`.
3. Require every `email_templates.recipient_resolution` value to be certified
   and non-empty, then continue with `20260723120726` and later migrations.

If the migration runner cannot pause at that boundary, stop and prepare a
reviewed owner-level recipient-resolution baseline before replaying
`20260723121704`. Never edit an already-applied migration or insert placeholder
recipient evidence to make a populated replay pass. An empty database may
replay the full chain normally.

If the v2 Drive JSON is the only surviving data source, stop and arrange a
reviewed owner-level recovery importer. The artifact contains enough evidence
to validate and salvage rows, but the repository deliberately has no automated
JSON-to-v2 restore because a REST upsert would create new trigger events and
could not recreate immutable rows or their sequence safely.

`scripts/restore-backup-to-recovery.mjs` therefore refuses every JSON REST
restore, including legacy files, before opening a Supabase client. It is a
fail-closed guard, not a supported restore path.

### 3. Verify the recovered database

Before allowing application or automation traffic:

1. Run `public.verify_outlook_exchange_truth_ledger()` with an owner/service
   account allowed to execute it. Require `integrityValid=true`,
   `referencesValid=true`, `operationallyConsistent=true`, and no first invalid
   ledger sequence, snapshot, or reference.
2. Point the reconciliation command only at the isolated recovery project, then
   run:

   ```bash
   npm run outlook-templates:reconcile
   ```

   After it completes, run
   `public.verify_outlook_template_recipient_truth()` and require schema
   `fcuno.outlook-template-recipient-truth/v2`, `valid=true`,
   `sourceTruthValid=true`, and zero `unresolved`, `stale`, and `invalidShape`
   templates. Its certification run ID, certified timestamp, source
   fingerprint, and queue counts must match
   `public.verify_outlook_exchange_truth_ledger()`. Missing or ambiguous
   recipients may keep `allTemplatesSendable=false`; review those exact
   literals and keep the affected templates blocked rather than guessing a
   recipient.

3. Match recovered table counts to the validated artifact or managed-backup
   evidence for the selected recovery point.
4. Match the recovered ledger head or the applicable earlier ledger entry to
   the preserved email and Drive anchors.
5. Confirm the latest certification's raw source snapshot, projection evidence,
   source fingerprint, and run ID pair correctly.
6. Confirm no unexpected `pending`, `processing`, or `failed` queue rows.
   Expected pending work must be understood before resuming the worker.
7. Verify CCINFO `drive_file_id` references against Google Drive and recover
   missing bytes from the independent Google Cloud Storage copy.
8. Exercise read-only application workflows and Audit Log/User Management in
   the isolated environment.

### 4. Rebuild Exchange from FCUNO

1. Keep FCUNO writes paused.
2. In a rehearsal, use compare-only/dry-run mode or an isolated Microsoft test
   tenant. Never point a historical recovery snapshot at the live Exchange
   directory. In a real incident, run a full live synchronization only after
   the recovered FCUNO state has been promoted and the user has explicitly
   approved that production change. Never seed FCUNO from Exchange.
3. Require global contact, group, and membership comparison to report an exact
   match, a stable source fence, zero mismatches, and zero invalid source rows.
4. Require a new immutable full certification and
   `full_projection_evidence` entry.
5. Preserve the resulting email notice and compare its ledger/snapshot hashes
   with the recovered database.

Only after both truth verifiers and all remaining checks pass should the user
approve a production cutover or a managed production restore. The template
reconciliation and v2 verifier are a hard gate: do not enable production
template writes, resume FCUNO writes, or restart the Exchange worker while any
placeholder, stale, or malformed recipient evidence remains. Resume FCUNO
writes first, then the incremental worker, and monitor the queue and next daily
Drive artifact.

## Periodic rehearsal

At least quarterly:

- validate the newest and one older Drive artifact;
- confirm the retained verified files cover the expected 35-day date window,
  their predecessor anchors are continuous, older managed files were moved only
  to recoverable Drive trash, and no unrelated Drive files were touched;
- confirm the Supabase managed-backup/PITR status in the dashboard;
- perform an isolated owner-level restore rehearsal;
- verify the ledger and independent anchors;
- run a compare-only reconciliation against live Exchange, or a full
  reconciliation against an isolated Microsoft test tenant, without promoting
  the recovery project or mutating live Exchange.

Record the rehearsal date, selected backup, artifact SHA-256, ledger head,
restore duration, verification result, and operator in the operational audit
record.
