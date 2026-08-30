import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const contractDirectory = join(root, "contracts", "fcuno-fcos", "v1")
const manifestPath = join(contractDirectory, "contract-manifest.json")

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
const schemaFiles = (await readdir(contractDirectory))
  .filter((file) => file.endsWith(".schema.json"))
  .sort()

if (manifest.contractVersion !== "1.0") {
  throw new Error("The FCUNO-FCOS contract manifest must identify version 1.0.")
}
if (schemaFiles.length !== manifest.files.length) {
  throw new Error("The contract manifest does not list every schema file.")
}

const aggregate = createHash("sha256")
for (const file of schemaFiles) {
  const bytes = await readFile(join(contractDirectory, file))
  const expected = manifest.files.find((entry) => entry.path === file)
  if (!expected || sha256(bytes) !== expected.sha256) {
    throw new Error(`Contract schema digest mismatch: ${file}`)
  }
  JSON.parse(bytes.toString("utf8"))
  aggregate.update(file)
  aggregate.update(Buffer.from([0]))
  aggregate.update(bytes)
  aggregate.update(Buffer.from([0]))
}

if (aggregate.digest("hex") !== manifest.aggregateSha256) {
  throw new Error("The aggregate FCUNO-FCOS contract digest does not match.")
}

process.stdout.write(
  `FCUNO-FCOS contract ${manifest.contractVersion}: ${manifest.aggregateSha256}\n`,
)
