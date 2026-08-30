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
  assert.equal(policy.browser.fallbackProfile, "Otto")
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
