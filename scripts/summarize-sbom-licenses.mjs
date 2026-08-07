import { readFile } from "node:fs/promises"

const inputPath = process.argv[2]

if (!inputPath) {
  throw new Error("Usage: node scripts/summarize-sbom-licenses.mjs <cyclonedx-sbom.json>")
}

const sbom = JSON.parse(await readFile(inputPath, "utf8"))
const components = Array.isArray(sbom.components) ? sbom.components : []

const inventory = components
  .map((component) => {
    const licenses = Array.isArray(component.licenses)
      ? component.licenses.flatMap((entry) => {
          const id = entry?.license?.id
          const name = entry?.license?.name
          const expression = entry?.expression
          return [id || name || expression].filter(Boolean)
        })
      : []

    return {
      name: component.name || "",
      version: component.version || "",
      purl: component.purl || "",
      licenses: [...new Set(licenses)].sort(),
    }
  })
  .sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  )

const missingLicenseCount = inventory.filter((component) => component.licenses.length === 0).length

process.stdout.write(
  `${JSON.stringify(
    {
      format: "informational-open-source-license-inventory",
      policyDecision: "Not evaluated; Legal/Security policy is pending.",
      componentCount: inventory.length,
      missingLicenseCount,
      components: inventory,
    },
    null,
    2,
  )}\n`,
)
