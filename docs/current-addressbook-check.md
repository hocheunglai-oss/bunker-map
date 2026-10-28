# Current address-book comparison

`Check-FCUno-OutlookAddressBook` is a separate, manually invoked Azure Automation
runbook. It reads FCUNO and Exchange without running synchronization, historical
verification, certification, template activation, status writes, or email delivery.
The existing sync runbook and its schedules are unchanged.

## Meaning of the result

- `OBSERVED_MATCH`: two complete, stable observations found no differences between
  FCUNO's canonical Exchange projection and the directory visible to the existing
  Exchange application. It is not a globally atomic snapshot or a provider-RBAC
  audit, and does not prove that an Outlook client has refreshed its cache.
- `MISMATCH`: stable observations found differences. Details contain only bounded
  source identifiers and fixed reason codes, not names, email addresses or raw
  provider responses. No automatic repair is performed.
- `INCONCLUSIVE`: the source or queue changed, synchronization was busy, a read was
  incomplete, invalid source data was found, access failed, or the budget expired.
  This is not proof that contact synchronization failed.

Counts distinguish raw source rows from the canonical Exchange projection.
Existing projection rules collapse repeated source email addresses, exclude
internal recipients from managed external contacts, and omit empty groups.
Preserved Exchange group-shadow contacts are reported rather than silently hidden.
Equal counts alone never establish a match. Membership checks include email
multisets and immutable identity for managed external contacts.

The result does **not** create or renew a certificate, make a blocked Outlook
template sendable, prove historical integrity, or fix database restarts. Existing
certification and insertion safeguards remain in place. The existing application
credentials are privileged; this checker has a read-only call graph, not a newly
restricted provider identity.

## Build and test

Use trusted PowerShell 7.6 and Node.js with TypeScript type-stripping support:

```sh
pwsh -NoLogo -NoProfile -File scripts/azure-automation/build-current-addressbook-check.ps1
pwsh -NoLogo -NoProfile -File scripts/azure-automation/build-current-addressbook-check.ps1 -Check
FCUNO_PWSH_PATH=/absolute/path/to/pwsh node --test tests/current-addressbook-check.test.mjs
```

The offline builder imports non-secret identities from
`config/fcunoConnections.ts`, verifies the mutation worker against its independent
publication baseline, and copies only a closed allowlist of pure AST helpers.
It never executes or dot-sources the sync worker. Do not hand-edit the generated
helper block. The checker is a self-contained file for Azure publication.

## Deployment and operation

Verify Vincent's account, tenant, subscription, resource group, Automation account
and existing runtime against the current reviewed publication receipt. Create only
the separate `Check-FCUno-OutlookAddressBook` PowerShell runbook in the existing
`fcuno-exchange-sync` account, using `FCUNO-PowerShell-7-6` and the existing
ExchangeOnlineManagement 3.10.1 package. Do not add permissions, rotate/copy assets,
change existing variables or link a schedule.

Publish only the reviewed, tested file and independently read back its complete
published source. Run it once when no sync is active, leaving `LibraryOnly` false.
The job reads existing Automation settings and an ephemeral in-memory certificate;
it never exports credentials to this Mac. Inspect the JSON result, not only Azure's
`Completed` label: a normally completed diagnostic can be `INCONCLUSIVE`.

Retain private source hashes, job identity, result and before/after operational
metadata. Do not publish contact inventories, authenticated browser traces,
credentials or private job data to GitHub. Close only automation-owned browser tabs.
