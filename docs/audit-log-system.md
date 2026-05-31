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

Database users store a salted `scrypt` password hash, a free-form role name,
and a JSON permission map. The role name `admin` is special: it always receives
edit access. Other role names default to view access when a new admin page is
discovered. Permissions are page-based:

- `none`: page is hidden and blocked by the admin route guard
- `view`: page can be opened, but browser-side Supabase writes are blocked
- `edit`: page can be opened and edited

For multiple named users, set `ADMIN_USERS` instead. It can be JSON:

```json
[
  { "username": "alice", "password": "change-me", "displayName": "Alice", "role": "admin" },
  { "username": "ben", "password": "change-me", "displayName": "Ben", "role": "editor" }
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

## Undo

Admins can use `/admin/auditlog` to inspect changes and undo a single row change. Undo itself creates another audit record and marks the original record as undone.
