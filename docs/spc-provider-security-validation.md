# SPC Provider Security Validation Checklist

Status: Draft for Group Information Security, Privacy, Legal and IT validation.

This checklist separates direct technical observations from provider-console,
contractual and operational evidence. `Not verified` means the evidence was not
available; it must not be interpreted as either compliant or non-compliant.

| Provider or service | Function / data handled | Current technical evidence | Result | Remaining confirmation | Evidence date / reviewer |
| --- | --- | --- | --- | --- | --- |
| Vercel | Application/API hosting, edge, deployment, DNS and logs | Both production hostnames and the deployed security headers can be checked read-only | Partially verified | Project WAF/bot/IP rules, Attack Mode, account MFA, secret scope, log retention/drains, plan and DPA | Pending |
| Supabase | PostgreSQL, identity/session/audit/business data and private media | Project region, RLS and revoked anon/authenticated access were observed for the reviewed sensitive tables | Partially verified | Full roles/ownership, service-key lifecycle, encryption/key assurance, managed backups/PITR, restore points, storage-object recovery and DPA | Pending |
| GitHub | Source repository, reviews, Actions and deployment trigger | Repository and deployment revision are traceable | Partially verified | Organisation MFA/access, branch protection, Actions retention, secret scanning availability, DPA and exit/mirroring | Pending |
| Name.com | Domain registration | Registrar role identified | Not verified | Corporate ownership, MFA, recovery contacts, transfer lock and change audit | Pending |
| Google Workspace / Drive | Supplier/contact sources and logical backup artifacts | Application flows and 35-day logical-backup window are documented | Partially verified | Sharing, owners, account MFA, audit, storage location, encryption assurance, deletion and restore access | Pending |
| Google Cloud Platform | Supporting storage/jobs where enabled | Dependency recorded in the provider register | Not verified | Actual projects/resources, regions, identities, retention, billing ownership and DPA | Pending |
| Microsoft 365 / Graph / Exchange | Mail, contacts, address-book and tenant integrations | Server-side TLS SMTP and permissioned application flows are documented | Partially verified | Tenant MFA, scopes, recipients/delivery controls, audit/retention, locations, ownership and DPA | Pending |
| Azure Automation | Scheduled Exchange-related processing | Shared automation flow is documented | Not verified | Subscription, region, identity, webhook restrictions, logs, alerts and owner | Pending |
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

## Evidence record

For every reviewed control record: provider, project/account, control, UTC
evidence date, reviewer, sanitized screenshot/export reference, result,
exception/remaining action and approval reference. Store the evidence only in
the Group-approved restricted location.
