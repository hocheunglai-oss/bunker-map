create extension if not exists "pgcrypto";

create table if not exists public.email_templates (
  id text primary key,
  title text not null,
  subject text default '',
  folder text default '',
  source_path text default '',
  sender text default '',
  to_recipients text default '',
  cc_recipients text default '',
  bcc_recipients text default '',
  body_html text default '',
  body_text text default '',
  tags text[] not null default '{}',
  slug text not null,
  is_active boolean not null default true,
  placeholders text[] not null default '{}',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists email_templates_slug_key
on public.email_templates(slug);

alter table public.email_templates enable row level security;

drop policy if exists "email_templates_read" on public.email_templates;
drop policy if exists "email_templates_write" on public.email_templates;

create policy "email_templates_read"
  on public.email_templates
  for select
  using (true);

create policy "email_templates_write"
  on public.email_templates
  for all
  using (true)
  with check (true);
