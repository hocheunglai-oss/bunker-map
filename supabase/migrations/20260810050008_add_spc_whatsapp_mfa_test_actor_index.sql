-- Cover administrator-bound challenge status and verification lookups.
create index if not exists spc_whatsapp_mfa_test_actor_created_idx
  on private.spc_whatsapp_mfa_test_challenges(
    created_by_user_id,
    created_at desc
  );
