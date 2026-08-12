-- User Management writes admin_users with the service-role client. The
-- attendance sync trigger resolves the user's attendance group through this
-- private invoker function, so that caller needs only this narrow EXECUTE
-- privilege. Keep it unavailable to browser-facing roles.
revoke all on function private.admin_attendance_group(jsonb, text)
  from public, anon, authenticated;

grant usage on schema private to service_role;
grant execute on function private.admin_attendance_group(jsonb, text)
  to service_role;
