# Attendance imports independent of DingTalk's rest calendar

FCUNO's team schedules, leave, Event Calendar holidays and manual corrections
are authoritative. DingTalk supplies actual machine-punch timestamps; its rest
calendar must not suppress attendance on an FCUNO working day.

The importer accepts the verified exception `sourceType=ATM`,
`invalidRecordType=Other`, `invalidRecordMsg=今日休息，打卡需申请` only when the
source direction is absent. It stores `Unclassified`, the unchanged timestamp,
and the upstream reason. Unknown users, invalid timestamps, security failures,
second-confirmation failures and other unlabelled records remain rejected.
Normal labelled records retain their existing behavior.

Directions are derived when reading, never written back into raw source rows:

- Normal day: earliest unclassified scan before 17:00 HKT is IN; latest scan at
  or after 17:00 is OUT. A lone morning punch never fills OUT.
- PM leave: the historical team's AM cutoff replaces the 17:00 boundary.
  OUT requires a separate earlier arrival before that cutoff. Ambiguous scans
  remain unclassified for an administrator to review.
- Exclusions are applied first; manual replacements retain priority. HK
  holidays, weekends, AM leave, HOME/OS and attendance totals remain governed
  by the existing FCUNO rules, not DingTalk's calendar.

Raw rows remain append-only and deduplicated by source identity. Existing
manual-edit directions remain OnDuty/OffDuty. No browser-role database grants,
new tables, DingTalk settings or attendance dates are changed by this fix.

## Release and recovery

Apply the `allow_attendance_rest_day_machine_punches` migration before deploying
the application. It only expands the raw-punch constraint with provenance checks
and short lock/statement timeouts. The existing service-role insert RPC handles
the new type unchanged. Leave the additive constraint in place on an application
rollback; do not delete recovered scans or force them into an invented direction.

The regular sync scans the current HKT day and six preceding days. After release,
use the existing audited admin sync action (or the next 15-minute cron) to recover
eligible source records. Verify sync success, exact source-time preservation,
deduplication on a repeat sync, and daily/monthly attendance output. No synthetic
sign-outs or handwritten attendance overrides are needed.

## Verification

Run attendance and DingTalk tests with `NODE_OPTIONS=--conditions=react-server`
to include the pure daily-builder integration tests from the server-only module.
Cover the exact incident, rejection allowlist, HKT boundaries, half-day leave,
historical teams, manual overrides, duplicate scans, and existing attendance.
