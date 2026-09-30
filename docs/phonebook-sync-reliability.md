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

- The retry list is local to the browser, not a durable server-side background job. Keep the page open during a sync. After interruption, return to the same browser and use **Retry Failed**; clearing browser storage loses that retry list, not the saved FCUNO contact data.
- Other browsers/devices do not share the retry list. Concurrent edits in separate browsers are not protected by a global database lock; a detected source change requires retry.
- A full resync can take time for a large directory and does not remove orphaned remote cards. Use a selected-company sync for an affected company first. Do not delete/recreate contacts as routine recovery.
- CardDAV readback proves server delivery, not immediate appearance on every phone. If readback is verified but a phone remains stale, inspect that phone's configured account and refresh behavior separately.

## Verification

Run the focused tests with `tsx --test tests/phonebook-*.test.ts`. The normal CI workflow includes these tests. The isolated browser fixture uses synthetic contacts and blocks external requests; run it with `node tests/phonebook-sync.browser.test.cjs` with Playwright available.

Before closing an incident: save a named affected contact, verify CardDAV readback, and confirm the expected details appear on the affected phone. Never report the incident fixed solely from a green request status, directory count or mock test.

## Investigating a device count difference

Refresh the inventory on the authenticated Phonebook page. Compare the returned `carddavTotalCount` with the device's count for this account, not its combined list of all accounts. `carddavOtherCount` identifies entries outside FCUNO's managed filenames; do not assume they are duplicates or delete them. `carddavMissingCount` and `carddavOrphanCount` compare the actual managed UUID sets. Use the bounded logged UUID samples to correlate missing/orphaned cards with the database and audit history before repairing individual records. The inventory never writes to either system. Matching identities establishes presence, not current field contents or the phone's local cache state.
