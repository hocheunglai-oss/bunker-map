import assert from "node:assert/strict"
import test from "node:test"
import {
  fcunoConnectionPolicy,
  validateFcunoConnectionPolicy,
} from "@/config/fcunoConnections"

test("FCUNO pins the approved external targets and fallback order", () => {
  const policy = validateFcunoConnectionPolicy()

  assert.deepEqual(policy.connectionOrder, ["api", "cli", "chrome"])
  assert.equal(policy.github.repository, "hocheunglai-oss/bunker-map")
  assert.equal(policy.vercel.projectId, "prj_8OifIFDF7Gcpd2i4VSRJOHjL3A9Q")
  assert.equal(policy.supabase.projectRef, "gglyugbrnyvyfktgwert")
  assert.deepEqual(policy.phonebookCardDav.hetzner, {
    writeGeneration: "hetzner-v1", writeLockName: "phonebook-carddav-writes-hetzner-v1",
    addressBookUrl: "https://nx112455.your-storageshare.de/remote.php/dav/addressbooks/users/phonebook/fcuno-phonebook/",
    username: "phonebook",
  })
  assert.equal(policy.dailyBackupReceipt.googleAccount, "wider.custom@gmail.com")
  assert.equal(policy.dailyBackupReceipt.dailyFolderId, "1-JU5aMyzGpC6tBDbhe_fBN1EmXpOpf1F")
  assert.equal(policy.browser.fallbackProfile, "Otto")
  assert.equal(policy.policyVersion, 2)
  assert.equal(policy.ecosystem.productionOrigin, "https://eco.fcuno.com")
  assert.equal(policy.ecosystem.knowledgeExtractionPath, "/api/ecosystem/knowledge-extract")
  assert.deepEqual(policy.ecosystem.backupMonitor, {
    repository: "hocheunglai-oss/ecosystem-public", repositoryId: 1427776183, ownerId: 265701760,
    branch: "main", workflowId: 391445288, workflowPath: ".github/workflows/nightly-backup.yml",
    jobName: "backup", captureStepNames: ["Capture, encrypt, verify Drive copy and retain five nights", "Capture, encrypt and verify configured backup copies"],
  })
  assert.equal(policy.federation.syncAudience, "fcos-identity-sync")
  assert.equal(policy.federation.syncJwksUrl, "https://fcuno.com/api/fcos-identity-sync/jwks")
  assert.equal(policy.federation.fcos.syncEndpoint, "https://fcos.fcuno.com/api/fcuno/identity-sync")
})

test("phonebook writer target rejects a different owner or generation lock", () => {
  for (const overrides of [{ username: "admin" }, { writeLockName: "phonebook-carddav-writes" }, { writeGeneration: "arbitrary" }]) {
    assert.throws(() => validateFcunoConnectionPolicy({ ...fcunoConnectionPolicy,
      phonebookCardDav: { hetzner: { ...fcunoConnectionPolicy.phonebookCardDav.hetzner, ...overrides } },
    }), /approved writer generation/)
  }
})

test("FCUNO and FCOS retain separate projects", () => {
  const policy = validateFcunoConnectionPolicy()

  assert.notEqual(
    policy.supabase.projectRef,
    policy.federation.fcos.supabaseProjectRef,
  )
  assert.notEqual(policy.vercel.projectId, policy.federation.fcos.vercelProjectId)
})

test("connection order and browser fallback fail closed", () => {
  const wrongOrder = {
    ...fcunoConnectionPolicy,
    connectionOrder: ["chrome", "api", "cli"] as unknown as typeof fcunoConnectionPolicy.connectionOrder,
  }
  assert.throws(
    () => validateFcunoConnectionPolicy(wrongOrder),
    /API, CLI, then Chrome/,
  )

  const wrongBrowser = {
    ...fcunoConnectionPolicy,
    browser: { fallbackProfile: "Vincent" as "Otto" },
  }
  assert.throws(
    () => validateFcunoConnectionPolicy(wrongBrowser),
    /Otto profile/,
  )
})
