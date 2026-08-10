# SPC Provider Security Validation Checklist

Status: Draft for Group Information Security, Privacy, Legal and IT validation.

This checklist separates direct technical observations from provider-console,
contractual and operational evidence. `Not verified` means the evidence was not
available; it must not be interpreted as either compliant or non-compliant.

| Provider or service | Function / data handled | Current technical evidence | Result | Remaining confirmation | Evidence date / reviewer |
| --- | --- | --- | --- | --- | --- |
| Vercel | Application/API hosting, edge, deployment, DNS and logs | Pro project verified live: platform firewall/DDoS mitigation active; no bypass/IP/custom rules; bot controls and Attack Mode off; build-log/source and Git-fork protection on; support code visibility off; team-scoped OIDC; default alerts; production deployment retention one year; no drain; one owner account remains single-factor | Partially verified | Owner MFA, log/SIEM destination and runtime-log retention, log-first bot/WAF compatibility exercise, DNS-integration project scope, independent controlled alert/block test and DPA | 2026-08-07 / technical review; Security acceptance pending |
| Supabase | PostgreSQL, identity/session/audit/business data and private media | Project healthy in `ap-south-1` on PostgreSQL 17.6.1; all reviewed public tables use RLS; browser-role table/function grants were checked; retired WhatsApp and legacy-admin Data API grants were removed while service-role access and row counts were preserved; Security Advisor has no warning/error finding | Partially verified | Service-key lifecycle, encryption/key assurance, managed backups/PITR, restore points, storage-object recovery and DPA | 2026-08-07 / technical review; Security acceptance pending |
| GitHub | Source repository, reviews, Actions and deployment trigger | Repository and deployment revision are traceable; secret scanning/push protection, vulnerability alerts and Dependabot security updates are enabled; Actions SHA pinning is required; main-branch protection enforces administrators and blocks force pushes/deletion while direct pushes and required reviews/status checks remain allowed/unconfigured; CodeQL default setup is enabled, its initial multi-language analysis completed successfully and every initial alert was triaged; security Actions produce audit/signature/SBOM evidence | Partially verified | Continue alert review after releases; organisation MFA/access; decide whether required reviews/status checks are needed; artifact-retention acceptance, DPA and exit/mirroring | 2026-08-07 / technical review; Security acceptance pending |
| Name.com | Domain registration | Registrar role identified | Not verified | Corporate ownership, MFA, recovery contacts, transfer lock and change audit | Pending |
| Google Workspace / Drive | Supplier/contact sources and logical backup artifacts | Application flows and 35-day logical-backup window are documented | Partially verified | Sharing, owners, account MFA, audit, storage location, encryption assurance, deletion and restore access | Pending |
| Google Cloud Platform | Supporting storage/jobs where enabled | Dependency recorded in the provider register | Not verified | Actual projects/resources, regions, identities, retention, billing ownership and DPA | Pending |
| Microsoft 365 / Graph / Exchange | Mail, contacts, address-book and tenant integrations | Server-side TLS SMTP and permissioned application flows are documented | Partially verified | Tenant MFA, scopes, recipients/delivery controls, audit/retention, locations, ownership and DPA | Pending |
| Azure Automation | Scheduled Exchange-related processing | Shared automation flow is documented | Not verified | Subscription, region, identity, webhook restrictions, logs, alerts and owner | Pending |
| Meta / WhatsApp Cloud API | Private test-recipient phone numbers plus OTP delivery and verification metadata for the inactive `MFA_TEST` account and the feature-flagged Otto login pilot | The approved `spc_mfa_test_code` Authentication template and dedicated Meta test sender support two separate, limited workflows: the ADMIN-only inactive-account test, which never changes login, and a real-login pilot limited to `otto@cosulich.com.hk`, which requires a password before the six-digit WhatsApp step. Both use keyed OTP hashes, masked destinations, five-minute expiry and bounded attempts; all other SPC accounts remain password-only. | Partially verified | End-to-end production evidence for the Otto-only flag, registered recipient and session gate; approved service model, business/privacy roles, DPA, Meta retention and location terms, delivery-status/webhook scope, access-token lifecycle and any wider login-MFA decision | 2026-08-10 / technical review; Security, Privacy and Legal acceptance pending |
| OpenAI API | AI-assisted enquiry parsing | `store:false`, human review and usage telemetry are implemented for the SPC parser | Partially verified | Approved use, organisation settings, DPA, retention/training treatment, locations, permitted data and exit | Pending |
| Google AI / Gemini | Optional administrative AI assistance | Use case identified separately from the core SPC parser | Not verified | Production enablement, approved use, terms, retention/training and permitted data | Pending |
| MapTiler / OpenStreetMap | Map tiles and geographic display | Required origins are explicitly allowlisted | Partially verified | Production provider, browser key domain/quota restrictions, terms and privacy role | Pending |
| ICE | Brent market data | Contract/freshness/cross-feed validation and no-store requests are tested | Partially verified | Licence and permitted internal use | Pending |
| TradingView | Embedded charts/widgets | Required origins are explicitly allowlisted | Partially verified | Current use, widget terms, privacy impact and removal/exit option | Pending |

## Vercel console evidence

Capture the project name and UTC evidence date without exposing secret values.

- Current production deployment for both hostnames.
- Firewall/WAF rules, rule order, action and environment.
- Bot controls, managed rules, rate limits and Attack Mode state.
- Controlled harmless block/challenge result and corresponding alert/log record.
- Team/project access, administrator MFA and recovery ownership.
- Environment-variable scope and `Sensitive` status; never capture values.
- DNS/TLS configuration and the HSTS source.
- Runtime/application log retention, drains, alert recipients and plan limits.

Evidence captured on 2026-08-07 without secret values:

- the platform firewall was active and its managed DDoS mitigation was denying
  traffic; there were no system bypasses, IP blocks or custom rules;
- Bot Protection was inactive, AI bots were allowed and Attack Mode was off;
- Build Logs and Source Protection and Git Fork Protection were enabled;
- Vercel Support Code Visibility was disabled and the team-scoped OIDC issuer
  mode was selected;
- production deployment retention was one year, a default all-type alert rule
  existed and no project drain was configured;
- sensitive runtime credentials were stored as Vercel Sensitive variables;
  most apply to Production and Preview, so narrowing Preview access requires a
  compatibility decision rather than a blind change; and
- one team owner was present and the live account prompt identified
  single-factor authentication. The installed DNS helper integration had
  access to all team projects, which remains for the owner to confirm.

The observed function error percentage included expected `401`/`404` results
from the read-only security baseline. The most recent 30-minute log view showed
no warning, error or fatal console records, and live market/API requests were
returning successful responses.

## Supabase console and database evidence

- Project region, version and health.
- RLS status, table grants, function execution grants, database roles and owners.
- Service-role use restricted to server-side code and a documented key-rotation
  and emergency-revocation process.
- Managed backup/PITR configuration, retention, last successful point and a
  non-production restore test.
- Private storage-bucket policy and recovery/backup coverage for media objects.
- Security Advisor results with default-deny informational notices explained,
  rather than silently treated as failures or ignored.

Evidence captured on 2026-08-07:

- the project was `ACTIVE_HEALTHY` in `ap-south-1` on PostgreSQL 17.6.1;
- every inspected public table had RLS enabled and privileged SPC/database
  functions were unavailable to `anon`, `authenticated` and `PUBLIC`;
- four unconditional public policies on the retired WhatsApp inbox were
  removed, and all table/legacy-sequence privileges were revoked from Data API
  roles without deleting the retained 1 admin, 9 conversation or 41 message
  rows;
- direct `anon` and `authenticated` replay returned PostgreSQL `42501`, while
  the hosted `service_role` retained read access for backups and inventory; and
- post-change Security Advisor results contained only intentional
  default-deny informational notices, with no warning or error finding.

## Evidence record

For every reviewed control record: provider, project/account, control, UTC
evidence date, reviewer, sanitized screenshot/export reference, result,
exception/remaining action and approval reference. Store the evidence only in
the Group-approved restricted location.
