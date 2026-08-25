import assert from "node:assert/strict"
import test from "node:test"
import { spcAmendmentSummaryLabels } from "../lib/spcAmendmentPresentation"

test("SPC enquiry cards show concise unique amendment labels without values", () => {
  const labels = spcAmendmentSummaryLabels([
    { label: "Vessel Name" },
    { label: "IMO" },
    { label: "Quantity" },
    { label: "Quantity" },
  ])

  assert.deepEqual(labels, ["Vessel Name Amended", "IMO Amended", "Quantity Amended"])
  assert.equal(labels.some((label) => label.includes("testing vsl") || label.includes("9821111")), false)
})

test("SPC amendment summaries ignore blank labels", () => {
  assert.deepEqual(spcAmendmentSummaryLabels([{ label: " " }, { label: null }]), [])
})
