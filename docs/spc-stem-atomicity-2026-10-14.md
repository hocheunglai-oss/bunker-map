# SPC STEM consistency repair

## Confirmed failure

The previous STEM path committed `spc_enquiries.status = quoted` and only then
looked up users and upserted `spc_fixtures`. A user-directory or fixture-write
failure therefore returned an error after changing the enquiry, with no fixture.
The sent-enquiry board then removed the actionable row on refresh.

## New boundary

`stem_spc_enquiry_with_fixture` commits the enquiry outcome and initial fixture
in one audited PostgreSQL transaction. The route prepares parser/user data before
any write. The server validates the authenticated owner, the exact saved source
version and the selected active supplier; the browser cannot supply audit identity.

A stable operation UUID plus the accepted source version and original supplier
are retained as three nullable internal columns on `spc_enquiries`. No new table,
queue or client permission is introduced. Retrying the same committed operation
returns canonical state without rewriting a pending or completed fixture. A stale
or different operation conflicts instead of overwriting it. An existing legacy
fixture is preserved and requires explicit administrator reconciliation.

The existing LOST, POSTPONE and CANCEL writers now require a sent source and the
browser's saved version, so an old tab cannot override or delete a new STEM.
Existing amendment/reoffer transactions already lock their source and require
`sent`; native concurrency tests verify that they reject after another STEM wins.

The legacy `mode: fixture` enquiry-note endpoint also requires an exact source
version and `sent` state. A held old request previously erased a new STEM's
outcome notes while leaving its typed receipt and fixture intact. It now returns
a refresh/conflict response and directs an already stemmed enquiry to its proper
Fixtures editor. No current repository UI or extension calls this legacy mode;
unknown old clients without a version fail closed with an explicit instruction.
Existing `spc-fixtures` Edit authorization is retained, not broadened.

User-row `FOR SHARE` locks preserve `is_active` and names through a new STEM's
commit. Custom supplier-trader designation and office are a validated server
directory snapshot; they are not a new page permission grant. An idempotent retry
does not require reinitializing or revalidating a historical fixture's trader.

Single-row audit undo of a STEM aggregate is blocked: restoring just the enquiry
or just the fixture would split the transaction's state. Immutable evidence stays
readable. Existing table audit triggers and backup fences remain in force.

## Verification

- `tests/spc-stem-api.test.ts`: executes the actual API/store/parser/audit headers
  with substituted infrastructure boundaries; tests authorization, source tokens,
  preparation failure, canonical names, RPC shape and HTTP error handling.
- `tests/spc-stem-native.test.mjs`: actual API plus isolated native PostgreSQL
  17.6 and the real migration/audit/backup functions. Tests late fixture failure
  rolling back enquiry, fixture, audit and backup state; lost-response retry;
  completed-fixture preservation; conflicting and same-operation concurrency;
  stale LOST/POSTPONE/CANCEL, amendment/reoffer and user-deactivation races;
  both orderings of the legacy fixture-note/STEM race and note-write rollback;
  service-only invoker privileges; partial undo rejection; native dump/restore
  preserving receipts and safe retry.
- `tests/spc-stem.browser.test.cjs`: actual SPC page/navigation/global CSS with
  synthetic session and API adapters, isolated Chromium and WebKit, widths 320,
  390 and 1440, both OS light/dark preferences. Pending controls are disabled;
  failures are visible; retry keeps its UUID/version/supplier; signed-out render
  contains no enquiry data; no horizontal overflow or unexpected network access.
  Screenshots were visually inspected for each engine/width/preference.
  SPC's admin palette is fixed light: the test does not invent a dark theme.

Browser checks are component integration, not a production sign-in or physical
iPhone/Safari test. The real route/database boundary is exercised separately by
the native suite. No production data was repaired, no email/WhatsApp message was
sent, and no hosted migration or deployment was performed for this repair.

## Release and remaining checks

Apply the additive migration before promoting the app, verify the exact Supabase
project and migration head, and retain the receipt columns on application rollback.
Older tabs without a source version/request UUID receive an explicit refresh
instruction, not a partial write. Existing broken historical STEM records are not
silently reconstructed; production occurrence/count still needs a read-only audit.

## Atomic fixture editor follow-up, 15 October

An actual fixture PATCH/native PostgreSQL repro confirmed that the old fixture
save committed supplier/price changes and then returned HTTP500 when its separate
source supplier synchronization failed. Migration
`20261015073258_atomic_spc_fixture_edits.sql` replaces that split write with one
service-only, invoker transaction. Save/completion locks the source before its
fixture, requires the exact browser fixture version and observed status, retains
all non-editable fields and original STEM receipts, and returns the committed
joined row without a fallible post-commit read. Existing normalization and
financial input rules are unchanged. A nonblank primary supplier still updates
the enquiry label; clearing fixture supplier cells still does not erase it.

Deletion now requires the exact observed version/status under the same lock
order. Pending deletion still requires the assigned supplier; existing completed
deletion eligibility is retained. Deliberate deletion intentionally leaves the
enquiry quoted and its original STEM receipt intact, matching existing behavior.
Whether the product should instead use an archive or another explicit lifecycle
is a business/design question, not permission to silently repair historical rows.
Existing quoted/no-fixture records were not touched.

Fixture drafts retain their original saved version, including after ordinary
background loading. Explicit Refresh confirms discarding local changes before
loading new drafts/versions. While a request is pending, editing, other writes,
outside-click discard and refresh are guarded. Errors remain visible above the
horizontally scrollable table and preserve the draft.
Cancelling the explicit discard prompt keeps the completed editor and its values
open; the earlier outside-pointer handler cannot discard them before the choice.

`tests/spc-fixture-native.test.mjs` executes the actual route and isolated native
database: rollback at the second source write; conflicting saves/completion;
lost-response safe refusal; STEM retry ordering; stale deletion; actor
deactivation; canonical renamed trader names; audit/backup and unchanged outbox;
partial aggregate undo refusal; exact fresh-schema parity. Source-first ordering
prevents the edit/STEM inverse lock order; it is not a claim that unrelated user
maintenance transactions cannot deadlock. PostgreSQL still aborts a deadlock
victim transaction atomically rather than committing half an edit.

Every DML also checks that the expected row was actually changed. Native fault
injection covers BEFORE triggers that silently return NULL for fixture update,
source update and deletion: these now refuse with full state/audit/epoch rollback,
not a successful acknowledgement of a suppressed or partial write.
The original STEM RPC has the same guards on its source UPDATE and fixture
INSERT, including exact generated fixture identity and source receipt/status.
Each suppression case retries with the same request UUID, remains unchanged
while the fault exists, then succeeds once and replays read-only after removal.
The API checks the returned STEM receipt, ownership, status and exact microsecond
source version before acknowledging success; timezone-equivalent versions are
accepted without losing precision. Existing case-insensitive owner identity is
preserved and has a native positive regression test.

`tests/spc-fixture-api.test.ts` is portable and included in the existing SPC CI
step. It verifies permissions, exact version/status payloads, unchanged business
normalization, protected non-editable fields, one audited RPC, plain PostgREST
error messages, removed-row conflicts, strict canonical acknowledgements and
deletion acknowledgements. The native suite separately proves transactions.

`tests/spc-fixture.browser.test.cjs` uses the actual fixture component/navigation
and global CSS with synthetic auth/API: isolated Chromium/WebKit at 320/390/1440
and both OS preferences, pending guards, visible failures, retained retry drafts,
cancelled and confirmed discard/refresh, signed-out privacy and horizontal scroll.
The closed supplier-picker stacking level alone changed 7→2 so it cannot cover the
mobile sticky DATE column; open picker/menu levels 30/31 are retained.
