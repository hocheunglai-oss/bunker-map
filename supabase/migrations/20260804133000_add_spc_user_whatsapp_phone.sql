alter table public.spc_users
  add column if not exists whatsapp_phone text;

alter table public.spc_users
  drop constraint if exists spc_users_whatsapp_phone_check;

alter table public.spc_users
  add constraint spc_users_whatsapp_phone_check
  check (whatsapp_phone is null or whatsapp_phone ~ '^[1-9][0-9]{7,14}$');

comment on column public.spc_users.whatsapp_phone is
  'Verified WhatsApp number in E.164 digits-only format for SPC Speed Board routing.';
