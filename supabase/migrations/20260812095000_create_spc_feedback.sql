create table if not exists public.spc_feedback (
  id uuid primary key default gen_random_uuid(),
  category text not null
    check (category in ('SUGGESTION', 'PROBLEM', 'NEW FEATURE', 'OTHER')),
  title text not null
    check (char_length(btrim(title)) between 1 and 120),
  message text not null
    check (char_length(btrim(message)) between 1 and 4000),
  area text not null default ''
    check (char_length(area) <= 80),
  status text not null default 'NEW'
    check (status in ('NEW', 'REVIEWING', 'PLANNED', 'COMPLETED', 'CLOSED')),
  admin_response text not null default ''
    check (char_length(admin_response) <= 2000),
  created_by_user_id uuid not null references public.spc_users(id) on delete restrict,
  created_by_username text not null,
  created_by_display_name text not null,
  reviewed_by_username text,
  reviewed_by_display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists spc_feedback_created_by_created_idx
  on public.spc_feedback(created_by_user_id, created_at desc);
create index if not exists spc_feedback_status_created_idx
  on public.spc_feedback(status, created_at desc);

alter table public.spc_feedback enable row level security;
revoke all privileges on table public.spc_feedback from public, anon, authenticated;
grant select, insert, update on table public.spc_feedback to service_role;

drop trigger if exists set_spc_feedback_updated_at on public.spc_feedback;
create trigger set_spc_feedback_updated_at
before update on public.spc_feedback
for each row
execute function public.set_spc_updated_at();

select public.audit_enable_table('public.spc_feedback'::regclass);

comment on table public.spc_feedback is
  'Authenticated SPC user suggestions, problem reports, feature requests, and administrator responses.';
