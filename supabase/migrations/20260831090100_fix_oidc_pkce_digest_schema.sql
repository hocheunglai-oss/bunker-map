-- The pgcrypto extension is installed in the dedicated extensions schema.
-- Qualify digest explicitly because this SECURITY DEFINER function intentionally
-- uses a restricted search_path that must not include extension-owned schemas.
create or replace function public.consume_oidc_authorization_code(
  p_code_hash text,
  p_client_id text,
  p_redirect_uri text,
  p_code_verifier text
)
returns table (
  admin_user_id uuid,
  client_id text,
  redirect_uri text,
  scope text,
  nonce text,
  code_challenge text,
  identity_revision bigint,
  credential_revision bigint,
  auth_time timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return query
  update public.oidc_authorization_codes as codes
  set consumed_at = clock_timestamp()
  where codes.code_hash = p_code_hash
    and codes.client_id = p_client_id
    and codes.redirect_uri = p_redirect_uri
    and codes.code_challenge = replace(
      replace(
        replace(
          encode(extensions.digest(convert_to(p_code_verifier, 'UTF8'), 'sha256'), 'base64'),
          '+',
          '-'
        ),
        '/',
        '_'
      ),
      '=',
      ''
    )
    and codes.consumed_at is null
    and codes.expires_at > clock_timestamp()
  returning codes.admin_user_id, codes.client_id, codes.redirect_uri,
    codes.scope, codes.nonce, codes.code_challenge, codes.identity_revision,
    codes.credential_revision, codes.auth_time;
end;
$$;

revoke all on function public.consume_oidc_authorization_code(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.consume_oidc_authorization_code(text, text, text, text)
  to service_role;
