import assert from "node:assert/strict"
import test from "node:test"
import {
  resolveSpcEnquiryScope,
  SPC_SHARED_FEED_STARTED_AT,
} from "../lib/spcEnquiryScope"

test("legacy Speed Board requests retain the shared enquiry feed", () => {
  assert.equal(
    resolveSpcEnquiryScope(null, SPC_SHARED_FEED_STARTED_AT),
    "shared",
  )
})

test("normal scope-free enquiry requests remain user-owned", () => {
  assert.equal(resolveSpcEnquiryScope(null, ""), "mine")
  assert.equal(
    resolveSpcEnquiryScope(null, "2026-08-13T00:00:00.000Z"),
    "mine",
  )
})

test("explicit enquiry scopes take precedence and unknown scopes fail", () => {
  assert.equal(resolveSpcEnquiryScope("mine", SPC_SHARED_FEED_STARTED_AT), "mine")
  assert.equal(resolveSpcEnquiryScope("shared", ""), "shared")
  assert.equal(resolveSpcEnquiryScope("records", ""), "records")
  assert.equal(resolveSpcEnquiryScope("unexpected", ""), null)
})
