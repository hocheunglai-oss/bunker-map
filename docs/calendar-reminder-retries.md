# Calendar reminder delivery

Event Calendar runs at 08:00, 08:15 and 08:30 Hong Kong time on weekdays.
Task Calendar uses the same three times every day. These are three explicit
UTC schedules in `vercel.json`, all targeting the existing reminder endpoints.
Attendance schedules are independent and unchanged.

The later runs cover a missed invocation or a failure known to occur before
email submission, such as unavailable calendar data, staff resolution,
configuration, or claim storage. A durable receipt for each date/task makes a
successful occurrence a quiet skip on subsequent runs. Completed receipts are
checked before SMTP configuration and staff resolution so a later settings
problem cannot turn a delivered occurrence into another reported failure.

An uncertain submission still requires a Sent Items check. It is never retried
automatically, because the first email may already have been accepted. The
retry window is bounded to that morning; this is not multi-day catch-up.

Vercel documents UTC schedules and multiple cron jobs sharing one path in
[Cron Jobs](https://vercel.com/docs/cron-jobs), and confirms failed invocations
are not automatically retried in
[Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs).
These minute-precise schedules require Pro or Enterprise, as described in
[Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing).
No hosted schedule or live email is changed by the synthetic tests.
