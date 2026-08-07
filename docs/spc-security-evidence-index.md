# SPC Security Assessment Evidence Index

Status: Draft technical evidence map - not an approval, risk acceptance or
finding closure.

This index maps the signed SPC penetration-test findings and the NIS2 supplier
self-assessment evidence requests to sanitized, repeatable evidence. The signed
report remains the authoritative source for its findings and severities. A
status of `Implemented` below describes the current technical control; it does
not mean that the signed finding is closed.

Signed source: *SPC Web Application - Extended Web Application Penetration
Testing Report*, version 2.0, assessment date 2026-08-06, with a completed
signature audit trail. Keep the signed source in the restricted evidence
location; do not add it to Git.

Group Information Security must validate the evidence. The appointed assessor
must perform and accept the targeted retest before any signed-report finding is
marked closed. Neither repository tests, a deployment, this index nor the
service-owner workbook can provide that approval.

## Evidence handling and release record

- Keep raw screenshots, exports and the generated evidence pack in the
  Group-approved restricted location. Local generated packs under
  `output/pdf/nis2-security-evidence-<date>/` are deliberately excluded from
  Git.
- Do not place credentials, secret values, session cookies, password hashes,
  personal records, message content or unrestricted database exports in the
  repository or a workflow artifact.
- Repository paths below identify repeatable control evidence. Capture the
  result, not sensitive inputs or records.
- Complete this release record before sending an evidence pack to Security.

| Evidence record field | Value to record |
| --- | --- |
| Collection UTC | `[YYYY-MM-DDThh:mm:ssZ]` |
| FCUNO production revision | `[full deployed commit SHA from /api/deploy-info]` |
| SPC production revision | `[full deployed commit SHA from /api/deploy-info]` |
| GitHub workflow run | `[run ID and restricted link]` |
| Database migration evidence | `[migration name, UTC result and sanitized validation reference]` |
| Collector | `[name / role]` |
| Technical reviewer | `[name / role / UTC date]` |
| Group Information Security reviewer | `[name / UTC date / decision]` |
| Appointed assessor | `[name / UTC retest date / decision]` |
| Restricted evidence location | `[Group-approved reference - not a public URL]` |

## Signed penetration-test findings

| ID | Signed-report position | Current technical status - not closure | Sanitized evidence to collect | Evidence record / remaining decision |
| --- | --- | --- | --- | --- |
| W-01 | High; pending verification - potential excessive user-management privileges | Implemented in the current control design: SPC user administration requires the exact `ADMIN` role and `spc-user-management` page permission, with server-side enforcement and final-admin continuity. Signed finding remains open. | `lib/spcAuth.ts`; `app/api/spc/users/route.ts`; `tests/spc-auth-security.test.ts`; relevant migration result; redacted normal-user and administrator direct-API retest | `W01-[reference]`; collection `[UTC]`; revision `[SHA]`; reviewer `[name]`. Assessor must verify every create, edit, deactivate, delete and role/group operation through UI and modified direct requests. |
| W-02 | Medium; confirmed - source IP and user-lifecycle audit detail missing | Implemented in the current control design: trusted request context, stable actor user ID, actor name/role, target, safe changes, outcome, correlation/platform request IDs, credential redaction and append-only database protection. Signed finding remains open. | `lib/trustedRequestContext.ts`; `lib/spcAudit.ts`; `supabase/audit_log.sql`; `supabase/migrations/20260807090000_add_stable_spc_audit_actor_ids.sql`; `tests/spc-audit-context.test.ts`; `tests/spc-user-audit-sql.test.ts`; `tests/spc-actor-user-id-audit.test.ts`; sanitized successful, failed, denied and spoofed-forwarding retest | `W02-[reference]`; collection `[UTC]`; revision `[SHA]`; reviewer `[name]`. Record production migration/revision, complete the assessor retest, and obtain Security decisions for retention, central collection and alerting. |
| B-01 | Low; confirmed - Content-Security-Policy missing | A high-value CSP is enforced and the fuller application policy is staged in Report-Only mode to protect compatibility. Full-policy enforcement and signed finding closure remain pending. | `next.config.js`; `tests/web-security-baseline.test.ts`; `scripts/check-live-security-baseline.mjs`; sanitized public/authenticated/error/download browser validation | `B01-[reference]`; collection `[UTC]`; revision `[SHA]`; reviewer `[name]`. Review violations, test supported integrations and obtain Security approval before broader enforcement. |
| B-02 | Low; confirmed - Strict-Transport-Security missing | Vercel supplies HSTS and the read-only live baseline verifies it on both production hostnames. Signed finding remains open pending assessor retest. | `tests/web-security-baseline.test.ts`; `scripts/check-live-security-baseline.mjs`; workflow live-check artifact; sanitized response headers | `B02-[reference]`; collection `[UTC]`; revision `[SHA]`; reviewer `[name]`. Assessor verifies public, authenticated, API, download and error responses; any `includeSubDomains` or preload decision remains separate. |
| B-03 | Low; confirmed - X-Content-Type-Options missing | `nosniff` is configured globally and live response/MIME checks cover representative public, private JSON, download and error paths. Signed finding remains open pending authenticated retest. | `next.config.js`; `tests/web-security-baseline.test.ts`; `scripts/check-live-security-baseline.mjs`; sanitized response/MIME results | `B03-[reference]`; collection `[UTC]`; revision `[SHA]`; reviewer `[name]`. Complete authenticated and successful-download MIME validation with the assessor. |
| B-04 | Low; confirmed - Referrer-Policy missing | `no-referrer` is configured globally and checked live on both production hostnames. Signed finding remains open pending assessor retest. | `next.config.js`; `tests/web-security-baseline.test.ts`; `scripts/check-live-security-baseline.mjs`; sanitized cross-origin browser check | `B04-[reference]`; collection `[UTC]`; revision `[SHA]`; reviewer `[name]`. Assessor validates intended cross-origin behavior and supported integrations. |
| B-05 | Low; observed - technology and hosting disclosure | Unnecessary Next.js response disclosure is disabled. Dependency audits, registry-signature verification, SBOM generation, Dependabot security updates and completed CodeQL analysis support ongoing exposure management. Some platform fingerprinting is expected. | `next.config.js`; `.github/workflows/spc-security-baseline.yml`; `.github/dependabot.yml`; audit/signature/SBOM artifacts; CodeQL run and alert-triage evidence | `B05-[reference]`; collection `[UTC]`; revision `[SHA]`; reviewer `[name]`. Record the release CodeQL result and Security's residual-risk decision; do not claim all technology disclosure can be removed. |
| B-06 | Informational; observed - public login and API attack surface | Public authentication remains an intended entry point. Server authorization, generic errors, database-backed login rate limits, secure fixed-duration cookies, session revocation and private/no-store responses are implemented. | `app/api/spc/login/route.ts`; `lib/spcLoginSecurity.ts`; `lib/spcAuth.ts`; `tests/spc-login-rate-limit.test.ts`; `tests/spc-session-cookie-security.test.ts`; read-only live 401/200 checks | `B06-[reference]`; collection `[UTC]`; revision `[SHA]`; reviewer `[name]`. Security/assessor performs controlled repeated-failure, revocation, enumeration and authenticated API tests. |
| B-07 | Informational; confirmed - security.txt missing | The RFC 9116 file is published for both canonical hostnames and its contact, MIME type and renewable expiry are tested. The reporting mailbox process is not validated by an HTTP test. | `public/.well-known/security.txt`; `tests/web-security-baseline.test.ts`; `scripts/check-live-security-baseline.mjs`; harmless mailbox test record | `B07-[reference]`; collection `[UTC]`; revision `[SHA]`; reviewer `[name]`. Group Information Security must validate monitoring, acknowledgement and escalation before closure. |
| B-08 | Informational; unverified - dedicated WAF not identified | Vercel platform firewall and managed DDoS mitigation were observed active. No custom rules, bypasses or IP blocks were present; bot protection and Attack Mode were off. No custom control is enabled solely to satisfy the report. | `docs/spc-provider-security-validation.md`; sanitized Vercel configuration capture; controlled alert/block test approved by Security | `B08-[reference]`; collection `[UTC]`; revision `[SHA]`; reviewer `[name]`. Security and the platform owner decide whether a log-first WAF/bot exercise is required and accept the residual control position. |
| W-03 | Informational; architecture control validation required | Partially verified. Repository, Vercel and Supabase evidence now covers several authorization, RLS/grant, secret-scope and dependency controls; the wider provider and recovery evidence is incomplete. | `docs/spc-provider-security-validation.md`; `docs/spc-system-inventory.md`; RLS/grant validation; security workflow artifacts; provider-approved configuration extracts | `W03-[reference]`; collection `[UTC]`; revision `[SHA]`; reviewer `[name]`. Complete service-key, backup/PITR/restore, OAuth, SMTP, extension distribution, provider-contract and independent architecture review evidence. |

## NIS2 supplier self-assessment evidence requests

The workbook remains a preliminary service-owner self-assessment. `Provided -
Pending Review` is not approval, and a repository document cannot replace
Group, provider, contractual or exercise evidence.

| Workbook evidence request | Current repository support | Evidence still required outside this repository | Evidence record placeholder |
| --- | --- | --- | --- |
| E-01 - GOV-01 to GOV-05: ownership and governance | This index, the operations runbook and the sanitized inventory provide a draft control record. | Management-confirmed service/technical owners, governance approval, risk record and review cadence. | `E01-[reference]`; collected `[UTC]`; revision `[SHA]`; reviewer `[name]` |
| E-02 - SCM-01 to SCM-05 and FIN-01 to FIN-02: provider, concentration and dependency register | `docs/spc-provider-security-validation.md` and `docs/spc-system-inventory.md` record confirmed dependencies and open validations. | Contract/DPA, location/subprocessor evidence, concentration/exit analysis and owner acceptance. | `E02-[reference]`; collected `[UTC]`; revision `[SHA]`; reviewer `[name]` |
| E-03 - AST-01 to AST-04: architecture and asset inventory | `docs/spc-system-inventory.md` provides a sanitized current-state inventory; architecture evidence may be stored in the restricted pack. | Approved authoritative inventory, named custodian, review record and full data-flow validation. | `E03-[reference]`; collected `[UTC]`; revision `[SHA]`; reviewer `[name]` |
| E-04 - IAM-01 to IAM-06: identity and access | W-01 controls, session/rate-limit tests and the privileged-access checklist provide technical support. | Vercel/Group MFA, approved access-review population and independent normal/admin account retest. | `E04-[reference]`; collected `[UTC]`; revision `[SHA]`; reviewer `[name]` |
| E-05 - CRY-01 to CRY-04: cryptography and data protection | TLS/HSTS and secure-cookie checks provide transport/session evidence. | Provider at-rest encryption, key custody/rotation, backup encryption and approved data-handling evidence. | `E05-[reference]`; collected `[UTC]`; revision `[SHA]`; reviewer `[name]` |
| E-06 - LOG-01 to LOG-05: logging, monitoring and detection | W-02 audit controls, live checks and CI evidence provide application-level support. | Approved audit/runtime-log retention, SIEM/drain, alert recipients, escalation and controlled detection evidence. | `E06-[reference]`; collected `[UTC]`; revision `[SHA]`; reviewer `[name]` |
| E-07 - VUL-01 to VUL-05: vulnerability and security testing | The vulnerability lifecycle below, dependency audits, signatures, SBOM, CodeQL analysis and focused tests provide repeatable technical evidence. | Accepted vulnerability policy, continuing alert review, authenticated independent retest and formal remediation/closure record. | `E07-[reference]`; collected `[UTC]`; revision `[SHA]`; reviewer `[name]` |
| E-08 - SDLC-01 to SDLC-04: secure change and deployment | Git revision traceability, locked dependencies, immutable Actions and Node 24 build evidence support technical traceability. | Approved change authority, release-specific reviewer record, rollback decision and any required segregation of duties. | `E08-[reference]`; collected `[UTC]`; revision `[SHA]`; reviewer `[name]` |
| E-09 - BCP-01 to BCP-06: backup, restore and continuity | `docs/backup-restore-runbook.md` and the verified logical-backup evidence describe current controls. | Approved RTO/RPO, provider backup/PITR evidence, recovery access, full restore/DR exercise and business acceptance. | `E09-[reference]`; collected `[UTC]`; revision `[SHA]`; reviewer `[name]` |
| E-10 - IR-01 to IR-05: incident management and notification | The SPC incident lifecycle below defines system evidence and state handling without promising an SLA. | Group incident plan, confirmed contacts/owners, regulatory/customer notification decision process and exercise result. | `E10-[reference]`; collected `[UTC]`; revision `[SHA]`; reviewer `[name]` |
| E-11 - PHY-01 to PHY-02: physical assurance | Cloud-hosted scope and providers are identified. | Applicable provider certifications/assurance and Group acceptance; these controls cannot be proven from application code. | `E11-[reference]`; collected `[UTC]`; reviewer `[name]` |
| E-12 - HR-01 to HR-03: personnel security and awareness | No application-repository evidence is treated as proof of Group personnel controls. | HR/Information Security screening, access lifecycle, training and acknowledgement evidence. | `E12-[reference]`; collected `[UTC]`; reviewer `[name]` |
| E-13 - PRV-01 to PRV-03: privacy, retention, deletion and DSR | Data categories and open retention decisions are identified without exporting personal data. | Privacy/Legal-approved roles, records of processing, transfer map, retention schedule and deletion/DSR workflow. | `E13-[reference]`; collected `[UTC]`; reviewer `[name]` |
| E-14 - CON-01 to CON-05: contractual security and audit | Provider and control gaps are listed for review. | Legal/Procurement-approved security, notification, audit, subprocessor, change, continuity and exit clauses. | `E14-[reference]`; collected `[UTC]`; reviewer `[name]` |
| E-15 - AI-01 to AI-03: AI use and human review | The provider checklist records the parser's `store:false`, human-review and telemetry controls. | Approved AI inventory/use, permitted-data decision, provider terms/DPA, validation and accountable owner. | `E15-[reference]`; collected `[UTC]`; revision `[SHA]`; reviewer `[name]` |
| E-16 - FIN-01 to FIN-02: operational resilience and exit | The provider/dependency register identifies technical dependencies. | Formal concentration, insurance where applicable, lock-in, alternative-provider and exit/recovery assessment. | `E16-[reference]`; collected `[UTC]`; reviewer `[name]` |

## Pending risk and decision register

This register records unresolved decisions without assigning authority, accepting
risk or creating a deadline. Management, Group Information Security, Privacy,
Legal, Procurement or the appointed assessor must complete the applicable
fields in the restricted evidence record.

| Reference | Open condition | Status | Accountable owner | Decision / acceptance | Review date |
| --- | --- | --- | --- | --- | --- |
| R-01 | Public trial access, privileged-account ownership and MFA | Open | Pending | Pending | Pending |
| R-02 | Privacy roles, retention, deletion, DSR and legal hold | Open | Pending | Pending | Pending |
| R-03 | Central monitoring, log drain/SIEM, alert recipients and retention | Open | Pending | Pending | Pending |
| R-04 | Provider contracts, DPAs, subprocessors, location and exit rights | Open | Pending | Pending | Pending |
| R-05 | RTO/RPO, provider backups/PITR and restore/DR exercise | Open | Pending | Pending | Pending |
| R-06 | Chrome extension signing, controlled distribution, updates and storage | Open | Pending | Pending | Pending |
| R-07 | Full CSP enforcement and custom WAF/bot/rate-limit policy | Open | Pending | Pending | Pending |
| R-08 | Independent authenticated W-01/W-02 retest and signed closure | Open | Pending | Pending | Pending |

## Closure rule

Keep every row open until its required evidence is collected and reviewed. A
technical reviewer may confirm that an implementation or check passed, but only
Group Information Security can approve the security position and only the
appointed assessor can close the corresponding signed-report finding after the
required retest. Record exceptions and residual risk; never convert an empty
reviewer field into assumed approval.
