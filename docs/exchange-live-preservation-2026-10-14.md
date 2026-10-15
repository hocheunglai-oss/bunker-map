# Exchange worker preservation — 14 October 2026

This patch preserves an already published repair, not a new Azure deployment.
The broader site-wide audit and real Outlook client verification remain open.
No Azure job, Exchange change, database write, email, or deployment was made by
this preservation work. No personal browser tab was accessed.

## Why preservation was necessary

Read-only Azure publication retrieval found worker
`fcuno-exchange-runbook/2026-10-09.1`. Clean main still contained
`fcuno-exchange-runbook/2026-09-02.21`. The retrieved live bytes exactly match
the canonical dirty checkout's runbook. Publishing the clean-main script could
therefore remove the live retry and alert-noise repairs. This patch copies only
the verified worker, matching tests and installed migration provenance. It does
not import the dirty checkout's unrelated changes.

Published source retrieved at `2026-10-14T11:21:47.594Z`:

- SHA-256: `7fbbff302cc843e231ca6b53a5490a9781839f7a84919117773ad4b2eeb030a4`.
- Size: 316,636 bytes; the preserved file is byte-identical.
- Published Azure metadata last modified: `2026-10-09T10:10:41.9366667Z`.
- Credential assignments were reviewed as Automation-variable lookups; scans
  found no embedded private key, JWT, Supabase secret token or literal credential.
  Credentials and caches were not printed or added to the repository.

## Verified target and configuration

Purpose-built Supabase API verified project `gglyugbrnyvyfktgwert`, name
`bunker-map`, active and healthy, PostgreSQL 17.6.1. A target-locked Azure CLI
verified the designated authorized administrator, subscription and tenant
before read-only ARM requests. Principal email and token-cache contents are
deliberately omitted from this record.

| Configuration | Verified value |
| --- | --- |
| Subscription | `360bfcdd-bb34-4281-ae3c-a3a0fae65eef` |
| Tenant | `70011d0d-19b4-4a61-8195-ab1fd987c20f` |
| Resource group | `fcuno-tools` |
| Automation account | `fcuno-exchange-sync` |
| Published runbook | `Sync-FCUno-OutlookAddressBook` |
| Runtime environment | `FCUNO-PowerShell-7-6`, PowerShell 7.6 |
| Exchange module | `ExchangeOnlineManagement` 3.10.1, provisioning succeeded |
| Default packages | Az 15.1.0; Azure CLI 2.77.0 |
| Enabled hourly schedule | `FCUNO-Exchange-Incremental-Hourly`, every hour at :31 HKT |
| Enabled daily full schedule | `FCUNO-Exchange-Full-Daily-0610`, 06:10 HKT |
| Retired schedules | Daily 04:10 and legacy 17:33 schedules disabled |

The enabled schedules are bound to the exact runbook. Schedule-binding list
responses did not expose parameters, so selecting full/incremental mode is
confirmed from the corresponding executed business-ledger outcomes rather than
guessed from a schedule name.

## Live operational evidence

At `2026-10-14T11:19:26Z`, the queue had no pending, processing, failed or
terminal-failed rows, and no active mutation lock. The truth verifier returned
valid ledger, snapshot, reference and group-SMTP checks, and a matching certified
projection. Latest full certification was `2026-10-13T22:29:36.310258Z`
(14 October 06:29 HKT), recorded by worker `2026-10-09.1`.

The most recent 100 Azure jobs returned `Completed`, but Azure job completion
alone is not application success. The independent business ledger shows:

| UTC on 14 October | Business result | Notification result |
| --- | --- | --- |
| 02:50:27 | 21 processed, 19 completed, 2 failed, 1 backlog row | Not sent; waiting for persistence |
| 03:12:53 | 1 completed, 0 failed, 0 backlog | Not sent; recovered |
| 10:33:06 | No queued work; 0 failed, 0 backlog | Not sent; recovered |

This is concrete evidence that a transient problem recovered without generating
an unnecessary team alert. It does not prove that no future outage can occur.

## Existing database migration, not a new application

`20261007065554_outlook_exchange_alert_delivery.sql` already exists in the
hosted migration history under the identical version and name. Its one stored
statement is 11,282 characters, MD5
`e2cbd5f1c97caf4aa4840dab078032e8`, exactly matching the preserved local bytes.
File SHA-256 is
`f3b90975f4590f3fdbb7f18f7d384a6fcdfa33907862ea9c90288a880624b405`.
The historical filename is restored as provenance, not generated under a new
version and not reapplied to production.

Both hosted function bodies independently match the migration:

| Function | Body MD5 |
| --- | --- |
| `observe_outlook_exchange_alert` | `66cfa327c7e006369094c68e2dee5f66` |
| `complete_outlook_exchange_alert` | `90fcd3414b85fbca4b88604dfbd25217` |

Both are invoker-security functions with pinned search paths. The service role
can execute; `anon` and `authenticated` cannot. They reuse the existing backed-up
settings store; they introduce no new backup-inventory table.

## Verification and future publication guard

`npm run test:exchange-worker` runs the offline exact-byte/provenance preflight,
eight negative/positive rollback checks, and five isolated PowerShell suites:
startup lock retry, Exchange connection retry, minimalist email rendering,
durable incident policy and the full existing runbook regression suite.
The package command is included in the focused CI job; missing PowerShell fails
with a clear installation instruction instead of quietly skipping tests.

All five suites passed on isolated PowerShell 7.6.0. Test workers import
`-LibraryOnly`, use synthetic data and mocked service boundaries, and start with
guards against unexpected HTTP, Exchange, Automation-setting and email access.
Eighteen isolated PostgreSQL/PGlite policy tests also passed with no skips,
covering persistence windows, claims, idempotent acknowledgements, recovery,
stale completions, corrupted state and service-only permissions. PGlite tests
are not evidence of native multi-backend concurrency or real SMTP delivery.

Run the publication preflight before any intentional Azure publication:

```sh
node scripts/azure-automation/check-exchange-publication.mjs
npm run test:exchange-worker
```

The preflight is deliberately offline and does not publish. It rejects an
older/newer worker, altered bytes, changed migration provenance or inconsistent
canonical target/runtime pins. Future intentional changes need a separately
reviewed baseline update, exact authorized Azure identity verification, tests,
published-content readback and fresh business-ledger evidence. Editing the hash
merely to silence this gate is not verification. Manual portal publication
cannot be technically prevented by an offline repository check.

## Remaining limitations

- Actual authenticated recipient-map HTTP delivery and Outlook field insertion
  were not observed here; backend certification alone does not establish them.
- Recipient-map availability was assessed against the committed 36-hour default;
  the live environment override was not retrieved during this preservation task.
- Azure control-plane access and operational metadata do not establish client
  autocomplete freshness or on-device address-book propagation.
- No human business-data choice is required to preserve this exact live worker.
