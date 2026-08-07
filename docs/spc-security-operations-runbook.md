# SPC Security Operations and Review Runbook

Status: Draft for Group Information Security validation.

This runbook records the controls that already operate in SPC and provides a
repeatable evidence checklist. It does not approve risk, assign an unconfirmed
owner, or close any assessment finding.

| Role or cadence | Current position |
| --- | --- |
| Service owner | Pending Group confirmation |
| Technical owner | Pending Group confirmation |
| Security reviewer | Group Information Security — confirmation pending |
| Security-report mailbox owner | Pending Group confirmation |
| Privileged-access review cadence | Pending Group confirmation; quarterly and after material changes is the proposed starting point |
| Security-mailbox test cadence | Pending Group confirmation; quarterly is the proposed starting point |

## 1. Security-report intake

1. Record the received time in UTC, affected hostname, reporter contact (when
   provided), a short description and an internal reference.
2. Do not copy passwords, tokens, private keys, personal data or commercial
   records into tickets, chat, repository files or ordinary email.
3. Ask Group Information Security to confirm a secure evidence-transfer method
   if sensitive material is necessary.
4. Classify the report as `Received` and preserve relevant application,
   platform and audit references without changing the original evidence.
5. Group Information Security assigns severity, investigation ownership,
   escalation and any external communication.
6. Track the report as `Under Review`, `Mitigated` or `Closed`. Only the
   authorised reviewer or risk owner may approve closure or acceptance.

No acknowledgement or resolution SLA is promised by this draft.

## 2. Mailbox and security.txt test

Use a harmless test message. Do not include vulnerability details or secrets.

- Retrieve both canonical files:
  `https://fcuno.com/.well-known/security.txt` and
  `https://spc.fcuno.com/.well-known/security.txt`.
- Confirm both files publish `info@cosulich.it`, both canonical URLs and a valid
  `Expires` value.
- Send a message with a unique reference and record the send, receipt,
  acknowledgement and escalation evidence available to the authorised tester.
- Record who monitored the mailbox and how the report would be routed. Leave
  the result `Pending Security validation` until Group Information Security
  accepts the process.
- Review renewal ownership when 120, 60 and 30 days remain before expiry. The
  automated repository test fails when fewer than 90 days remain so renewal
  cannot silently pass the security baseline.

`npm run security:check-live` performs the non-invasive, two-domain HTTP and
header portion of this check. It does not test mailbox delivery or staffing.

## 3. Privileged-access review

The reviewer should use an authorised, read-only export or the administration
interface and retain only the minimum evidence needed. Do not export password
hashes, phone numbers, session tokens or unrelated user data.

- List active SPC accounts and identify the exact effective role.
- Confirm every user-management operator has both the exact `ADMIN` role and
  edit access to `spc-user-management`.
- Confirm non-administrators and view-only administrators cannot create, edit,
  deactivate, delete or change roles through either the UI or direct API.
- Identify inactive, stale, duplicate or no-longer-required accounts for the
  business owner and Security to review.
- Confirm new users have completed the forced-password-change step.
- Revoke sessions after disablement, role changes, suspected compromise or any
  approved removal of access.
- Confirm at least one active administrator remains and sample the related
  protected audit events.
- Record reviewer, date, population count, exceptions, approved changes and
  the next review decision. Do not mark the review approved without the named
  reviewer’s confirmation.

## 4. Current retention register

| Evidence or data | Implemented technical position | Approval still required |
| --- | --- | --- |
| SPC login-attempt evidence | Automatic 30-day retention and daily bounded purge | Confirm legal/security suitability and access to the retained evidence |
| SPC sessions | Fixed 12-hour validity; expired or revoked rows are pruned after 30 days | Confirm whether the operational history is sufficient |
| SPC user-management audit | Credential-redacted and append-only for protected events | Deletion/retention period is not approved; do not invent or apply one |
| Vercel and application logs | Available according to provider/project configuration | Retention, log-drain scope and access are not verified |
| Verified logical Drive backups | 35-day managed window with verification evidence | Confirm authorised access, encryption assurance, restore coverage and disposal |
| GitHub security-check artifacts | Workflow retains sanitized test and dependency-audit output for 90 days | Security to confirm whether a longer evidence period is required |

## 5. Automated security evidence

The `SPC security baseline` GitHub workflow runs the focused security suite and
production dependency audit on relevant changes and weekly. Scheduled and
manual runs also perform the read-only live two-domain baseline check. The
workflow stores sanitized TAP, audit JSON and live-check output as evidence; it
must never print environment secrets or user records.

Review a failed run before release. A passing run supports technical evidence
but does not replace independent authenticated testing.

## 6. CSP and edge-control validation

The high-value CSP baseline is enforced. The fuller application policy remains
Report-Only to preserve supported Next.js, Outlook, TradingView, map, frame and
media flows.

Before enforcing the full policy:

1. collect browser violations from public, authenticated, download and embedded
   workflows without collecting sensitive page content;
2. remove unnecessary origins and inline allowances where compatible;
3. retest Outlook framing, TradingView, Google Drive/Docs, maps, media and the
   Chrome-extension download;
4. obtain Group Information Security approval; and
5. retain a rollback and post-deployment validation record.

Do not add `X-Frame-Options: SAMEORIGIN`, HSTS `includeSubDomains`/preload, CSP
report collection, WAF rules, bot controls, IP allowlists or Attack Mode through
this runbook. Those require the compatibility and ownership decisions in
[`spc-provider-security-validation.md`](spc-provider-security-validation.md).

## 7. Independent retest checklist

The signed assessment remains open until the appointed reviewer completes the
targeted authenticated retest. At minimum, retain evidence for:

- normal-user versus administrator user-management operations;
- direct API replay, role-change attempts and final-admin continuity;
- action/API/audit correlation, failed outcomes and trusted-source-IP spoofing;
- session expiry, logout and administrator-triggered revocation;
- authenticated and download-route header/MIME coverage; and
- formal reviewer closure or remaining-risk decision.

## 8. Controls that remain open

This runbook does not implement or approve MFA, restriction of the public trial
portal, GDPR deletion/DSR handling, SIEM/log drains, alert recipients,
application-audit retention, WAF/bot policy, provider contracts, backup/restore
acceptance, extension signing or independent assessment closure.

## 9. Concise change-summary record

Use this record when preparing the later management or Security email:

| Field | Record |
| --- | --- |
| Date and production revision | |
| Short change theme | |
| Controls improved | |
| Automated/live checks passed | |
| Evidence attached | |
| Decisions or independent tests still required | |

Summarise outcomes by control theme. Do not list every file or implementation
step unless Security asks for the technical detail.
