import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { google } from "googleapis"

const PROJECT_ROOT = process.cwd()
const TOKEN_PATH = path.join(PROJECT_ROOT, ".google-calendar-oauth-token.json")

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

async function main() {
  const env = loadEnv()
  const auth = new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
  )

  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
  })

  console.log("\nOpen this URL in your browser and approve Google Calendar event access:")
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
  await fsp.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8")
  console.log(`Saved Google Calendar token to ${TOKEN_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
