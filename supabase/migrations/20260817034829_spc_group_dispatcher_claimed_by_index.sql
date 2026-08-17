create index if not exists spc_group_delivery_jobs_claimed_by_idx
  on public.spc_group_delivery_jobs(claimed_by)
  where claimed_by is not null;

drop policy if exists "spc_enquiry_revisions_no_public_access" on public.spc_enquiry_revisions;
create policy "spc_enquiry_revisions_no_public_access"
  on public.spc_enquiry_revisions
  for all
  using (false)
  with check (false);

drop policy if exists "spc_group_dispatchers_no_public_access" on public.spc_group_dispatchers;
create policy "spc_group_dispatchers_no_public_access"
  on public.spc_group_dispatchers
  for all
  using (false)
  with check (false);

drop policy if exists "spc_group_delivery_jobs_no_public_access" on public.spc_group_delivery_jobs;
create policy "spc_group_delivery_jobs_no_public_access"
  on public.spc_group_delivery_jobs
  for all
  using (false)
  with check (false);
