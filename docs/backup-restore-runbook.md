# Backup and Restore Runbook

Last audited: 2026-06-18

## Production backup schedule

Vercel runs `/api/backups/bunker-map-drive` every Saturday at `19:00` UTC, which is Sunday `03:00` in Hong Kong. The route writes a JSON file to Google Drive under:

```text
Bunker Map Backups / Weekly Supabase Backups
```

It keeps the latest 2 backup files. An authorized administrator can also create one immediately from System Health using `BACK UP NOW`.

## What the weekly Supabase backup covers

The hosted weekly backup currently exports these Supabase tables:

- `admin_users`
- `admin_role_defaults` when the optional table exists
- `audit_logs`
- `office_calendar_store`
- `email_templates`
- `shared_addressbook_contacts`
- `shared_addressbook_groups`
- `shared_addressbook_group_members`
- `outlook_exchange_sync_queue`
- `phonebook_contacts`
- `phonebook_companies`
- `cc_companies`
- `cc_countries`
- `cc_ports`
- `cc_documents`
- `cc_company_files`
- `cc_entry_files`
- `cc_entry_folders`
- `ports`
- `remarks`
- `price_history`

This covers the app database state used by the map, price history, Taiwan report remarks, admin users, email templates, shared address book, phonebook, CCINFO records, and CCINFO file metadata.

The same JSON also includes point-in-time API exports named `googleContacts` and `googleCalendarEvents`.

## File-content backup

CCINFO uploaded documents are stored as file contents in Google Drive under `Manual Uploads`. The weekly Supabase backup includes their metadata, including `drive_file_id`, `drive_url`, names, paths, and soft-delete state in `cc_company_files` and `cc_entry_files`.

The weekly JSON cannot recreate file bytes by itself. The independent Google Cloud Storage copy is documented in [google-cloud-drive-file-backup.md](google-cloud-drive-file-backup.md), and its latest manifest is monitored by System Health.

## External-system limits

- Google Calendar and Google Contacts remain the live sources, but their current records are exported into the weekly JSON.
- CardDAV contacts are represented by the backed-up phonebook data that drives synchronization.
- Microsoft Exchange remains the source for mailbox and address-book sync data outside the Supabase shared-address-book tables.
- Google Drive remains the live source for CCINFO files; Google Cloud Storage is the independent second copy.

## Non-destructive validation

Before any restore, validate the downloaded JSON locally:

```bash
npm run backup:validate -- /absolute/path/to/bunker-map-backup.json
```

The validator performs no writes. It checks required sections, declared counts, duplicate IDs, major foreign-key relationships, and active CCINFO file references.

## Restore outline

1. Download the latest `bunker-map-backup-*.json` from Google Drive.
2. Confirm `generatedAt`, `counts`, and `warnings`.
3. Restore Supabase tables from the `data` object in dependency order:
   - base admin and app tables first: `admin_users`, `office_calendar_store`, `email_templates`, `ports`, `remarks`, `price_history`
   - CCINFO base records: `cc_companies`, `cc_countries`, `cc_ports`, `cc_documents`
   - dependent CCINFO records: `cc_company_files`, `cc_entry_files`, `cc_entry_folders`
   - phonebook and address book records: `phonebook_companies`, `phonebook_contacts`, `shared_addressbook_contacts`, `shared_addressbook_groups`, `shared_addressbook_group_members`
   - operational logs and queues: `audit_logs`, `outlook_exchange_sync_queue`
4. For CCINFO uploaded documents, use the restored `drive_file_id` values to verify that files still exist in Google Drive.
5. If file contents are missing from Google Drive, recover the matching object/version from Google Cloud Storage.
6. Restore first into a separate Supabase recovery project. Validate row counts and application workflows before considering any production replacement.
