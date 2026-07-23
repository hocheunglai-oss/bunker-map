-- Keep truth-ledger snapshot reference checks and FK maintenance indexed.
create index if not exists outlook_exchange_truth_ledger_snapshot_idx
  on public.outlook_exchange_truth_ledger(snapshot_sha256)
  where snapshot_sha256 is not null;
