-- Private, short-lived payload staging for imports too large for one management
-- API request. Rows are deleted immediately after the atomic import succeeds.

create table private.attendance_legacy_import_staging (
  batch_id uuid not null,
  payload_kind text not null,
  sequence_number integer not null,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (batch_id, payload_kind, sequence_number),
  constraint attendance_legacy_import_staging_kind
    check (payload_kind in ('punches', 'leaves', 'holidays', 'expected')),
  constraint attendance_legacy_import_staging_payload
    check (jsonb_typeof(payload) = 'array'),
  constraint attendance_legacy_import_staging_sequence
    check (sequence_number >= 0)
);

revoke all on table private.attendance_legacy_import_staging
  from public, anon, authenticated, service_role;
