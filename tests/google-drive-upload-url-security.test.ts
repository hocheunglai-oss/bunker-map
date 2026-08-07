import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { requireGoogleDriveUploadSessionUrl } from "@/lib/googleDriveUploadUrl"

test("accepts only HTTPS Google Drive resumable-upload session URLs", () => {
  for (const host of ["www.googleapis.com", "content.googleapis.com"]) {
    const value = `https://${host}/upload/drive/v3/files?uploadType=resumable&upload_id=session-123`
    assert.equal(requireGoogleDriveUploadSessionUrl(value), value)
  }
})

test("rejects alternate authorities, protocols, paths, fragments, and non-session URLs", () => {
  for (const value of [
    "http://www.googleapis.com/upload/drive/v3/files?upload_id=session-123",
    "https://www.googleapis.com:444/upload/drive/v3/files?uploadType=resumable&upload_id=session-123",
    "https://www.googleapis.com.evil.example/upload/drive/v3/files?upload_id=session-123",
    "https://user@www.googleapis.com/upload/drive/v3/files?upload_id=session-123",
    "https://www.googleapis.com/drive/v3/files?upload_id=session-123",
    "https://www.googleapis.com/upload/drive/v3/files-evil?upload_id=session-123",
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=media&upload_id=session-123",
    "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-123#ignored",
    "not-a-url",
  ]) {
    assert.throws(
      () => requireGoogleDriveUploadSessionUrl(value),
      /Invalid Google Drive upload session/,
      value,
    )
  }
})

test("the upload proxy validates both returned and supplied URLs and never follows redirects", () => {
  const route = readFileSync(
    new URL("../app/api/ccinfo/upload-session/route.ts", import.meta.url),
    "utf8",
  )

  assert.match(route, /const validatedUploadUrl = requireGoogleDriveUploadSessionUrl\(uploadUrl\)/)
  assert.match(route, /const uploadUrl = requireGoogleDriveUploadSessionUrl\(String\(uploadSessionUrl\)\)/)
  assert.match(route, /fetch\(uploadUrl, \{[\s\S]*?redirect: "manual"/)
})
