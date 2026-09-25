-- DingTalk's rest calendar is not FCUNO's attendance calendar. Retain the
-- actual machine scan with no invented IN/OUT label; FCUNO derives display
-- times using its own team schedule, leave and manual corrections.
set local lock_timeout = '3s';
set local statement_timeout = '15s';

alter table public.attendance_raw_punches
  drop constraint attendance_raw_punches_check_type,
  add constraint attendance_raw_punches_check_type check (
    check_type in ('OnDuty', 'OffDuty')
    or (
      check_type = 'Unclassified'
      and coalesce(
        source_type = 'ATM'
        and raw_payload->>'normalizationReason' = 'dingtalk-rest-day'
        and raw_payload->>'invalidRecordType' = 'Other'
        and raw_payload->>'invalidRecordMsg' = '今日休息，打卡需申请'
        and raw_payload->>'checkType' is null,
        false
      )
    )
  );

comment on column public.attendance_raw_punches.check_type is
  'Source direction, or Unclassified for an explicitly identified DingTalk rest-day machine punch. FCUNO derives attendance at read time; source rows stay append-only.';

-- Existing RLS, service-role-only insert RPC, append-only trigger, source
-- identity uniqueness and manual-override constraints are unchanged.
