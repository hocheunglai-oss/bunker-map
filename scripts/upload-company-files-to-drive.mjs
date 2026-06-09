import fs from "node:fs"
import fsPromises from "node:fs/promises"
import path from "node:path"
import readline from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { google } from "googleapis"
import { createClient } from "@supabase/supabase-js"

const DRIVE_ROOT = "/Volumes/T7 Shield"
const COMPANY_ROOT = path.join(DRIVE_ROOT, "- Company Information")
const TOKEN_PATH = path.join(process.cwd(), ".google-drive-oauth-token.json")

const env = await loadEnv(path.join(process.cwd(), ".env.local"))

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const driveCompanyFolderId = env.GOOGLE_DRIVE_COMPANY_FOLDER_ID
const driveSharedDriveId = env.GOOGLE_DRIVE_SHARED_DRIVE_ID || null
const oauthClientId = env.GOOGLE_OAUTH_CLIENT_ID
const oauthClientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET
const oauthRedirectUri = env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1"

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase env vars in .env.local")
  process.exit(1)
}

if (!oauthClientId || !oauthClientSecret || !driveCompanyFolderId) {
  console.error("Missing Google OAuth env vars in .env.local")
  console.error("Required: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_DRIVE_COMPANY_FOLDER_ID")
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

const folderCache = new Map()
const forceUpload = process.env.FORCE_COMPANY_FILE_UPLOAD === "1"

async function loadEnv(filePath) {
  const raw = await fsPromises.readFile(filePath, "utf8")
  const pairs = {}
  for (const line of raw.split("\n")) {
    if (!line || line.trim().startsWith("#")) continue
    const idx = line.indexOf("=")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    pairs[key] = value
  }
  return pairs
}

async function createDriveClient() {
  const auth = new google.auth.OAuth2(
    oauthClientId,
    oauthClientSecret,
    oauthRedirectUri,
  )

  try {
    const saved = await fsPromises.readFile(TOKEN_PATH, "utf8")
    auth.setCredentials(JSON.parse(saved))
  } catch {
    await authorizeOAuth(auth)
  }

  auth.on("tokens", async (tokens) => {
    if (!tokens || Object.keys(tokens).length === 0) return
    const merged = { ...(auth.credentials || {}), ...tokens }
    await fsPromises.writeFile(TOKEN_PATH, JSON.stringify(merged, null, 2), "utf8")
  })

  return google.drive({ version: "v3", auth })
}

async function authorizeOAuth(auth) {
  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive"],
  })

  console.log("\nOpen this URL in your browser and sign in to Google Drive:")
  console.log(authUrl)
  console.log("\nAfter approval, paste the full redirected URL here.")

  const rl = readline.createInterface({ input, output })
  const redirectedUrl = await rl.question("Redirected URL: ")
  rl.close()

  const parsed = new URL(redirectedUrl.trim())
  const code = parsed.searchParams.get("code")

  if (!code) {
    throw new Error("No authorization code found in redirected URL.")
  }

  const { tokens } = await auth.getToken(code)
  auth.setCredentials(tokens)
  await fsPromises.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8")
}

function normalizeWhitespace(value) {
  return value.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").trim()
}

function formatName(folderName) {
  return normalizeWhitespace(
    folderName
      .replace(/^!+/, "")
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase()),
  )
}

function nameKey(value) {
  return normalizeWhitespace(value).toUpperCase()
}

async function safeReaddir(dirPath, options = { withFileTypes: true }) {
  try {
    return await fsPromises.readdir(dirPath, options)
  } catch {
    return []
  }
}

async function fetchCompanies() {
  const batchSize = 1000
  let from = 0
  const rows = []

  while (true) {
    const { data, error } = await supabase
      .from("cc_companies")
      .select("id,name")
      .order("name", { ascending: true })
      .range(from, from + batchSize - 1)

    if (error) throw error

    const batch = data || []
    rows.push(...batch)
    if (batch.length < batchSize) break
    from += batchSize
  }

  return rows
}

async function fetchExistingCompanyFiles() {
  const batchSize = 1000
  let from = 0
  const rows = []

  while (true) {
    const { data, error } = await supabase
      .from("cc_company_files")
      .select("id,company_id,original_path,drive_file_id,drive_url")
      .range(from, from + batchSize - 1)

    if (error) throw error

    const batch = data || []
    rows.push(...batch)
    if (batch.length < batchSize) break
    from += batchSize
  }

  return new Map(rows.map((row) => [`${row.company_id}:${row.original_path}`, row]))
}

async function ensureDriveFolder(drive, parentId, name) {
  const cacheKey = `${parentId}:${name}`
  if (folderCache.has(cacheKey)) return folderCache.get(cacheKey)

  const promise = (async () => {
    const q = [
      "trashed = false",
      "mimeType = 'application/vnd.google-apps.folder'",
      `name = '${name.replace(/'/g, "\\'")}'`,
      `'${parentId}' in parents`,
    ].join(" and ")

    const listResponse = await drive.files.list({
      q,
      fields: "files(id,name)",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: driveSharedDriveId ? "drive" : undefined,
      driveId: driveSharedDriveId || undefined,
    })

    const existing = listResponse.data.files?.[0]
    if (existing?.id) return existing.id

    const createResponse = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id",
      supportsAllDrives: true,
    })

    const newId = createResponse.data.id
    if (!newId) throw new Error(`Unable to create folder ${name}`)
    return newId
  })()

  folderCache.set(cacheKey, promise)
  try {
    const folderId = await promise
    folderCache.set(cacheKey, Promise.resolve(folderId))
    return folderId
  } catch (error) {
    folderCache.delete(cacheKey)
    throw error
  }
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case ".pdf":
      return "application/pdf"
    case ".doc":
      return "application/msword"
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    case ".xls":
      return "application/vnd.ms-excel"
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    case ".ppt":
      return "application/vnd.ms-powerpoint"
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    case ".txt":
      return "text/plain"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".png":
      return "image/png"
    default:
      return "application/octet-stream"
  }
}

async function uploadFileToDrive(drive, filePath, parentFolderId) {
  const response = await drive.files.create({
    requestBody: {
      name: path.basename(filePath),
      parents: [parentFolderId],
    },
    media: {
      mimeType: getMimeType(filePath),
      body: fs.createReadStream(filePath),
    },
    fields: "id, webViewLink, webContentLink, name",
    supportsAllDrives: true,
  })

  const fileId = response.data.id
  if (!fileId) throw new Error(`Unable to upload ${filePath}`)
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
    supportsAllDrives: true,
  })

  return {
    fileId,
    url: response.data.webViewLink || response.data.webContentLink || `https://drive.google.com/file/d/${fileId}/view`,
  }
}

async function upsertCompanyFile(row) {
  const { data: existing, error: selectError } = await supabase
    .from("cc_company_files")
    .select("id")
    .eq("company_id", row.company_id)
    .eq("original_path", row.original_path)
    .maybeSingle()

  if (selectError) throw selectError

  if (existing?.id) {
    const { error: updateError } = await supabase
      .from("cc_company_files")
      .update({
        file_name: row.file_name,
        file_type: row.file_type,
        drive_file_id: row.drive_file_id,
        drive_url: row.drive_url,
      })
      .eq("id", existing.id)

    if (updateError) throw updateError
    return
  }

  const { error: insertError } = await supabase
    .from("cc_company_files")
    .insert(row)

  if (insertError) throw insertError
}

async function collectFiles(rootDir) {
  const files = []

  async function walk(currentDir) {
    const entries = await safeReaddir(currentDir)
    for (const entry of entries) {
      if (shouldSkipEntry(entry.name)) continue
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else {
        try {
          await fsPromises.access(fullPath)
          files.push(fullPath)
        } catch {
          console.warn(`Skipping unreadable local file: ${fullPath}`)
        }
      }
    }
  }

  await walk(rootDir)
  return files.sort((a, b) => a.localeCompare(b))
}

function shouldSkipEntry(name) {
  const lower = name.toLowerCase()
  return (
    name.startsWith("._") ||
    name.startsWith("~$") ||
    name === ".DS_Store" ||
    lower === "thumbs.db" ||
    lower.endsWith(".tmp")
  )
}

async function main() {
  const drive = await createDriveClient()
  console.log("Loading company records...")
  const companies = await fetchCompanies()
  const companyIdByName = new Map(companies.map((item) => [nameKey(item.name), item.id]))
  const existingFiles = await fetchExistingCompanyFiles()

  const entries = (await safeReaddir(COMPANY_ROOT))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))

  let uploadedCount = 0
  let linkedCount = 0
  let skippedCount = 0
  let failedCount = 0
  const pendingFiles = []

  for (const entry of entries) {
    const companyDir = path.join(COMPANY_ROOT, entry.name)
    const companyName = formatName(entry.name)
    const companyId = companyIdByName.get(nameKey(companyName))

    if (!companyId) {
      console.log(`Skipping ${companyName}: no matching cc_companies record`)
      continue
    }

    const files = await collectFiles(companyDir)

    for (const filePath of files) {
      const existingKey = `${companyId}:${filePath}`
      const existing = existingFiles.get(existingKey)

      if (!forceUpload && existing?.drive_file_id && existing?.drive_url) {
        skippedCount += 1
        if (skippedCount % 100 === 0) {
          console.log(`Skipped ${skippedCount} already linked files`)
        }
        continue
      }

      pendingFiles.push({ companyDir, companyName, companyId, entryName: entry.name, filePath, existingKey, existing })
    }
  }

  pendingFiles.sort((a, b) => {
    const aPriority = ["SGS", "TAIMIN PETROLEUM"].includes(nameKey(a.companyName)) ? 0 : 1
    const bPriority = ["SGS", "TAIMIN PETROLEUM"].includes(nameKey(b.companyName)) ? 0 : 1
    if (aPriority !== bPriority) return aPriority - bPriority
    return a.companyName.localeCompare(b.companyName) || a.filePath.localeCompare(b.filePath)
  })

  console.log(`Queued ${pendingFiles.length} missing file${pendingFiles.length === 1 ? "" : "s"} for upload.`)

  async function uploadPendingFile(task) {
    const { companyDir, companyName, companyId, entryName, filePath, existingKey, existing } = task
    const relative = path.relative(companyDir, filePath)
    const parentSegments = path.dirname(relative) === "." ? [] : path.dirname(relative).split(path.sep)

    try {
      const companyFolderId = await ensureDriveFolder(drive, driveCompanyFolderId, entryName)
      let parentId = companyFolderId
      for (const segment of parentSegments) {
        parentId = await ensureDriveFolder(drive, parentId, segment)
      }

      const { fileId, url } = await uploadFileToDrive(drive, filePath, parentId)
      uploadedCount += 1

      await upsertCompanyFile({
        company_id: companyId,
        file_name: path.basename(filePath),
        file_type: path.extname(filePath).slice(1).toLowerCase() || "file",
        drive_file_id: fileId,
        drive_url: url,
        original_path: filePath,
      })
      existingFiles.set(existingKey, {
        id: existing?.id,
        company_id: companyId,
        original_path: filePath,
        drive_file_id: fileId,
        drive_url: url,
      })
      linkedCount += 1

      if (uploadedCount % 25 === 0 || uploadedCount === pendingFiles.length) {
        console.log(`Uploaded ${uploadedCount}/${pendingFiles.length} files / linked ${linkedCount} (${companyName})`)
      }
    } catch (error) {
      failedCount += 1
      console.warn(`Failed to upload ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const concurrency = Number(process.env.COMPANY_FILE_UPLOAD_CONCURRENCY || 8)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < pendingFiles.length) {
      const task = pendingFiles[nextIndex]
      nextIndex += 1
      await uploadPendingFile(task)
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))

  console.log(`Done. Uploaded ${uploadedCount} files, linked ${linkedCount}, skipped ${skippedCount}, failed ${failedCount}.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
