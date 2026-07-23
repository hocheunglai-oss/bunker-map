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
  revision bigint not null default 1,
  recipient_resolution jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint email_templates_revision_positive check (revision > 0),
  constraint email_templates_slug_key
    unique (slug)
    deferrable initially deferred
);

-- The empty JSON default is only a schema-bootstrap placeholder. The recipient
-- truth migrations convert populated legacy rows to reconciliation-required
-- evidence, then enforce the exact certified v1 structure before writes resume.
alter table public.email_templates
  add column if not exists revision bigint,
  add column if not exists recipient_resolution jsonb
    not null
    default '{}'::jsonb;

update public.email_templates
set revision = 1
where revision is null;

update public.email_templates
set recipient_resolution = '{}'::jsonb
where recipient_resolution is null;

alter table public.email_templates
  alter column revision set default 1,
  alter column revision set not null,
  alter column recipient_resolution set default '{}'::jsonb,
  alter column recipient_resolution set not null;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.email_templates'::regclass
      and conname = 'email_templates_revision_positive'
  ) then
    alter table public.email_templates
      add constraint email_templates_revision_positive
      check (revision > 0);
  end if;
end;
$$;

create unique index if not exists email_templates_slug_key
on public.email_templates(slug);

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.email_templates'::regclass
      and conname = 'email_templates_slug_key'
  ) then
    alter table public.email_templates
      add constraint email_templates_slug_key
      unique using index email_templates_slug_key
      deferrable initially deferred;
  end if;
end;
$$;

alter table public.email_templates enable row level security;

drop policy if exists "email_templates_read" on public.email_templates;
drop policy if exists "email_templates_write" on public.email_templates;
revoke all on public.email_templates from public, anon, authenticated;
grant select, insert, update, delete on public.email_templates to service_role;
