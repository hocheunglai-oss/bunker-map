# FCUNO sitewide debug — follow-up candidate, 13 October 2026

Status: locally tested; not released. Production still uses commit `2325abb6f0e25cf74b91b2b06f5f901712df359d`. This is a bounded continuation, not certification that the whole site is bug-free.

## Country renaming and pricing first

The previously released atomic country-renaming and coherent pricing/public-report flows were rechecked. Country/pricing TypeScript checks, actual SQL, native PostgreSQL concurrency/restore exercises, and 66 isolated browser groups passed. No pricing runtime, formula, history, or report-date policy is changed in this follow-up.

Otto confirmed these rules on 13 October:

- A blank fuel price means unavailable.
- Saving/deleting a Taiwan day affects both Taiwan basis ports.
- Reports use the saved quote date, not automatically today's date.
- PAGO PAGO's displayed country should be AMERICAN SAMOA.

Read-only hosted preflight found exactly one PAGO PAGO row: its country ID already points to AMERICAN SAMOA, but its May 2026 label remains SAMOA, AMERICAN. The repair is one explicitly approved label correction, not a country rename. The reviewed transaction is [approved-pago-pago-label-repair-2026-10-13.sql](approved-pago-pago-label-repair-2026-10-13.sql). It is not automatically executed or a database migration. Apply only after the application Undo guard is released, with fresh canonical project verification. Exact old IDs, names and microsecond versions must still match; otherwise stop and re-review. Verify returned content, a truthful audit record and backup transaction marker before commit.

Generic database Undo cannot meaningfully restore an alias that contradicts its linked country: the existing canonicalization trigger restores the canonical label. The new application guard therefore keeps this correction's history visible but disables misleading Undo. It uses the exact persisted maintenance marker, not a spoofed country-rename action. Application endpoints and generic-proxy denial are tested; trusted direct service-role RPC access is not database-blocked by this application-only guard.

## Confirmed defects fixed in this candidate

- Optional browser storage failures no longer falsely sign out a valid FCUNO/SPC server session or break navigation. Failed login requests permit retry; SPC logout waits for server acknowledgement.
- Attendance confirmation cannot reload an old year's data under a newly selected year. Automatic confirmation additionally enforces the promised 18:00 HKT deadline.
- Event Calendar recipient/people, recurring-event and leave-request editors cannot accept then discard a newer draft while an earlier save/send is pending.
- Phonebook edits require an acknowledged saved row. New-contact retries reuse their draft identity rather than creating another contact after a lost reply. Ordinary edits preserve favourites. Older sync completion cannot acknowledge a newer unsaved/pending edit.
- CardDAV count checks reject incomplete inventories and distinguish canonical managed cards from aliases.
- An ambiguous Azure trigger reply preserves the worker reservation instead of revoking a possibly running job's lease and falsely reporting failure.
- Approved country-label normalization cannot offer a misleading application Undo.
- Builds no longer depend on a fresh Google font response. The exact previously used Roboto bytes are bundled with their redistribution license; weights, multilingual coverage and fallback metrics are retained. Both FCUNO and SPC serve the pinned assets with immutable caching and a single Latin preload.

Nineteen runtime/configuration files and nine pinned font binaries plus their license are changed. No package/lockfile, database schema, permissions, federation contract, pricing runtime, real contact list, email recipients, Azure runbook, or provider configuration is changed. The font routing exemption contains only the nine exact asset paths and license; ordinary SPC and China page routing remains unchanged.

## Verification

| Check | Result |
| --- | --- |
| Distinct TypeScript unit/API checks | 714 passed: original 706 plus 8 font/routing checks; 0 failed/skipped |
| Isolated browser behavioural groups across this batch | 154 passed |
| Country/pricing actual SQL/PGlite | 94 passed |
| Country/pricing native PostgreSQL 17.6 | 28 passed |
| Final production build | passed; 108 generated pages |
| Final full TypeScript check | passed |
| Scoped lint | 0 errors; 19 existing warnings |
| Immutable FCUNO–FCOS contract | unchanged; verification passed |
| Independent changed-runtime reviews | passed |
| Whitespace review and evidence source hashes | passed; exact upstream license whitespace intentionally retained |
| Actual built-server font/cache/routing checks | 3 groups passed on both hosts, including China visitor routing |

Browser/database mutations were synthetic and loopback-only. Owned headless contexts and servers were closed; personal Chrome was not attached or controlled. No live sync, external job, outbound email or test business-data edit was performed.

Credential-free local builds used an unreachable local database placeholder or no public database configuration; the expected homepage fallback warnings do not certify hosted data loading. Hosted read-only release verification and current CI results must be recorded separately before claiming a live fix.

The initial PR53 hosted build failed inside Next's Google font loader. An extensionless font URL reproduces that loader exception, but the exact failed hosted response URL was not retained and is not claimed proven. Self-hosting removes the failing external loader path without changing font bytes. Independent review also caught and corrected SPC's rewrite of the new font paths before release; actual built-server tests now cover both hosts, one preload, hashes, cache and unchanged security headers.

Pre-release anonymous GET verification of existing production passed 58 functional/status checks across both origins. All four public report payloads validated and matched between origins; report dates were Taiwan 13 October, Hong Kong/China 12 October, Compact 7 October, as saved. FCUNO-only page paths intentionally return 404 on the SPC host. Ten anonymous denial responses lack explicit private/no-store headers; no private data was returned, but this pre-existing hardening remains open and is not certified by the functional pass.

## Release gate and items needing attention

An existing high-severity `braces` advisory (GHSA-vfj7-8cjw-p6xm) remains in the ESLint development dependency chain, with no compatible published fixed version at review time. Otto explicitly approved a conditional one-time release exception on 13 October after a plain-language explanation: resolve the font issue and pass all other checks, while retaining the warning. The exception covers only that advisory, not another finding or failure. All audit gates remain unchanged and must rerun on the final head; the production audit must pass. See [approval record](sitewide-release-exception-2026-10-13.json). This is not suppression, remediation, a claim of harmlessness or an ongoing bypass.

PR53 also reported a name-based cleartext-storage warning on a reset-status display boolean, not a password. The cache serializes an explicit display-metadata whitelist; the follow-up makes its boolean literal explicit. Independent browser checks verify unexpected synthetic password/token response fields are not cached. No scanner suppression or finding dismissal was made; current exact-head CodeQL checks must pass before release.

Production data preflight (13 October 02:08:55 UTC): 76 price ports, 1,909 history records, 8 remarks, 155 CCINFO countries, 1,514 CCINFO ports, 5,127 Phonebook contacts. The read-only snapshot's price/history/remarks hashes are retained in the release evidence; business users may legitimately change records afterward.

Remaining uncertainties, not claims of completion:

- The old five extra phone contacts have not been removed or causally attributed by this batch.
- Live Azure/Exchange/CardDAV/device delivery is not certified. Azure worker backlog alert classification and minimalist email redesign remain unfinished; the trigger fix does not solve every noisy alert.
- Event Calendar missing-row fallback seed editing and feature-cache storage faults remain follow-up work. Local 2026–2027 holiday references were last source-reviewed on 7 October; this batch tests their logic, not a fresh recertification of every official date.
- Ordinary concurrent Phonebook edits still use existing last-writer-wins behavior. Company/archive/Undo acknowledgements and related creation retry paths need further examination.
- Attendance annual confirmation still shares December storage, and the automatic job still has no next-day catch-up after a whole-day missed run.
- Tokyo's historical blank row and later positive quote remain preserved; no unapproved history cleanup was performed.

## Detailed evidence

- [Attendance](sitewide-attendance-followup-2026-10-12.json)
- [Event and Task Calendar](sitewide-calendars-followup-2026-10-12.json)
- [Shared browser/session behaviour](sitewide-client-session-followup-2026-10-13.json)
- [Phonebook and Outlook/Exchange](sitewide-contacts-followup-2026-10-12.json)
- [Approved country-label correction and Undo safeguard](sitewide-approved-country-label-normalization-2026-10-13.json)
- [Read-only production baseline](sitewide-followup-live-baseline-2026-10-13.json)
- [Pinned font provenance, parity and delivery](sitewide-font-self-hosting-2026-10-13.json)
- [Conditional one-time development-tool exception](sitewide-release-exception-2026-10-13.json)

The user's dirty primary checkout and earlier frozen releases were not staged or deployed. Release work uses a separate checkout based on the exact live commit. Supabase/React/release guidance informed the isolated end-to-end checks and narrow, reviewed changes.
