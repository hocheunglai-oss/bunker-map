const GOOGLE_DRIVE_UPLOAD_HOSTS = new Set([
  "www.googleapis.com",
  "content.googleapis.com",
])

export function requireGoogleDriveUploadSessionUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Invalid Google Drive upload session.")
  }

  const validPath =
    url.pathname === "/upload/drive/v3/files" ||
    url.pathname.startsWith("/upload/drive/v3/files/")
  const validAuthority =
    url.protocol === "https:" &&
    GOOGLE_DRIVE_UPLOAD_HOSTS.has(url.hostname) &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.hash

  if (
    !validAuthority ||
    !validPath ||
    url.searchParams.get("uploadType") !== "resumable" ||
    !url.searchParams.get("upload_id")
  ) {
    throw new Error("Invalid Google Drive upload session.")
  }

  return url.toString()
}
