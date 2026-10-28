# Fixed PostgreSQL export capability — inactive integration candidate

This code is preparation, not an active weekly backup. The route and Google
command are disabled by default. No credentials, deployed permissions, schedule
or live export are installed by this change; the SQL migration is unapplied.

## Changed security boundary

The Google job receives one operation: request the fixed, complete logical
PostgreSQL export during the 02:00–06:00 HKT window. It cannot choose SQL,
host, role, arguments, environment, snapshot, path or destination and receives
no PostgreSQL password, PAT or administrator credential. Its existing Google
metadata identity is checked against the exact audience, issuer, service-account
email **and immutable subject**. A source-owned Ed25519 key signs native zero
exit, exact archive bytes/hash and metadata. Google holds only the public key.

The source-side reader is **not intrinsically non-writable**. PostgreSQL PUBLIC
large-object functions remain available to that role. Compromise of the trusted
source exporter or its native credential remains a different risk. This design
enforces the narrow capability against a malicious Google caller; it does not
claim that `GET`, a role name, a default setting or a source-side credential is
itself proof of an unconditionally non-writable PostgreSQL principal.

## Implemented, locally tested path

- Exact production-origin/project gate and one fixed POST body; disabled unless
  trusted runtime, cryptographic Google verifier, durable source-owned admission
  and native adapter are supplied. The route returns 404 while unactivated.
- Durable source-owned admission limits native export to two attempts per UTC
  week, with a one-hour cooldown and 250-second lease. It shares the existing
  daily JSON export lock; failed or cancelled native work closes before lease
  release. Only the existing source application may call the fixed admission
  RPCs. The Google identity cannot alter counters or choose the server clock.
- Two bounded native connections: one READ ONLY repeatable-read snapshot and
  one `pg_dump` using that snapshot. Strict TLS certificate verification and
  actual backend TLS, database and role checks; metadata statements have a
  20-second deadline, dump acquisition has a 2-second lock-wait limit, and the
  entire source operation has a 240-second external abort/kill deadline.
  `pg_dump` resets its own statement timeout; do not claim the metadata timeout
  limits each dump statement. Its complete lifetime is bounded by the source
  process supervisor and request/window deadline.
- Pinned executable, native-library bundle and CA hashes, no shell, no inherited environment, no user
  startup/password files, no native credential in argv or output. Credential
  supplier has no administrator API call, refresh or role-minting behavior.
- Dedicated source-only native login `fcuno_backup_export_login`: no superuser,
  database creation, role creation or replication; two connections maximum;
  BYPASSRLS plus only `pg_read_all_data` (inherit, no ADMIN or SET membership).
  Password expires within 90 days. Runtime verifies role attributes/membership
  and expiry from the source catalog. PostgreSQL PUBLIC large-object access
  remains the explicitly disclosed trusted-source risk, not a Google capability.
- Fixed custom-format gzip level 3 archive, streamed with backpressure. The
  previous V9 archive explicitly disabled compression (`--compress=0`), so its
  2,895,330,862 bytes do not predict compressed transfer size. Savings on real
  data and CPU/time must be measured; compression runs on the exporter, not the
  PostgreSQL server.
- Signed framing rejects truncated, modified, overlong, stale/replayed,
  wrong-key and nonzero-exit streams. No success on stdout EOF alone.
- Existing GCS transport supports a separate fixed PostgreSQL prefix. At most
  16 MiB archive-part buffering; no whole-archive staging. Create-only object
  uploads, exact-generation CRC/SHA readback, immutable manifest, generation-CAS
  lease/fence and last-good protection. Existing billing evidence gates optional
  work **before** source access. Readback occurs after source transactions close.
- No deletion capability. Existing four-week selection and dependency-aware
  retention policy remain dry-run only; this change does not falsely turn
  byte-copy verification into a successful restore.

The native test runs a real PostgreSQL 17.11 source using certificate-verified
TLS, through the actual capability handler and signed decoder, then restores in
a second owned isolated database. Synthetic table/auth/storage rows, large
objects, sequence state, materialized-view data, RLS policy, function behavior,
triggers/index TOC, ACL and comments match. Test authentication/admission are
injected fixtures, not evidence that production Google/JIT access is ready.

## Full recovery scope and remaining implementation gates

The archive covers native PostgreSQL logical database contents, not Storage file
bytes, Drive bytes, Azure configuration, role passwords, physical PITR or the
entire hosted platform. Its metadata capsule contains global roles (without
passwords), memberships, role settings, database ACL/comment/locale, extensions,
table inventory and large-object count. A production recovery must recreate
source-role copies as NOLOGIN and apply the exact metadata capsule safely.
The candidate fixture proves selected metadata and all synthetic content; it is
**not** a rerun or replacement of the prior production V9 twelve-section,
126-table fingerprint comparison. The old V9 helper path was cleaned; the
durable closeout retains receipts, not the source helper or archive.

Activation requires all of these concrete steps, not a general permission loop:

1. Provision the exact dedicated source-only native reader after reviewing the
   provider catalog; do not rotate an existing role or CLI credential. PostgreSQL
   17 permits a non-superuser with CREATEROLE and BYPASSRLS to create this role,
   and the operator must have ADMIN on `pg_read_all_data` to grant its membership.
   Local native tests use this non-superuser provisioning path. Live catalog
   checks reported both capabilities; production provisioning remains separate.
   No Temporary Access setting or platform PAT is required. This avoids the
   platform-user JIT mapping, which is not documented as role-restricted per PAT.
2. Install the reviewed source-owned admission migration. Native tests prove
   first-insert concurrency, cooldown, attempt ceiling, stale-owner fencing,
   daily JSON mutual exclusion and revoked anon/authenticated access. No
   source-owned RPC is callable directly by the Google principal.
3. Package PostgreSQL 17.11 Linux `psql`/`pg_dump`, OpenSSL, zlib and CA material
   for the actual Vercel runtime with immutable hashes. The local Mac fixture
   binary is not a cloud artifact. Verify native ELF dependencies and bundle
   size; do not route the entire website through a new container just to add it.
4. Verify the current plan/runtime supports the actual streamed response and
   source deadline. Standard streaming bypasses the 4.5 MB buffered response
   cap, but native source plus transfer still must finish within the configured
   limit. Direct host connectivity (including IPv6) is unproved; do not silently
   substitute an unpinned pooler, disable certificates or enable paid services.
5. Complete production-scope catalog/role-settings restoration and a contained
   cloud restore proof, then a bounded current source export and independent
   GCS readback. Only this establishes current full recovery coverage. Bind
   daily file versions to the recovered storage metadata separately.
6. Configure the exact Google subject, source signing key/public-key pin,
   source-only native credential and narrow source endpoint; enable the existing job's weekly
   branch and schedule only after the preceding gates pass. Preserve media,
   Drive, budget and retention settings. Add human-readable health publication
   without daily unchanged-incident emails.

Four uncompressed V9-sized archives would be approximately 10.79 GiB; at the
published US-central1 Standard rate gross storage is about USD0.22/month before
free allowances. This is not the total cost: Vercel egress, Supabase egress,
requests/readback, compute and existing copies also count. The live existing
budget guard is authoritative for optional work; USD10 is not a universal hard
ceiling. No paid capacity increase is required or approved by this candidate.

## Primary references

- [Supabase Temporary Access](https://supabase.com/docs/guides/platform/temporary-access)
- [PostgreSQL 17 CREATE ROLE privilege rules](https://www.postgresql.org/docs/17/sql-createrole.html)
- [JIT authorization scope](https://supabase.com/docs/reference/api/v1-authorize-jit-access)
- [Supabase backup portability limits](https://supabase.com/docs/guides/platform/backups)
- [Vercel function limits](https://vercel.com/docs/functions/limitations)
- [Vercel streaming](https://vercel.com/docs/functions/streaming-functions)
- [Google Cloud Storage pricing](https://cloud.google.com/storage/pricing)

## Exact activation inputs (never include secrets in evidence or command logs)

Source Vercel only, exact pinned production project:

- `POSTGRES_BACKUP_SOURCE_ENABLED=1` only after acceptance; absent means 404.
- `POSTGRES_BACKUP_GOOGLE_SUBJECT`: existing Google service account's verified
  immutable numeric subject, not just an email.
- `POSTGRES_BACKUP_BUNDLE_SHA256`: reviewed Linux bundle manifest SHA-256.
  Fixed packaged directory `.runtime/postgres/`; every binary/library is checked.
- `POSTGRES_BACKUP_CA_SHA256`: hash of the pinned Supabase public CA certificate
  packaged only at `.runtime/postgres-source/root.crt`.
- `POSTGRES_BACKUP_SIGNING_KEY_PEM`: newly generated Ed25519 private key,
  source-only. Google receives only its corresponding public key.
- `POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON`: exact object with `password`,
  `issuedAt` and `expiresAt` (integer UTC milliseconds, lifetime at most 90 days).
  Password must be random base64url, 43–128 characters; platform `sbp_` tokens are
  rejected. Fixed direct destination `db.gglyugbrnyvyfktgwert.supabase.co:5432`,
  database `postgres`, role/session role `fcuno_backup_export_login`.
- Existing `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` stay only
  source-side; used for the two fixed admission RPCs, never passed to subprocesses.

Existing Google Cloud Run job only:

- `POSTGRES_BACKUP_RECURRING_ENABLED=1` only after acceptance.
- `POSTGRES_BACKUP_VERIFICATION_KEY_PEM`: corresponding Ed25519 **public** key.
- Existing runtime identity, exact bucket and authentic media-budget config are
  reused unchanged. Any source password, service key or signing private key in
  this runtime causes immediate rejection.
- Invocation `node scripts/backup-postgres-to-gcs.mjs --execute-recurring-weekly`.
  Existing Drive default command, daily-media schedule and credentials are unchanged.

Sequence: review/build → apply admission only → validate source role/credential
and native bundle → deploy disabled source route and unactivated receiver →
check exact configuration, CA and certificate-verified native compatibility →
after-hours bounded source export/independent readback/recovery comparison →
enable weekly schedule only upon verified success. Never use a scheduler dispatch
or native exit alone as proof of a recoverable GCS copy. Current source window is
02:00–06:00 HKT; no office-hour export is supported by this implementation.
