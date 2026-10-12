-- Contract phase: deploy the reviewed owned-creation page/API with the additive
-- recovery migration, drain old requests, then revoke the unowned allocator.
-- Do not release a workflow that leaves this duplicate-allocation bypass open.
-- Retain the function and historical receipts for audit/restore compatibility.
revoke all on function public.create_price_setter_port(uuid,text)
  from public,anon,authenticated,service_role;
