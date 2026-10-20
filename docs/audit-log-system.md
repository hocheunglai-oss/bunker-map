# Audit Log System

The audit log is database-backed. Run `supabase/audit_log.sql` in Supabase to create:

- `public.audit_logs`
- row-level triggers for the configured application tables
- `public.undo_audit_log(...)` for restoring a captured change

## Admin Users

The existing `ADMIN_USERNAME` and `ADMIN_PASSWORD` variables still work.

For editable users and page permissions, run `supabase/admin_users.sql` and set
`SUPABASE_SERVICE_ROLE_KEY` in the server environment. The user-management screen is
available at `/admin/usermanagement`.

Database users store a salted `scrypt` password hash and one of four role
groups: `ADMIN`, `AC`, `BT`, or `VN`. Role defaults live in
`public.admin_role_defaults`. `ADMIN` always receives edit access. `AC`, `BT`,
and `VN` default to view access when a new admin page is discovered, and their
defaults can be changed in `/admin/usermanagement`. Permissions are page-based:

- `none`: page is hidden and blocked by the admin route guard
- `view`: page can be opened, but browser-side Supabase writes are blocked
- `edit`: page can be opened and edited

For multiple named users, set `ADMIN_USERS` instead. It can be JSON:

```json
[
  { "username": "alice", "password": "change-me", "displayName": "Alice", "role": "ADMIN" },
  { "username": "ben", "password": "change-me", "displayName": "Ben", "role": "AC" }
]
```

Or a compact comma-separated list:

```text
alice:change-me,ben:change-me,carol:change-me
```

## What Gets Logged

The SQL currently attaches triggers to the main app tables:

- report tables: `ports`, `price_history`, `remarks`
- country/company info: `cc_countries`, `cc_companies`, `cc_ports`, `cc_documents`, `cc_company_files`, `cc_entry_files`, `cc_entry_folders`
- phonebook: `phonebook_contacts`, `phonebook_companies`
- shared address book: `shared_addressbook_contacts`, `shared_addressbook_groups`, `shared_addressbook_group_members`
- office/template store: `office_calendar_store`, `email_templates`

Each record stores the actor, table, operation, primary key snapshot, changed fields, before row, after row, and undo status.

### SPC user-management evidence

SPC user-management events add the authenticated actor and role, trusted source
IP, controlled action, target, outcome, correlation ID and platform request ID.
Protected database triggers retain changed fields and safe before/after state.
Password hashes and other credential material are redacted.

Protected SPC user-management evidence is append-only: ordinary update, delete
and truncate operations are blocked. Permission/profile changes cannot be
partially restored through generic audit undo because that could desynchronise
the permission store from `spc_users`.

The retired ADMIN-only WhatsApp MFA test recorded challenge creation, Meta
send-request acceptance or failure, activation state, and verification outcome.
Its historical records store a masked destination and Meta message ID where
available, never the OTP, keyed hash, access token, or full phone number. These
records retain the same append-only database boundary and remain hidden from
non-ADMIN SPC audit viewers. The test page, routes and inactive test account are
not part of production login MFA; production MFA separately protects every
active SPC account enrolled with a verified WhatsApp number when the global
feature flag is enabled.

This protection does not establish an approved audit-retention period or a
central SIEM/SOC alerting process. Those remain pending Group Information
Security approval. The operational review and evidence checklist is maintained
in [`spc-security-operations-runbook.md`](spc-security-operations-runbook.md).

Shared-address-book audit rows are part of the authoritative FCUNO-to-Exchange evidence chain. After the Exchange truth-ledger migration, those rows cannot be rewritten or deleted except for the dedicated undo metadata fields. The mutable Exchange delivery queue records work state; canonical snapshots, certifications, and the append-only SHA-256 truth ledger record durable system evidence.

## Undo

Admins can use `/admin/auditlog` to inspect changes and undo a single row change. Undo never erases history: it writes a new authoritative source change, creates the corresponding Exchange queue and truth-ledger evidence, and marks the original audit record through its dedicated undo metadata.

## Browsing older changes

Audit list reads are authorized on every request. Page, displayed operation and
user filters are evaluated using the existing shared presentation rules, not an
exact database actor-id or an incomplete table-to-page approximation.

Each request scans a bounded number of raw rows in descending database timestamp
and UUID order. `Load older` continues when another matching change is proven.
`Continue searching` means the current scan reached its request budget before
proving another match or the end; an empty scan page is not an empty history.
`No matching changes` is shown only after verified exhaustion. Exact raw source
counts are used privately to account for provider row caps; they are never
presented as an exact filtered-history count. The displayed total is unknown.

This is **live keyset browsing**, not a persistent snapshot. Newly newer changes
appear after Refresh. Backdated inserts, deleted rows, Undo and changes in actor,
page or port mapping can affect later reads. Observed classification-map changes
invalidate the cursor and require Refresh. A changed deployment commit also
invalidates the browse generation. List classification maps are read
through the same bounded, provider-cap-aware transport; legacy detail presentation
retains its existing independent behavior. Filter/account/permission changes and successful Undo reset
the browse generation. Only the visible page and at most 20 previous cursor
positions are kept in the browser; Refresh returns to the newest records.

List browsing requires the dedicated **server-only Secret**
`AUDIT_BROWSING_CURSOR_KEYS_JSON`. It is never a `NEXT_PUBLIC_` variable and must
not reuse a service key, session token, signing key, webhook or cron secret.
Its shape is an `activeKid` string and a `keys` array containing one or two
objects with `kid` and `keyBase64url`; each key is an independently provisioned,
canonical unpadded base64url encoding of exactly 32 random bytes. Do not commit a
real value. Missing or malformed configuration returns a private 503 unavailable
response; there is no insecure or silently truncated fallback. Existing detail
and Undo endpoints do not depend on this cursor key.
Use environment-scoped Secret values: Production and non-Production must not
share a key. Instances within the same environment need the same keyring for
reliable continuation; provisioning is a separate verified release step.

AES-256-GCM cursors hide raw scan positions and are bound to the current verified
viewer, permissions, scope, filters and page size. They expire 15 minutes after
the initial generation; continuation does not extend that lifetime. Invalid,
tampered, expired or mismatched cursors return one restart-required 400 message.
Rotation first deploys readers accepting both keys, then switches `activeKid`,
and retains the previous key for the cursor lifetime plus 30 seconds clock skew
and deployment overlap. Removing an old key requires Refresh, not a new login.

Each isolated audit-read transport limits decompressed response bytes before SDK
JSON parsing and applies one request deadline. Overflow, timeout, inconsistent
counts or missing required enrichment return retryable unavailable without
advancing the cursor. Only existing authorized index fields are returned.
Ordinary index reads use two service-only, immutable, security-invoker computed
JSON fields. They preserve SQL NULL, JSON null, empty objects, scalar/array types
and every original key, except `body_html` and `body_text` are omitted from JSON
objects belonging to `public.email_templates`. Those fields are not used for
index classification or summary; list presentation does not compute detail
text. Original stored audit rows, lazy `?id=` details and Undo are unchanged.

Admin `details=1&browse=1` explicitly opts into **bounded paged full mode**:
each request examines at most one raw audit row, retaining original
large fields and the full presenter. It may return zero or one authorized row
with `scan-pending`; only the exact remaining source count proves exhaustion.
Continue with its cursor, or use ordinary index mode for browsing. Full/index
cursors cannot be interchanged. Keep `browse=1` on continuation requests. An oversized single full row returns unavailable
without a cursor advance or skip. Both modes retain the same 4 MiB per-response,
8 MiB combined transport budget and eight-second audit-data deadline.

Bare legacy `details=1` remains the production-compatible capped recent-list
contract used by CCINFO and Outlook Address Book activity cards. It retains its
existing permission gate, table candidate filters, limit, full raw presenter and
user options; it is not complete history pagination and does not claim the new
transport/time budgets. It has no dedicated cursor-key dependency. Passing a
cursor without `browse=1` returns a restart-required 400 before audit reads,
rather than silently accepting or ignoring a new-protocol cursor. Those two
existing activity-feed pages are unchanged.

The additive computed-field migration must be applied and its PostgREST schema
cache refreshed before index code is promoted. Browser roles have no computed-
field execution grant, and no RLS policy or stored audit history is changed.
Exact source counts and other retained large values can still cost more than
index-only reads; deployment requires measured transport/database verification
rather than a claim of constant-time whole-history filtering.
