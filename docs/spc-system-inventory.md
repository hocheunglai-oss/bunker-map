# SPC System Inventory

Status: Sanitized current-state inventory - owner and Security validation
pending.

This document records confirmed, non-secret facts visible in the repository or
sanitized provider evidence. It contains no credential values, user records,
message content, private evidence links or raw production exports. `Pending`
means that the accountable owner or approval has not been confirmed; it is not
an assignment to Group Information Security.

## Inventory record

| Field | Current position |
| --- | --- |
| Service | FCUNO / Singapore Purchasing Center (SPC) web platform |
| Production hostnames | `https://fcuno.com` and `https://spc.fcuno.com` |
| Business owner | Pending management confirmation; the preliminary workbook's candidate is not treated as approved here |
| Service owner | Pending management confirmation |
| Technical owner | Pending management confirmation |
| Security reviewer | Group Information Security - confirmation pending |
| Inventory custodian | Pending management confirmation |
| Classification and criticality | Pending Group confirmation |
| Evidence date | 2026-08-07 technical review; reviewer acceptance pending |
| Production revision | Record both hostnames' `/api/deploy-info` full commit SHA in the release evidence record |

## Service boundary and components

| Component | Confirmed technical position | Data / trust boundary | Owner or validation |
| --- | --- | --- | --- |
| Web application and APIs | Next.js 16, React 19 and TypeScript application hosted on Vercel; the production platform runtime is Node.js 24 | Public root/login; authenticated `/spc/*`; server-side `/api/spc/*`; FCUNO administrative and integration routes in the same repository | Technical owner: Pending |
| Source and delivery | GitHub repository triggers Vercel deployment; immutable-SHA Actions run security checks and a Node.js 24 production build | Source, dependency lock, workflow artifacts and deployed revision | Repository access/MFA and release authority: Pending |
| SPC identity and authorization | Managed SPC users, revocable database sessions, role groups and page permissions; user administration requires `ADMIN` plus `spc-user-management` permission on the server | User identity, role, session and privileged user-lifecycle operations | Access owner and periodic reviewer: Pending |
| SPC database | Supabase PostgreSQL 17.6.1 in `ap-south-1`; reviewed public tables use RLS and browser-role access was reviewed | Users, permissions, enquiries, fixtures, suppliers, audit and supporting application records | Database/service-key owner: Pending |
| Object/media storage | Supabase Storage supports protected presentation/media content | Stored objects and authenticated delivery | Bucket-policy, recovery and retention approval: Pending |
| Audit and request context | Database-backed audit records, stable actor identifier, actor/role, trusted source IP, target, safe changes, outcome and correlation/platform request IDs; protected SPC user-management evidence is append-only | Security events and restricted investigation metadata | Retention, central destination and alert owner: Pending |
| Login/session protection | Database-backed repeated-failure limits, generic login errors, fixed 12-hour SPC sessions, secure cookies in production and session revocation | Public authentication to authenticated session boundary | Threshold/policy acceptance and monitoring owner: Pending |
| Edge and transport | Vercel platform firewall/DDoS mitigation, HTTPS redirect and HSTS; no custom WAF/IP/bypass rules observed and bot protection/Attack Mode were off | Internet edge, TLS and forwarded request context | Platform owner and residual-control decision: Pending |
| Web-response hardening | Enforced high-value CSP, fuller Report-Only CSP, `nosniff`, `no-referrer`, restricted browser features, no framework-powered header and private/no-store SPC API responses | Browser, embedded services, downloads and API responses | Full CSP enforcement decision: Pending Security/owner validation |
| Backups and recovery | Verified logical Drive backup process documents a 35-day managed window | Logical application/Drive recovery artifacts | RTO/RPO, full restore, provider backup/PITR and recovery access: Pending |
| Observability | Structured request/audit references, Vercel live logs/default alert and GitHub security artifacts; no project log drain was observed | Application, edge, deployment and security-check evidence | Runtime-log retention, SIEM destination, recipients and escalation: Pending |

## Confirmed external dependencies

The provider checklist contains the validation detail. A listed dependency is
not evidence that its contract, data location or security approval is complete.

| Provider / service | Confirmed use or dependency | Validation still pending |
| --- | --- | --- |
| Vercel | Application/API hosting, edge, deployment, DNS and logs | Account MFA, runtime-log/SIEM decisions, DNS-integration scope, controlled edge test and DPA |
| Supabase | PostgreSQL, SPC sessions/authorization, audit data and private media/storage | Service-key lifecycle, encryption/key evidence, managed backup/PITR, restore and DPA |
| GitHub | Source, Actions security evidence and deployment trigger | Organisation access/MFA, required-review/status-check decision, continuing CodeQL alert review, retention acceptance and exit/mirroring |
| Google Workspace / Drive and Google Cloud | Supplier/contact sources, embedded/shared content and logical backup support where configured | Exact projects, OAuth scopes, sharing, region, retention, recovery and DPA |
| Microsoft 365 / Graph / Exchange and Azure Automation | Mail, contacts, address-book and scheduled Exchange-related processing | Tenant/subscription ownership, MFA, scopes, webhook controls, audit/retention and DPA |
| OpenAI API | AI-assisted SPC enquiry parsing with human review | Approved use, data categories, organisation controls, terms/DPA, retention/training treatment and exit |
| Google AI / Gemini | Optional administrative AI assistance is documented | Actual production enablement, approved use, data handling and terms |
| MapTiler / OpenStreetMap | Map tiles and geographic display origins are configured | Browser-key restriction, quota, terms and privacy role |
| ICE | Brent market-data dependency with contract/freshness/range validation and fail-closed behavior | Licence and permitted internal use |
| TradingView | Embedded chart/widget origins are configured | Current business use, widget terms, privacy impact and exit |
| Hong Kong Observatory | Weather content origin is configured for supported presentation/embedding | Current use, terms and owner confirmation |
| Meta / WhatsApp | SPC browser-extension/company-number workflows and an ADMIN-only Cloud API OTP delivery/verification pilot for the inactive `MFA_TEST` account are documented; the pilot uses a dedicated Meta test sender and does not enforce login MFA | Approved service model, recipient-number verification, delivery-metadata retention, extension distribution, privacy role, DPA and provider/contract review |

## Data categories and exposure

- Account, role, office and page-permission data for SPC users.
- Enquiry, fixture, supplier and operational workflow data.
- Audit, login-pressure, session and request-correlation evidence.
- Contact/address-book and mail-integration data used by related FCUNO flows.
- Presentation/media objects and logical backup artifacts.
- Public market, map, chart and weather content obtained from external sources.

The application host and login endpoint are Internet reachable by design.
Protected SPC APIs and pages require server-side authentication/authorization.
The public-trial restriction decision, approved data classification, retention,
privacy roles, deletion/DSR process and permitted cross-border transfers remain
Pending owner, Privacy, Legal and Group Information Security validation.

## Authoritative evidence references

- `docs/spc-security-evidence-index.md` - signed findings and workbook mapping.
- `docs/spc-security-operations-runbook.md` - operational review, incident,
  vulnerability and change evidence.
- `docs/spc-provider-security-validation.md` - provider observations and open
  confirmations.
- `docs/audit-log-system.md` - application audit design.
- `docs/backup-restore-runbook.md` - current logical backup/recovery design.
- `.github/workflows/spc-security-baseline.yml` - repeatable security evidence.

Update this inventory after a material architecture, data-flow, provider,
identity, deployment or recovery change. Record the revision and reviewer; do
not silently convert a `Pending` item into an approved fact.
