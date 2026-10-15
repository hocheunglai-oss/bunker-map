# Outlook group edit/delete repair — local evidence

This is an undeployed website repair. It is separate from the read-only live
Exchange evidence in `exchange-live-preservation-2026-10-14.md`. No real group,
membership, Azure job, queue row or email was changed during these tests.

## Confirmed defect and implemented boundary

The original page persisted every group keystroke using queued full-row upserts.
A held upsert followed by deletion reproduced UI group count 0, server group
count 1, and lost memberships: the late upsert recreated the deleted group after
the delete's foreign-key cascade. Clearing the name could also persist an
intermediate incomplete group.

Group metadata now remains a local draft until explicit Save. Save and Delete
use the narrow authenticated `/api/outlook-addressbook/groups` operation. One
SQL UPDATE or DELETE filters the stable text identity and raw PostgreSQL
`updated_at`, returning the authoritative row. No group upsert or identity,
source UID, membership count or caller-written timestamp is accepted. The
trusted signed-in editor and fixed Outlook page supply audit context. Conflicts
retain the draft and require explicit reload instead of guessing a new version.

The client blocks selection, typing, delete, membership controls, sync and
create-dialog dismissal while a group request is pending. Contact draft
semantics remain unchanged; navigation/discard and sync guards account for both
editors. Group operations capture the owner identity and operation generation;
late bootstrap reads cannot clear a newer group draft or pending operation.

After a membership mutation, metadata and the complete paged membership list
are reloaded together. Two metadata-version reads plus two canonical membership
reads detect count-changing and legacy same-count changes; one bounded retry is
allowed. A failed or inconsistent refresh retains the known data and blocks
versioned editing until reload. Reloading a dirty draft requires explicit
discard confirmation. Creation uses INSERT with returned version, keeps one
stable ID during the dialog, and performs exact-identity/field readback after a
lost reply or duplicate acknowledgement; it never retries under a fresh ID.

The privileged generic proxy separately blocks legacy group PATCH, DELETE and
upsert POST, and count-preserving membership PATCH. Current source callers use
membership add/upsert on the same composite key or DELETE, not PATCH. Plain
validated group creation, group reads, supported membership operations and
contact operations remain available.

## Verification

- 11 actual group-route tests: authentication/view denial, trusted audit scope,
  one raw-version CAS mutation, protected-field rejection, held save/delete
  race, same-user stale versions, membership-advanced versions, deleted targets,
  malformed acknowledgements and sanitized database failures.
- 6 group validation/snapshot tests: required fields, raw microseconds,
  invalid dates, coherent member reload, bounded concurrent-change retry,
  same-count replacement detection and invalid/count-mismatched replies.
- 7 actual generic-proxy group tests pass alongside 15 existing contact tests.
  Root also verified the broader proxy fixture set without weakening contact,
  pricing, CCINFO or phonebook protections.
- Native PostgreSQL 17.6: the original 5 CAS/FK tests pass with the repaired
  counter, and the expanded counter suite contributes 17 tests (22 total,
  zero failures/skips). Distinct service-role backends and observed real lock
  waits prove delete/save ordering, parallel membership edits and rollback.
  The expanded fixture loads the actual live-matching source audit/outbox
  functions and actual backup-fence definitions, not mocked count logic.
- Production Next.js build and TypeScript passed with synthetic public
  credentials. Expected unreachable placeholder database logs did not prevent
  compilation/static generation; no production data was queried by the build.
- Actual built-app Chromium and WebKit workflows passed at 320, 390 and 1440
  pixels under light and dark system preferences, with signed-in and signed-out
  views. Screenshots were inspected for controls, contrast, clipping and page
  overflow. Browser/API fixtures were synthetic and isolated; no personal tabs
  or live credentials were used.

The browser flows cover no writes while typing/clearing; blank-field rejection;
held-save control exclusion; conflict draft retention; lost-save readback with
no resend; member-refresh failure and recovery; new source-book draft; lost
INSERT exact readback with no duplicate; and versioned deletion.

## Concurrent member-count repair — added 15 October 2026

An additional native test of two people adding different members simultaneously
found an existing trigger flaw: actual member rows 3, stored `member_count` 2.
The second count query took its snapshot before waiting for the first writer's
parent-row lock. A retained RED test reproduces that exact old function.

CLI-generated migration
`20261015072659_serialize_outlook_group_membership_counts.sql` now locks all
affected existing parents in deterministic ID order with `FOR NO KEY UPDATE`,
then recounts in a separate VOLATILE SQL command with a fresh READ COMMITTED
snapshot. NO KEY UPDATE remains compatible with the foreign key's KEY SHARE
locks. Old and new parents are included on membership moves. Every membership
mutation advances the parent version, including count-preserving identity or
source-book updates; a cascade never recreates a deleted parent. Canonical
schema and append-only migration definitions are byte-identical.

Read-only canonical-host checks on 15 October found 363 groups, zero count
mismatches, RLS enabled/no policies on both group tables, and only postgres and
service_role holding DML. Both supported writer roles bypass RLS and already
have parent SELECT/UPDATE. The replacement is therefore SECURITY INVOKER with
an empty search path and no new grants. Function EXECUTE is revoked from PUBLIC,
anon, authenticated and service_role: existing triggers still work, but callers
cannot reuse it as a callable operation or attach it to another table. Native
tests prove browser-role denial and complete rollback when the writer lacks
parent UPDATE permission, rather than silently elevating it.

The migration first tries the shared backup fence, then takes source table
locks with NOWAIT. Backup or writer contention aborts the whole migration with
55P03; bounded lock/statement timeouts prevent an indefinite DDL wait. The
backfill updates only mismatched rows under the source locks. With healthy
counts it issues no UPDATE and creates no backup epoch. Derived count/version
touches add neither human audit rows nor extra group sync work.

Native tests cover add/add, remove/remove, add/remove, opposite cross-group
moves, same-count updates, stale parent Save/Delete, parent/contact cascades,
explicit rollback, late outbox rejection, REPEATABLE READ serialization failure,
batch deadlock victim rollback, busy migration/backup fences and selective/no-op
backfill. Multi-statement batches that pre-acquire different groups can still
deadlock; PostgreSQL aborts the complete victim transaction, leaving no partial
membership, count, version, audit, queue or backup marker. Current UI operations
change one membership at a time. Do not add unsafe automatic partial retries.

Synthetic retained native TAP evidence:
`/private/tmp/fcuno-outlook-group-counter-native-20261015.tap`.
The tested PostgreSQL runtime SHA-256 is
`13f0b1fd17581d52e20893ec4e2839213e66be28074005e18b4f215d6d2b2046`.
The old and repaired full fixture SHA-256 values are respectively
`45d5e0c5b1d639d0ca0ee2e2484565aa244f581baa3849c640d44d4e0d4a1e94`
and `ac406dd15f021f3c17769a6af3ace78182454dbea2a8c2f9699afc39488854fd`.
This migration remains local and requires independent review/integration before
hosted application; no production count incident or hosted repair is claimed.

## Separate audit-linkage uncertainty

The expanded fixture confirms an existing independent boundary: a caller that
supplies only `x-bunker-audit-correlation-id` retains the correct actor and source
audit row, but the live-matching queue function may leave its `audit_log_id` and
`change_set_id` null. The audit function adopts the header UUID without placing
it into `app.audit_correlation_id`; the queue function reads only that setting.
Explicit application correlation links correctly. This is reported separately
for the broader audit work and is not silently patched by the counter migration.
The independent truth hash ledger and Azure delivery worker are not loaded by
the counter fixture; current Exchange delivery is evidenced separately.

## Verification limits and interface follow-up

- Admin CSS intentionally fixes the current light palette; dark system
  preference compatibility was tested, not a nonexistent night-theme selector.
- Integration follow-up on 15 October repaired the global mobile Tools overlap
  in the shared stylesheet: the button occupies its own document row instead
  of floating over scrolled fields. The actual combined production-build group
  flow passed again in Chromium/WebKit at 320/390/1440px, light/dark preferences,
  signed in/out; screenshots show a clear Directory search and fitting controls.
  See `mobile-navigation-overlap-2026-10-15.md` for the independent 24-case shell
  hit-test/keyboard matrix. No physical-device proof is implied.
- WebKit validates the browser engine, not a physical iPhone or an installed
  Outlook add-in. Real Outlook insertion/propagation is not established here.
- Native tests require an owned exact PostgreSQL 17.6 runtime; browser tests
  require Playwright engines and a local server. Neither is silently skipped
  in CI: focused CI runs API/validation/proxy tests; native/browser execution
  is recorded separately. Local HTTPS is required for WebKit because the
  application upgrades insecure asset URLs.

Representative local screenshot evidence is under
`/private/tmp/fcuno-outlook-groups-20261014/`; it is generated verification output,
not a production artifact or a repository credential source.

The combined actual-app run also checks the Tech Stack worker register at the
same 12 engine/width/preference combinations, including signed-out denial,
contained local table scrolling and no vertically clipped worker text.
Inspected integration screenshots are under
`/private/tmp/fcuno-combined-ui-7b16SJ/screenshots/`. API/auth responses remain
synthetic; the production Next.js page/layout/styles are real.
