import fs from "node:fs/promises"
import path from "node:path"
import { buildOutlookManifest } from "./outlook-manifest.mjs"

const baseUrl = (process.env.MANIFEST_BASE_URL || "https://localhost:3002").replace(/\/$/, "")
const manifestPath = path.join(process.cwd(), "downloads", "fratelli-cosulich-templates-manifest.xml")

await fs.mkdir(path.dirname(manifestPath), { recursive: true })
await fs.writeFile(manifestPath, buildOutlookManifest(baseUrl), "utf8")
console.log(manifestPath)
