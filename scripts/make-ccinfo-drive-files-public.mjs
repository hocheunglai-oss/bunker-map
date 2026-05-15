import fs from "node:fs/promises"
import path from "node:path"
import { google } from "googleapis"
import { createClient } from "@supabase/supabase-js"

const PROJECT_ROOT = process.cwd()
const TOKEN_PATH = path.join(PROJECT_ROOT, ".google-drive-oauth-token.json")

async function loadEnv() {
  const raw = await fs.readFile(path.join(PROJECT_ROOT, ".env.local"), "utf8")
  const env = {}
  for (const line of raw.split("\n")) {
    if (!line || line.trim().startsWith("#")) continue
    const index = line.indexOf("=")
    if (index === -1) continue
    env[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")
  }
  return env
}

async function listFileIds(supabase, table) {
  const ids = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("drive_file_id")
      .not("drive_file_id", "is", null)
      .range(from, from + pageSize - 1)
    if (error) throw error
    ids.push(...((data || []).map((row) => row.drive_file_id).filter(Boolean)))
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return ids
}

async function main() {
  const env = await loadEnv()
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) throw new Error("Missing Supabase env vars.")

  const auth = new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
  )
  const tokenRaw = await fs
    .readFile(TOKEN_PATH, "utf8")
    .catch(() => (env.GOOGLE_DRIVE_REFRESH_TOKEN ? JSON.stringify({ refresh_token: env.GOOGLE_DRIVE_REFRESH_TOKEN }) : ""))
  if (!tokenRaw) throw new Error("Google Drive is not authorized. Run npm run auth:google-drive.")
  auth.setCredentials(JSON.parse(tokenRaw))

  const drive = google.drive({ version: "v3", auth })
  const supabase = createClient(supabaseUrl, supabaseKey)
  const ids = Array.from(new Set([
    ...(await listFileIds(supabase, "cc_entry_files")),
    ...(await listFileIds(supabase, "cc_company_files")),
  ]))

  let ok = 0
  let skipped = 0
  for (const fileId of ids) {
    try {
      await drive.permissions.create({
        fileId,
        requestBody: { role: "reader", type: "anyone" },
        supportsAllDrives: true,
      })
      ok += 1
    } catch (error) {
      const status = error?.code || error?.response?.status
      if (status === 409 || status === 403) skipped += 1
      else throw error
    }
    if ((ok + skipped) % 100 === 0) {
      console.log(`Processed ${ok + skipped}/${ids.length} files (public: ${ok}, skipped: ${skipped})`)
    }
  }

  console.log(`Done. Processed ${ids.length} files (public: ${ok}, skipped: ${skipped}).`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
