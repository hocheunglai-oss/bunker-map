# FCUNO calendar reliability repairs

Event Calendar and Task Calendar received targeted reliability repairs on 7 October 2026. The changes preserve existing event conflict checks, the durable Google sync queue, permissions, manual holidays, attendance assignments and deliberate deletions. Production release and live holiday reconciliation require separate verification; passing local tests is not proof of a completed live release.

## Task Calendar

- Clicking a row highlights it. Keyboard selection, horizontal scrolling and View access work without writing data.
- Saves wait for server confirmation. Failed or conflicting saves retain the draft.
- Per-task version checks prevent stale tabs from overwriting newer work. Deleted tasks cannot return through a stale save. Old whole-list clients must reload.
- Empty storage stays empty; read failures no longer revive bundled tasks or send reminders for defaults.
- Recurrence and recipient validation reject incomplete schedules, invalid day lists and unresolved staff.
- Staff addresses come from active User Management and Attendance identities, including DT and JZ.
- Due dates use Hong Kong time. Durable delivery records prevent repeated runs from resending an already accepted task occurrence.
- Audit Log snapshot undo is blocked for the versioned task store. Corrections use the current per-task editor.

## Event Calendar

- Changing From preserves an existing valid To date in event, recurring-event and leave forms.
- Meeting-room checks and Google publication share the same intervals, including overnight and multi-day bookings. All-day end dates display correctly.
- Google lists read every page and stop with an error if pagination cannot complete safely.
- Recurring creation offers one email question after the batch is saved. Messages use current server records; stale prompts are rejected.
- Email-list validation checks every address. A deliberately empty list disables change notifications without silently using a fallback. Daily reminders remain separately configured and are labelled accordingly.
- Leave requests validate real dates, date order, leave type and the applicant's active email address.
- Recovery filters Event Calendar history before pagination, preserves deletion markers, and reports whether its bounded history search is complete.
- Page loading is read-only. Holiday imports require an explicit preview and apply, with Edit permission on the server.

## Holiday correction preview

The verified reference covers 2026 and 2027: Hong Kong general holidays, Singapore observed public holidays, US Bank Holidays following Federal Reserve Banks and Branches, and Taiwan government-office named holidays and substitute days. The owner confirmed the US bank and Taiwan government-office scopes on 7 October. The Federal Reserve bank calendar keeps Saturday holidays on Saturday and observes Sunday holidays on Monday. This reference does not promise that individual US bank branches or Taiwan private employers follow the same closures.

The current preview of the 298-event snapshot proposes 40 Taiwan additions, 67 updates and 10 removals, giving 328 events. Updates correct labels and attach verified-source information. Seven existing US manual entries receive explicit bank-calendar labels, including moving Independence Day from 3 to 4 July 2026 with its existing ID retained. Removals are two obsolete Singapore dates, six US regional holidays outside the bank reference, and two imported Christmas duplicates already covered by a combined manual entry.

The other manual holidays and all attendance assignments remain unchanged. The resulting calendar covers all 124 official country/date pairs. A second in-memory reconciliation proposes no writes and no unresolved manual corrections. These are preview results; the live apply is tracked separately from the deployment.

Reconciliation changes only positively identified, untouched imported records. Manually edited entries, people assignments, deliberate deletions and combined country entries are preserved. Ambiguous entries require review. Preview and apply use one version-checked transaction, so a changed calendar cannot receive a stale partial correction.

Sources: [Hong Kong 2026](https://www.info.gov.hk/gia/general/202505/16/P2025051300353.htm), [Hong Kong 2027](https://www.info.gov.hk/gia/general/202605/15/P2026051400300.htm), [Singapore 2026](https://www.mom.gov.sg/newsroom/press-releases/2025/0616-public-holidays-for-2026), [Singapore 2027](https://www.mom.gov.sg/newsroom/press-releases/2026/0618-public-holidays-for-2027), [Taiwan 2026](https://www.dgpa.gov.tw/information?pid=12574&uid=82), [Taiwan 2027](https://www.dgpa.gov.tw/information?pid=12983&uid=2), and [US Federal Reserve Bank holidays](https://www.federalreserve.gov/aboutthefed/k8.htm).

## Verification

The latest focused run passed 104 calendar, recipient, delivery, recovery and persistence tests and 169 security regression tests, including malicious source-map inputs and ordinary PNG/SVG conversion. The production dependency audit reports zero vulnerabilities. The earlier full verification passed 138 attendance tests and two editing-caret checks. Isolated browser tests passed five Event Calendar scenario groups and eight Task Calendar groups. The database undo guard passed five isolated PostgreSQL checks. Full TypeScript, changed-file lint and the production build passed. Local build data-prefetch warnings reflect stale local credentials, not a verified production outage. No test sent real email or changed live attendance, events or Google Calendar; personal browser tabs were not used. The separately authorized live CY identity correction is described below.

Both dependency patches and the US Bank holiday scope are approved. The Task Calendar undo guard is applied in FCUNO under migration version 20261007115435. Production deployment and the version-checked live holiday correction are the remaining release steps.

Independent reviews covered Task Calendar persistence and permissions, holiday reconciliation and atomic batching, dates and Google boundaries, delivery receipts, and recovery pagination. Tests include simultaneous writers, lost responses, deleted aliases, malformed recipients, partial email acceptance, database failures and bounded recovery histories.

## Confirmation and maintenance

- The owner confirmed CL and CY are the same person. The existing live account now displays CY and is linked to the existing CY attendance person. A guarded transaction verified unchanged credentials, permissions, access flags, attendance details and all rows across ten attendance-history tables, including seven monthly confirmations. The correction is recorded in Audit Log. The normal FCOS identity delivery accepted CY on 7 October at 19:05 Hong Kong time. SPC retains the correct full name CHENGYUAN LI; historical audit labels and the unrelated Credit Limit abbreviation CL remain unchanged. Event and Task Calendar data contain no remaining exact CL staff value.
- Calendar staff lookup now uses the canonical attendance account link without a Chengyuan-specific email fallback. Regression tests cover CY appearing once, the old CL label during transition, changed email addresses, and invalid or inactive links. This code change is part of the unreleased calendar patch; the live account and attendance linkage correction is already complete.
- USA uses US Bank Holidays following Federal Reserve Banks and Branches. The settings review button and imported entries identify this scope. Friday 3 July 2026, Friday 18 June 2027, Friday 24 December 2027 and Friday 31 December 2027 are not bank-calendar closures. Sunday Independence Day 2027 is observed Monday 5 July. See the [Federal Reserve holiday schedule](https://www.federalreserve.gov/aboutthefed/k8.htm).
- Holiday references after 2027 are not yet verified. The interface reports unavailable coverage instead of claiming readiness or inventing dates.
- Mail acceptance and recording cannot be perfectly atomic across the mail server and database. If delivery is uncertain, automatic resending pauses to avoid duplicates and an administrator must check Sent Items. This is not reported as successful delivery.
- Sharp is updated to 0.35.5, with its matching native packages and libvips 1.3.4; loaded librsvg is 2.63.2. source-map-js is updated to 1.2.2. Existing consumer version ranges accept both patches. Regression checks reject unsafe and nested source-map offsets while preserving normal mappings, and verify ordinary PNG/SVG conversion. The Sharp memory exploit itself is not reproduced; verification uses the fixed native-library version and image-conversion controls. See the [Sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) and [source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
- Synthetic tests do not exercise live mail delivery or authenticated external Google access. Production verification must distinguish read-only service checks from an actual delivery test.
