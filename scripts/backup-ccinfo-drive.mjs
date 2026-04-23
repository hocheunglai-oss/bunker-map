import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { google } from "googleapis"

const PROJECT_ROOT = process.cwd()
const TOKEN_PATH = path.join(PROJECT_ROOT, ".google-drive-oauth-token.json")
const OUTPUT_ROOT = path.join(PROJECT_ROOT, "backups", "ccinfo-drive")

function loadEnv() {
  return Object.fromEntries(
    fs
      .readFileSync(path.join(PROJECT_ROOT, ".env.local"), "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((line) => !line.trim().startsWith("#"))
      .map((line) => {
        const idx = line.indexOf("=")
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "")]
      }),
  )
}

async function getDriveClient() {
  const env = loadEnv()
  const auth = new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
  )
  auth.setCredentials(JSON.parse(await fsp.readFile(TOKEN_PATH, "utf8")))
  return {
    drive: google.drive({ version: "v3", auth }),
    rootFolderId: env.GOOGLE_DRIVE_COMPANY_FOLDER_ID,
  }
}

async function findFolderByName(drive, parentId, name) {
  const escapedName = name.replace(/'/g, "\\'")
  const result = await drive.files.list({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and '${parentId}' in parents`,
    fields: "files(id,name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  return result.data.files?.[0] || null
}

async function listChildren(drive, parentId) {
  const items = []
  let pageToken
  do {
    const result = await drive.files.list({
      q: `trashed = false and '${parentId}' in parents`,
      fields: "nextPageToken, files(id,name,mimeType,webViewLink,modifiedTime,size)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    items.push(...(result.data.files || []))
    pageToken = result.data.nextPageToken || undefined
  } while (pageToken)
  return items
}

async function downloadFile(drive, fileId, outputPath) {
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" },
  )
  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  await pipeline(response.data, fs.createWriteStream(outputPath))
}

async function walkFolder(drive, folderId, relativePath, manifest) {
  const children = await listChildren(drive, folderId)
  for (const child of children) {
    if (!child.id || !child.name) continue
    const nextRelative = relativePath ? path.join(relativePath, child.name) : child.name
    if (child.mimeType === "application/vnd.google-apps.folder") {
      await walkFolder(drive, child.id, nextRelative, manifest)
      continue
    }
    const outputPath = path.join(OUTPUT_ROOT, nextRelative)
    await downloadFile(drive, child.id, outputPath)
    manifest.push({
      id: child.id,
      name: child.name,
      relativePath: nextRelative,
      webViewLink: child.webViewLink || "",
      modifiedTime: child.modifiedTime || null,
      size: child.size || null,
    })
    console.log(`Downloaded ${nextRelative}`)
  }
}

async function main() {
  const { drive, rootFolderId } = await getDriveClient()
  if (!rootFolderId) {
    throw new Error("GOOGLE_DRIVE_COMPANY_FOLDER_ID is not configured.")
  }

  const manualUploadsFolder = await findFolderByName(drive, rootFolderId, "Manual Uploads")
  if (!manualUploadsFolder?.id) {
    throw new Error("Could not find 'Manual Uploads' in Google Drive root folder.")
  }

  await fsp.mkdir(OUTPUT_ROOT, { recursive: true })
  const manifest = []
  await walkFolder(drive, manualUploadsFolder.id, "", manifest)

  const manifestPath = path.join(OUTPUT_ROOT, `manifest-${new Date().toISOString().slice(0, 10)}.json`)
  await fsp.writeFile(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: manifest.length,
        files: manifest,
      },
      null,
      2,
    ),
    "utf8",
  )

  console.log(`Backup complete. ${manifest.length} files downloaded to ${OUTPUT_ROOT}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
