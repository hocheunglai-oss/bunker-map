import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  computeEmailTemplateLibraryRevision,
  EmailTemplateConflictError,
  isEmailTemplateConflict,
} from "@/lib/emailTemplateCanonicalUtils"

test("library revision is stable across row ordering and matches the database encoding contract", () => {
  const first = computeEmailTemplateLibraryRevision([
    { id: "b", revision: 2 },
    { id: "a", revision: 1 },
  ])
  const second = computeEmailTemplateLibraryRevision([
    { id: "a", revision: 1 },
    { id: "b", revision: 2 },
  ])

  assert.equal(first, second)
  assert.equal(first, "5f549ce1437e4e54890666cefb9ce7ff07af38f7435f15fb246daca1ec6d6e2f")
  assert.notEqual(
    first,
    computeEmailTemplateLibraryRevision([
      { id: "a", revision: 1 },
      { id: "b", revision: 3 },
    ]),
  )
})

test("Postgres serialization and uniqueness failures are exposed as write conflicts", () => {
  assert.equal(isEmailTemplateConflict({ code: "40001", message: "serialization" }), true)
  assert.equal(isEmailTemplateConflict({ code: "23505", message: "duplicate slug" }), true)
  assert.equal(
    isEmailTemplateConflict({ code: "P0001", details: "EMAIL_TEMPLATE_CONFLICT" }),
    true,
  )
  assert.equal(isEmailTemplateConflict({ code: "22023", message: "invalid input" }), false)

  const conflict = new EmailTemplateConflictError()
  assert.equal(conflict.code, "EMAIL_TEMPLATE_CONFLICT")
  assert.match(conflict.message, /Reload Outlook Templates/)
})

test("runtime persistence uses only the canonical table and transactional RPCs", async () => {
  const source = await readFile(
    new URL("../lib/emailTemplates.ts", import.meta.url),
    "utf8",
  )

  assert.doesNotMatch(source, /office_calendar_store|loadLegacyLibrary|saveLegacyLibrary/)
  assert.match(source, /replace_email_template_library_canonical/)
  assert.match(source, /repair_email_templates_canonical/)
  assert.match(source, /save_email_template_canonical/)
  assert.match(source, /delete_email_template_canonical/)
})
