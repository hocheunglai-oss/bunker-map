# FCUNO Project Connections

These identities are specific to this repository. Do not infer or reuse an
account from another Codex project.

For every external connection, use this order without exception: verified
purpose-built API or connector first, target-locked CLI second, and the pinned
Chrome profile only as the final fallback. Verify the exact account,
organization, project, repository, environment, scope, and permissions before
every read or mutation. Fail closed on a mismatch.

- GitHub repository: `hocheunglai-oss/bunker-map`
- Required GitHub account for mutations: `hocheunglai-oss`
- Vercel project: `hocheunglai-6535s-projects/bunker-map-c2ks`
- Vercel team ID: `team_MbKDazzCrou3eKTuausPv4X2`
- Vercel project ID: `prj_8OifIFDF7Gcpd2i4VSRJOHjL3A9Q`
- Supabase project: `gglyugbrnyvyfktgwert`
- Production domains: `https://fcuno.com` and `https://spc.fcuno.com`
- Primary browser fallback profile: `Otto`
- FCOS counterpart repository: `hocheunglai-oss/fcos`
- FCOS Vercel project: `hocheunglai-6535s-projects/fcos`
- FCOS Supabase project: `pjforfvchygdyqfcgpmw`

`config/fcunoConnections.ts` is the canonical machine-readable source for
these non-secret identifiers. Operational code and scripts must import it
instead of repeating project refs, repository names, origins, client IDs, or
federation protocol versions.

FCUNO is the company identity and credential authority. FCOS and linked SPC
profiles consume the FCUNO identity while retaining their own application
permissions. Passwords, password hashes, session cookies, refresh tokens,
service-role keys, private signing keys, recovery credentials, and application
financial data must never be copied between projects.

The canonical FCUNO-to-FCOS identity contract lives under
`contracts/fcuno-fcos/`. A protocol version is immutable after production use.
Backward-compatible additions require a new schema digest; breaking changes
require a new protocol version. FCOS pins the exact protocol version, FCUNO
commit, and schema SHA-256 before it may enable that version.

Every production federation release uses immutable preview deployments and an
approved release manifest containing both Git commit SHAs, both Vercel preview
deployment URLs and IDs, the protocol version and schema hash, and both
migration heads. Ordinary UI changes remain independent. A change to the
federation contract or either federation implementation must acquire the
cross-project federation release mutex and prove provider/consumer
compatibility before either production promotion.

Use expand-then-contract releases:

1. Deploy an additive FCUNO provider version while retaining the current one.
2. Deploy FCOS consumer support with login and sync feature flags disabled.
3. Apply and verify each project's own append-only migration.
4. Reconcile identities, verify zero-permission defaults, and drain the outbox.
5. Enable synchronization, then federated login, in separate audited steps.
6. Remove an old version only after neither production deployment advertises
   or uses it.

Never mutate the FCOS Supabase project from FCUNO, or the FCUNO Supabase
project from FCOS. Cross-project changes travel only through the signed,
versioned federation interfaces. Both databases keep RLS enabled, revoke
browser-role access to federation tables, and expose only narrow server-side
operations.

Before any GitHub mutation, verify that the authenticated account is exactly
`hocheunglai-oss`. Do not switch machine-wide credentials merely to force a
push. Before any Vercel or Supabase mutation, verify the exact identifiers
above. Chrome profile `Otto` is the final fallback only; an existing browser
session is not a reason to bypass a verified API or CLI.
