# Backup and Restore Runbook

Last audited: 2026-06-17

## Production backup schedule

Vercel runs `/api/backups/bunker-map-drive` every Saturday at `19:00` UTC, which is Sunday `03:00` in Hong Kong. The route writes a JSON file to Google Drive under:

```text
Bunker Map Backups / Weekly Supabase Backups
```

It keeps the latest 12 backup files.

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

## Known coverage gap

CCINFO uploaded documents are stored as file contents in Google Drive under `Manual Uploads`. The weekly Supabase backup includes their metadata, including `drive_file_id`, `drive_url`, names, paths, and soft-delete state in `cc_company_files` and `cc_entry_files`.

The weekly Supabase backup does not create an independent second copy of the actual uploaded file contents. If a Google Drive file is permanently deleted or corrupted, the database backup can restore the reference row, but it cannot recreate the file bytes by itself.

The Google Cloud file backup job is documented in [google-cloud-drive-file-backup.md](google-cloud-drive-file-backup.md). System Health shows a non-alerting `Drive File Content Backup` warning until the first Google Cloud file-backup manifest exists. After the first manifest exists, stale or failed file backups are eligible for health alert emails.

## External systems not exported by this backup

- Google Calendar remains the source for live calendar data.
- Google Contacts or CardDAV remains the source for live synced contact data where applicable.
- Microsoft Exchange remains the source for mailbox and address-book sync data outside the Supabase shared-address-book tables.
- Google Drive remains the source for uploaded CCINFO file contents until a second-copy backup is added.

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
5. If the file contents are missing from Google Drive, recover them from the future second-copy file backup once implemented.

## Next backup improvement

Deploy and run the Google Cloud file backup job. The legacy local file-backup script has been removed; dependable backups do not rely on a local machine or local OAuth token files.
