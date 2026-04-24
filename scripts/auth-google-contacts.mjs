import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import readline from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { google } from "googleapis"

const PROJECT_ROOT = process.cwd()
const TOKEN_PATH = path.join(PROJECT_ROOT, ".google-people-oauth-token.json")

function loadEnv(filePath) {
  const raw = fsSync.readFileSync(filePath, "utf8")
  const pairs = {}
  for (const line of raw.split("\n")) {
    if (!line || line.trim().startsWith("#")) continue
    const idx = line.indexOf("=")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    pairs[key] = value
  }
  return pairs
}

async function main() {
  const env = loadEnv(path.join(PROJECT_ROOT, ".env.local"))
  const auth = new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
  )

  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/contacts"],
  })

  console.log("\nOpen this URL in your browser and approve Google Contacts access:")
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
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8")
  console.log(`Saved Google Contacts token to ${TOKEN_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
