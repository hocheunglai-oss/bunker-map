begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The retired WhatsApp inbox used unconditional public policies. The current
-- application accesses these retained records only through the hosted
-- service role for backup and health inventory purposes.
drop policy if exists "whatsapp_conversations_read"
  on public.whatsapp_conversations;
drop policy if exists "whatsapp_conversations_write"
  on public.whatsapp_conversations;
drop policy if exists "whatsapp_messages_read"
  on public.whatsapp_messages;
drop policy if exists "whatsapp_messages_write"
  on public.whatsapp_messages;

revoke all privileges
  on table public.admins,
    public.whatsapp_conversations,
    public.whatsapp_messages
  from anon, authenticated;

revoke all privileges
  on sequence public.admins_id_seq
  from anon, authenticated;

commit;
