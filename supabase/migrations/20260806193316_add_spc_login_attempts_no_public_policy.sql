-- Make the deny-all intent explicit for the private login-attempt ledger.
-- Server-side service-role calls continue to bypass RLS as designed.

drop policy if exists "spc_login_attempts_no_public_access"
  on private.spc_login_attempts;
create policy "spc_login_attempts_no_public_access"
  on private.spc_login_attempts
  for all
  using (false)
  with check (false);
