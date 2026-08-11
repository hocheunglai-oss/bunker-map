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
