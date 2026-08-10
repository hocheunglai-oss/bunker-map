-- Keep the enrolled phone fingerprint private to the database row. The public
-- migration history must validate only its shape, not publish a fixed digest
-- derived from a user's phone number.

alter table private.spc_whatsapp_login_mfa_enrollment
  drop constraint if exists spc_whatsapp_login_mfa_enrollment_phone_hash;

alter table private.spc_whatsapp_login_mfa_enrollment
  add constraint spc_whatsapp_login_mfa_enrollment_phone_hash
    check (whatsapp_phone_hash ~ '^[0-9a-f]{64}$');
