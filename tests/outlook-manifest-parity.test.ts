import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  buildOutlookManifest,
  OUTLOOK_ADDIN_ASSET_VERSION,
  OUTLOOK_ADDIN_ICON_SIZES,
  OUTLOOK_ADDIN_VERSION,
} from "../scripts/outlook-manifest.mjs"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const productionBaseUrl = "https://fcuno.com"
const checkedInManifestPath = path.join(
  projectRoot,
  "downloads",
  "fratelli-cosulich-templates-manifest.xml"
)

test("checked-in and generated Outlook manifests have exact production parity", async () => {
  const checkedIn = await readFile(checkedInManifestPath, "utf8")
  const generated = buildOutlookManifest(productionBaseUrl)

  assert.equal(checkedIn, generated)
  assert.match(generated, new RegExp(`<Version>${OUTLOOK_ADDIN_VERSION.replaceAll(".", "\\.")}</Version>`))
  assert.match(generated, new RegExp(`taskpane\\?v=${OUTLOOK_ADDIN_ASSET_VERSION}`))
  assert.match(generated, new RegExp(`commands\\?v=${OUTLOOK_ADDIN_ASSET_VERSION}`))
  assert.match(generated, /<Set Name="Mailbox" MinVersion="1\.4"\/>/)
  assert.match(generated, /<bt:Sets DefaultMinVersion="1\.4">/)
  assert.match(generated, /<bt:Sets DefaultMinVersion="1\.5">/)
  assert.doesNotMatch(generated, /localhost|127\.0\.0\.1|access[_-]?token|client[_-]?secret|password/i)
})

test("protected manifest route delegates XML generation without a second manifest copy", async () => {
  const routeSource = await readFile(
    path.join(projectRoot, "app", "api", "outlook-addin", "manifest", "route.ts"),
    "utf8"
  )

  assert.match(routeSource, /import \{ buildOutlookManifest \} from "@\/scripts\/outlook-manifest\.mjs"/)
  assert.match(routeSource, /buildOutlookManifest\(buildBaseUrl\(request\)\)/)
  assert.doesNotMatch(routeSource, /<OfficeApp|ADDIN_ASSET_VERSION|function xmlEscape/)
})

test("manifest XML is well-formed", () => {
  const manifest = buildOutlookManifest(productionBaseUrl)
  const result = spawnSync("xmllint", ["--noout", "-"], {
    encoding: "utf8",
    input: manifest,
  })

  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
})

test("manifest references every schema-valid icon size in the right location", () => {
  const manifest = buildOutlookManifest(productionBaseUrl)

  assert.deepEqual(OUTLOOK_ADDIN_ICON_SIZES, [16, 32, 64, 80, 128])
  assert.match(
    manifest,
    /<IconUrl DefaultValue="https:\/\/fcuno\.com\/outlook-template-icon-64\.png"\/>/
  )
  assert.match(
    manifest,
    /<HighResolutionIconUrl DefaultValue="https:\/\/fcuno\.com\/outlook-template-icon-128\.png"\/>/
  )

  for (const size of [16, 32, 64, 80]) {
    assert.match(
      manifest,
      new RegExp(`<bt:Image size="${size}" resid="Icon\\.${size}"\\/>`)
    )
    assert.match(
      manifest,
      new RegExp(
        `<bt:Image id="Icon\\.${size}" DefaultValue="https://fcuno\\.com/outlook-template-icon-${size}\\.png"\\/>`
      )
    )
  }

  assert.doesNotMatch(manifest, /<bt:Image (?:size="128"|id="Icon\.128")/)
})

test("all referenced Outlook icon assets are real PNGs with exact dimensions", async () => {
  for (const size of OUTLOOK_ADDIN_ICON_SIZES) {
    const iconPath = path.join(projectRoot, "public", `outlook-template-icon-${size}.png`)
    const png = await readFile(iconPath)

    assert.deepEqual(
      [...png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${path.basename(iconPath)} must be a PNG`
    )
    assert.equal(png.readUInt32BE(16), size, `${path.basename(iconPath)} width`)
    assert.equal(png.readUInt32BE(20), size, `${path.basename(iconPath)} height`)
  }
})
