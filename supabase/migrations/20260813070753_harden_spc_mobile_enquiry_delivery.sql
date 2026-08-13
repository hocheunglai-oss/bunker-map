create policy "spc_mobile_modes_service_only"
  on public.spc_mobile_modes for all to service_role using (true) with check (true);
create policy "spc_mobile_enquiry_deliveries_service_only"
  on public.spc_mobile_enquiry_deliveries for all to service_role using (true) with check (true);

create index if not exists spc_mobile_enquiry_deliveries_user_idx
  on public.spc_mobile_enquiry_deliveries(spc_user_id, created_at desc);
drop index if exists public.spc_mobile_enquiry_deliveries_message_ids_idx;
create index if not exists spc_mobile_enquiry_deliveries_prompt_message_idx
  on public.spc_mobile_enquiry_deliveries(prompt_message_id) where prompt_message_id is not null;
create index if not exists spc_mobile_enquiry_deliveries_content_message_idx
  on public.spc_mobile_enquiry_deliveries(content_message_id) where content_message_id is not null;
create index if not exists spc_mobile_enquiry_deliveries_trader_message_idx
  on public.spc_mobile_enquiry_deliveries(trader_message_id) where trader_message_id is not null;
