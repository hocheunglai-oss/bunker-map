# CCINFO atomic country rename — 12 October 2026

This is a scoped repair, not sitewide certification. Candidate is based only on production main `f19015ea66d5e02b72c9c256ed0bbca5102a9201`; unrelated unfinished pricing changes are excluded.

## Reproduced defects and repair

The prior actual-page browser test reproduced a country name being acknowledged before a linked-port cascade failed, an error hidden behind the modal, and a same-name retry doing nothing. The replacement is one permission-checked, revision-checked database transaction. Any country/port/audit failure rolls back the entire rename. Stable-ID ports and exact old-name legacy ports are updated; ports linked to another country are never captured by their text label alone.

The dialog retains its draft and shows failures inline. Pending rename/ordinary saves serialize; duplicate submissions, navigation, deletion and accidental modal closure are guarded. Old browser country PATCHes and unbounded port-label cascades are refused. New/reparented ports with a stable country ID acknowledge the current canonical label, without replacing a newer local selection. Ordinary content changes and file references are preserved.

Both API and database block unsafe single-row audit undo of this multi-row operation. Use CCINFO Rename to reverse a rename. The function intrinsically labels all its audit rows, even when a trusted service caller supplies a different ordinary audit action.

## Verification before application rollout

- 60 focused unit/API/audit/Outlook/calendar regressions pass.
- Nine actual SQL groups pass, including injected country, first/second port and audit failures, raw microsecond versions, stale/deleted versions, duplicate and ambiguous names, legacy bypasses, ordinary undo and RPC privileges.
- Fourteen native PostgreSQL 17.6 checks pass with separate real service-role backends: both insert/reparent/delete commit orders, duplicate-name races, shared/exclusive backup fences, five-second lock timeout, and complete rollback. Independent rerun also passes.
- Actual-page isolated headless-browser groups cover normal content, stale conflicts, zero-row saves, rename failures, lost acknowledgements, pending saves, and canonical port-label acknowledgement. No personal Chrome profile, hosted business write or test email is used.
- Full TypeScript, focused lint and diff checks pass. The CCINFO page retains 28 existing lint warnings, zero errors.

The supported owner-level whole-schema/data `pg_dump` → `psql --single-transaction` rehearsal preserves exact synthetic business rows, raw versions, historical aliases, file/folder references, audit and backup marker data, effective ACLs, RLS, foreign keys and trigger definitions. Restored canonicalization is exercised. Fixture roles are reused in an owned recovery database; this is not a full production/fresh-role recovery certificate. JSON REST restores remain explicitly disabled by the existing runbook.

Hosted audit helper bodies match the fixture; production additionally pins their search paths through its existing hardening script. The audit trigger body differs only in whitespace. The rehearsal is not a claim of byte-identical hosted function definitions.

## Hosted database preflight and migration

The exact-project connector applied only `20261012111112_atomic_ccinfo_country_rename.sql`. Its SQL SHA-256 is `c38994416bd2dfa0a96b8b5fd5ab38d0042bc9b5760a934a4f4ddd9cd528cd3a`. The CLI-generated local filename was aligned with the remote-generated version without changing SQL bytes; SQL/native tests were repeated afterward.

Read-only before/after comparison retained 155 countries, 1,514 ports, 289 country audit rows and 218 port audit rows. Complete country/port row fingerprints remained identical. No business data was rewritten. Readback confirms SECURITY INVOKER, empty search path, service-only RPC execution and unchanged audit/backup/version trigger targets.

## Limits and human double-checks

- Existing PAGO PAGO is linked to AMERICAN SAMOA but displays `SAMOA, AMERICAN`. It is left unchanged pending the user's confirmation.
- Existing physical Drive folders are not moved or renamed; ID-based file links are preserved. New uploads continue using current-name folder paths.
- A future direct legacy insert containing only an obsolete text label and no country ID cannot be assigned safely by guess. Current page creation uses stable IDs; the new trigger handles cached old labels for those IDs.
- Hosted signed-in business mutation is not exercised against colleagues' records. Production rollout still requires a successful isolated production build and read-only checks before promotion.
