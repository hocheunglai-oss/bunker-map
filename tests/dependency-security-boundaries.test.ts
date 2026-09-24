import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"
import nodemailer from "nodemailer"
import sharp from "sharp"

type PackageVersion = { version: string }

function assertVersionFloor(actual: string, minimum: string, label: string) {
  assert.match(actual, /^\d+\.\d+\.\d+$/, `${label} must use a stable release`)
  const installed = actual.split(".").map(Number)
  const required = minimum.split(".").map(Number)
  const difference = installed.findIndex((part, index) => part !== required[index])
  assert.ok(
    difference === -1 || installed[difference] > required[difference],
    `${label} ${actual} must be at least ${minimum}`,
  )
}

function compileEmail(input: nodemailer.SendMailOptions) {
  // Stream transport compiles MIME in memory without connecting to SMTP or DNS.
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows",
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  return transport.sendMail({
    from: "FC Uno <notice@example.test>",
    subject: "Dependency compatibility check",
    html: "<p>Calendar update</p>",
    ...input,
  })
}

test("installed and locked mail/image dependencies retain their security fixes", () => {
  const lock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  ) as { packages: Record<string, PackageVersion> }
  const floors: Record<string, string> = {
    next: "16.3.3",
    nodemailer: "9.1.1",
    sharp: "0.35.4",
  }

  for (const [name, minimum] of Object.entries(floors)) {
    const packagePath = `node_modules/${name}`
    assert.ok(lock.packages[packagePath], `${name} must remain in the lockfile`)
    const installed = JSON.parse(
      readFileSync(new URL(`../${packagePath}/package.json`, import.meta.url), "utf8"),
    ) as PackageVersion
    assertVersionFloor(installed.version, minimum, `installed ${name}`)
    assert.equal(installed.version, lock.packages[packagePath].version)
  }

  for (const [packagePath, locked] of Object.entries(lock.packages)) {
    const name = packagePath.match(/(?:^|\/)node_modules\/(next|nodemailer|sharp|@img\/sharp-[^/]+)$/)?.[1]
    if (!name) continue
    const minimum = floors[name] || (name.startsWith("@img/sharp-libvips-") ? "1.3.3" : "0.35.4")
    assertVersionFloor(locked.version, minimum, `locked ${name}`)

    // Platform-specific optional packages need only be installed on their host,
    // but every platform captured by the lockfile must have the fixed release.
    const manifest = new URL(`../${packagePath}/package.json`, import.meta.url)
    if (existsSync(manifest)) {
      const installed = JSON.parse(readFileSync(manifest, "utf8")) as PackageVersion
      assertVersionFloor(installed.version, minimum, `installed ${name}`)
      assert.equal(installed.version, locked.version, `${name} must match the lockfile`)
    }
  }

  assertVersionFloor(sharp.versions.sharp, floors.sharp, "loaded Sharp")
  if (sharp.versions.heif) {
    assertVersionFloor(sharp.versions.heif, "1.23.2", "loaded libheif")
  }
})

test("network-free mail compilation preserves To, CC, BCC, display names, plus addresses, and HTML", async () => {
  const html = "<p>Calendar &amp; attendance update</p>"
  const messageId = "<dependency-security@example.test>"
  const result = await compileEmail({
    to: ["Alice Example <alice+calendar@example.test>", "Bob Trader <bob@example.test>"],
    cc: ["Operations <ops+alerts@example.test>"],
    bcc: ["Audit <audit@example.test>"],
    subject: "Event Calendar Update",
    html,
    messageId,
  })

  assert.deepEqual(result.envelope, {
    from: "notice@example.test",
    to: ["alice+calendar@example.test", "bob@example.test", "ops+alerts@example.test", "audit@example.test"],
  })
  assert.equal(result.messageId, messageId)
  assert.ok(Buffer.isBuffer(result.message))
  const message = result.message.toString("utf8")
  const headers = message.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ")
  assert.match(headers, /^From: FC Uno <notice@example\.test>$/m)
  assert.match(headers, /^To: Alice Example <alice\+calendar@example\.test>, Bob Trader <bob@example\.test>$/m)
  assert.match(headers, /^Cc: Operations <ops\+alerts@example\.test>$/m)
  assert.match(headers, /^Subject: Event Calendar Update$/m)
  assert.match(headers, /^Message-ID: <dependency-security@example\.test>$/m)
  assert.match(headers, /^Content-Type: text\/html; charset=utf-8$/m)
  assert.equal(message.split("\r\n\r\n").slice(1).join("\r\n\r\n").trimEnd(), html)
  // Stream transport deliberately retains BCC in its preview; delivery routing
  // is asserted through the envelope, not confused with SMTP's header behavior.
})

test("mail comments cannot concatenate a trusted-looking domain with a second domain", async () => {
  for (const address of [
    "user@good.example(comment)evil.example",
    "user@good.example(a(b)c)",
    "user@(comment)good.example",
    "user(comment)@good.example",
  ]) {
    const result = await compileEmail({ to: address })
    assert.deepEqual(result.envelope.to, ["user@good.example"], address)
  }
})

test("mail domain normalization follows IDN mapping without URL-style truncation", async () => {
  for (const [address, expected] of [
    ["user@compa\u00adny.example", "user@company.example"],
    ["user@bücher.example", "user@xn--bcher-kva.example"],
    ["user@attacker.example/allowed.example", "user@attacker.example/allowed.example"],
    ["user@attacker.example?allowed.example", "user@attacker.example?allowed.example"],
    ["user@attacker.example#allowed.example", "user@attacker.example#allowed.example"],
    ["user@attacker%2eexample", "user@attacker%2eexample"],
  ]) {
    const result = await compileEmail({ to: address })
    assert.deepEqual(result.envelope.to, [expected], address)
  }
})

test("a small repeated address list preserves all unique recipients without truncation", async () => {
  // Bounded compatibility coverage, not a timing-sensitive or expensive DoS probe.
  const recipients = Array.from({ length: 64 }, (_, index) => `recipient+${index}@example.test`)
  const result = await compileEmail({ to: [...recipients, ...recipients].join(", ") })
  assert.deepEqual(result.envelope.to, recipients)
})

test("patched Sharp continues to encode, decode, and resize ordinary PNG images", async () => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
  }).png().toBuffer()
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

  const resized = await sharp(png).resize(4, 4).png().toBuffer()
  const metadata = await sharp(resized).metadata()
  assert.equal(metadata.format, "png")
  assert.equal(metadata.width, 4)
  assert.equal(metadata.height, 4)
  assert.equal(metadata.channels, 4)

  const { data, info } = await sharp(resized).raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 4)
  assert.equal(info.height, 4)
  assert.equal(info.channels, 4)
  assert.equal(data.length, 4 * 4 * 4)
  for (let offset = 0; offset < data.length; offset += 4) {
    assert.deepEqual(data.subarray(offset, offset + 4), Buffer.from([12, 34, 56, 255]))
  }
})
