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

The verified reference covers 2026 and 2027: Hong Kong general holidays, Singapore observed public holidays, USA federal observed holidays, and Taiwan government-office named holidays and substitute days. Ordinary weekends are not imported. Taiwan's reference does not declare private employers closed on every government-office holiday.

The independent preview of the live 298-event snapshot proposes 41 additions, 60 updates and 10 removals, giving 329 events. Additions are 40 Taiwan entries and the USA observed New Year holiday on 31 December 2027. Updates correct labels and attach verified-source information. Removals are two obsolete Singapore dates, six US nonfederal holidays, and two imported Christmas duplicates already covered by a combined manual entry.

All 22 manual holiday records remain byte-for-byte unchanged, with no attendance assignment changes. The resulting calendar covers all 125 official country/date pairs without missing, extra or duplicate pairs. A second in-memory reconciliation proposes no writes and no unresolved manual corrections. These are preview results, not confirmation that production data has been changed.

Reconciliation changes only positively identified, untouched imported records. Manually edited entries, people assignments, deliberate deletions and combined country entries are preserved. Ambiguous entries require review. Preview and apply use one version-checked transaction, so a changed calendar cannot receive a stale partial correction.

Sources: [Hong Kong 2026](https://www.info.gov.hk/gia/general/202505/16/P2025051300353.htm), [Hong Kong 2027](https://www.info.gov.hk/gia/general/202605/15/P2026051400300.htm), [Singapore 2026](https://www.mom.gov.sg/newsroom/press-releases/2025/0616-public-holidays-for-2026), [Singapore 2027](https://www.mom.gov.sg/newsroom/press-releases/2026/0618-public-holidays-for-2027), [Taiwan 2026](https://www.dgpa.gov.tw/information?pid=12574&uid=82), [Taiwan 2027](https://www.dgpa.gov.tw/information?pid=12983&uid=2), and [USA federal holidays](https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/).

## Verification

The focused run passed 102 calendar, recipient, delivery, recovery and persistence tests, plus 138 attendance tests and 167 general security regression tests. Isolated browser tests passed five Event Calendar scenario groups and eight Task Calendar groups. The database undo guard passed five isolated PostgreSQL checks. Full TypeScript, changed-file lint and the production build passed. Local build data-prefetch warnings reflect stale local credentials, not a verified production outage. No test sent real email or changed live attendance, events or Google Calendar; personal browser tabs were not used.

Production release remains on hold for permission to include the two unrelated dependency security updates required by the release audit. The calendar migration and live holiday changes have not been applied.

Independent reviews covered Task Calendar persistence and permissions, holiday reconciliation and atomic batching, dates and Google boundaries, delivery receipts, and recovery pagination. Tests include simultaneous writers, lost responses, deleted aliases, malformed recipients, partial email acceptance, database failures and bounded recovery histories.

## Confirmation and maintenance

- CY in the calendar corresponds to an active User Management account labelled CL at chengyuan@cosulich.com.hk. Existing routing is preserved pending confirmation that these are the same person. No account is relinked or renamed automatically.
- USA defaults to federal observed holidays. State holidays require an explicit choice and clear regional labels.
- Holiday references after 2027 are not yet verified. The interface reports unavailable coverage instead of claiming readiness or inventing dates.
- Mail acceptance and recording cannot be perfectly atomic across the mail server and database. If delivery is uncertain, automatic resending pauses to avoid duplicates and an administrator must check Sent Items. This is not reported as successful delivery.
- The dependency audit separately reports existing high-severity warnings in Sharp and source-map-js. These packages are unchanged by this calendar repair and need a separate dependency review.
- Synthetic tests do not exercise live mail delivery or authenticated external Google access. Production verification must distinguish read-only service checks from an actual delivery test.
