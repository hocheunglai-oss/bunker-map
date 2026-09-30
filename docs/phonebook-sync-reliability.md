# Phonebook sync reliability

## Incident evidence (29 September 2026)

- FCUNO saves phonebook edits to Supabase. Delivery to phones is a separate CardDAV/Nextcloud step, not the Outlook Exchange address-book sync.
- The production directory contained 5,213 contacts, with edits saved on the incident day. The largest company contained 18 contacts.
- Recent CardDAV requests reached the production application and returned HTTP 200. The old route also returned 200 for per-contact failures without logging them, so these logs do **not** establish successful delivery.
- The provider's public status endpoint was reachable and reported maintenance disabled. This does not verify FCUNO's credentials, address-book access, or an individual phone's account configuration.
- An affected contact, exact error, and authenticated readback/device check are still needed to identify and close the reported incident. Code regression tests alone cannot prove the user's phone has received the update.

## Safeguards

- Sync is verified per contact, with explicit verified IDs and complete failure results. Partial results use HTTP 207; clients inspect the body rather than trusting HTTP success.
- Requests handle at most two contacts. Same-page requests are serialized, and retry information is saved before contacting CardDAV. A successful unrelated contact does not erase prior failures.
- Failed deletions retain their operation type. Before a deletion, the server checks that the contact is still absent from FCUNO, protecting restored contacts from stale retries.
- The server verifies the saved contact has not changed while delivery was in progress. A mismatch is left unverified for retry.
- “Resync all contacts” is an upload-only pass. It never deletes the shared address book before uploading replacements.
- vCards preserve Unicode names, fold at UTF-8 byte boundaries, and unfold server responses before verification.
- Structured failure logs include contact IDs, stage and HTTP status, but not names, addresses, credentials or upstream response bodies.
- The read-only inventory counts every direct CardDAV entry (including non-FCUNO filenames), then compares FCUNO-managed UUIDs with all saved contact IDs. Matched, missing and orphaned counts are distinct; equal totals alone never establish successful sync. Logs include bounded samples of missing/orphaned internal UUIDs, not contact details.
- After a confirmed database deletion, the browser stages the CardDAV deletion before attempting optional company removal. A company-removal failure must not cancel contact delivery or lose its retry operation.
- The AI workbench checks complete verification, batches requests, and explicitly reports unfinished delivery instead of treating a partial response as success.

## Operational limits

- The browser retry list is immediate feedback, not the only delivery mechanism. Database triggers also record contact/company changes transactionally in a service-only server queue, including deletions. Closing the page or clearing local storage does not discard that work.
- Manual writes and the background reconciler share a database lease. A busy writer returns a retryable failure rather than running a conflicting upload/deletion. The background worker reads current saved data and acknowledges only the exact queue version it processed.
- A full resync remains an upload-only pass; it never wipes the book. The separate five-minute reconciler repairs missing contacts and removes backed-up extras. A large backlog or provider outage can require multiple runs. Do not delete/recreate contacts as routine recovery.
- CardDAV readback proves server delivery, not immediate appearance on every phone. If readback is verified but a phone remains stale, inspect that phone's configured account and refresh behavior separately.

## Authoritative mirror and recoverable cleanup (30 September 2026)

The account owner explicitly requested removal of the five unmanaged cards and an exact FCUNO mirror. This dedicated address book is therefore an output of the saved FCUNO Phonebook, not a second editable master. Add/edit contacts in FCUNO; records added directly by a phone or another CardDAV client are outside the authoritative list and may be quarantined and removed.

The incident inventory showed 5,214 saved and matched IDs, zero missing/orphaned managed IDs, and five unmanaged resources: GOKSU METE, two LAM CHUN FU (CARGO OFFICER) cards, NIKOS KASOURIDIS, and Leon Green. Current and historical FCUNO writers use deterministic `bunker-map-UUID.vcf` resources with explicit FCUNO identity markers. The original writer of those five cards is **not established** by the count evidence.

A separate, reproduced flaw allowed an in-flight upload to recreate a contact after a concurrent deletion. Shared writer serialization and durable desired-state delivery address that race. Scheduled exact-ID reconciliation also detects missing/orphaned/unknown resources independently of browser activity.

The authenticated cron is `/api/cron/phonebook-carddav-reconcile`, scheduled every five minutes. It requires the existing `CRON_SECRET`, defers during a verified database backup, and has bounded execution. It does not send new reminder emails.

Cleanup safeguards:

- Obtain a complete remote inventory and stable, nonempty source ID set; repair missing authoritative cards before deleting extras.
- Restrict remote requests to direct members of the configured address book, never another origin, collection, or nested path.
- Read each proposed extra, preserve its complete vCard, strong ETag and content hash in `phonebook_carddav_quarantine`, and verify the saved backup before deletion.
- Delete conditionally using the original ETag. A changed card, incomplete inventory, unavailable database, failed backup, or unsafe large deletion set stops cleanup.
- Verify remote absence and record deletion time. Finally compare identities and total counts again; partial work is not a verified match.
- Keep quarantine inaccessible to browser roles and included in the ordinary verified database backups. Do not purge quarantine as part of the worker.

Recovery is an administrator operation: retrieve the original vCard from the service-only quarantine, review it, and preferably create the desired contact in FCUNO. Restoring an unmanaged card straight into the output book without changing the authoritative policy would cause it to be quarantined again. Never overwrite an existing remote resource blindly.

The job provides automatic convergence, not an instantaneous count guarantee on offline phones. A client with write permission can still create extras between runs. Strong prevention at the provider requires a separately verified read-only phone account and an independent writer account; do not claim those provider permissions were changed unless they were actually inspected and tested.

## Verification

Run the focused tests with `tsx --test tests/phonebook-*.test.ts`. The normal CI workflow includes these tests. The isolated browser fixture uses synthetic contacts and blocks external requests; run it with `node tests/phonebook-sync.browser.test.cjs` with Playwright available.

Before closing an incident: save a named affected contact, verify CardDAV readback, and confirm the expected details appear on the affected phone. Never report the incident fixed solely from a green request status, directory count or mock test.

## Investigating a device count difference

Refresh the inventory on the authenticated Phonebook page. Compare the returned `carddavTotalCount` with the device's count for this account, not its combined list of all accounts. `carddavOtherCount` identifies entries outside FCUNO's managed filenames; it is not evidence that names alone are duplicates. The authorized server reconciler handles these records only under the recoverable-cleanup policy above. `carddavMissingCount` and `carddavOrphanCount` compare the actual managed UUID sets. Use the bounded logged UUID samples to correlate missing/orphaned cards with the database and audit history before repairing individual records. The inventory GET never writes to either system. Matching identities establishes presence, not current field contents or the phone's local cache state.
