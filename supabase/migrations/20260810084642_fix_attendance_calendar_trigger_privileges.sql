-- Event Calendar writes use the service-role Supabase client. The attendance
-- invalidation trigger delegates projection work to private helpers whose
-- EXECUTE privilege is deliberately revoked from service_role. Run only this
-- internal trigger entrypoint as its owner so those helpers stay private while
-- Event Calendar saves can complete.
alter function private.invalidate_attendance_calendar_confirmations()
  security definer;

-- Keep the definer function insulated from caller-controlled schemas. Its body
-- already schema-qualifies every application relation and helper it uses.
alter function private.invalidate_attendance_calendar_confirmations()
  set search_path = pg_catalog, pg_temp;

-- Trigger execution does not require callers to invoke the function directly.
revoke all on function private.invalidate_attendance_calendar_confirmations()
  from public, anon, authenticated, service_role;
