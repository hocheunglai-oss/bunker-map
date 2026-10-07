import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import nodemailer, { type SendMailOptions } from "nodemailer"
import sharp from "sharp"

type PackageVersion = { version: string }
const require = createRequire(import.meta.url)

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

function compileEmail(input: SendMailOptions) {
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

test("installed and locked dependencies retain their security fixes", () => {
  const lock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  ) as { packages: Record<string, PackageVersion> }
  const floors: Record<string, string> = {
    next: "16.3.3",
    nodemailer: "10.0.13",
    sharp: "0.35.5",
    "source-map-js": "1.2.2",
    uuid: "11.1.1",
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
    const name = packagePath.match(/(?:^|\/)node_modules\/(next|nodemailer|sharp|source-map-js|uuid|brace-expansion|@img\/sharp-[^/]+)$/)?.[1]
    if (!name) continue
    const braceFloors: Record<string, string> = { 1: "1.1.21", 2: "2.1.7", 3: "3.0.9", 5: "5.0.12" }
    const minimum = name === "brace-expansion"
      ? braceFloors[locked.version.split(".")[0]]
      : floors[name] || (name.startsWith("@img/sharp-libvips-") ? "1.3.4" : "0.35.5")
    assert.ok(minimum, `${name} must use a security-supported release line`)
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
  assertVersionFloor(sharp.versions.rsvg ?? "", "2.63.2", "loaded SVG renderer")
  if (sharp.versions.heif) {
    assertVersionFloor(sharp.versions.heif, "1.23.2", "loaded libheif")
  }
})

test("source maps reject unsafe indexed offsets and preserve ordinary mappings and bounded legal offsets", () => {
  execFileSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const { SourceMapConsumer, SourceMapGenerator, SourceNode } = require("source-map-js");
    const basic = { version: 3, sources: ["input.js"], sourcesContent: ["x"], names: [], mappings: "AAAA" };
    const indexed = (line, column, map = basic) => ({ version: 3, sections: [{ offset: { line, column }, map }] });
    for (const line of [Infinity, 1e12, -1, 1.5, "100", null]) {
      assert.throws(() => new SourceMapConsumer(indexed(line, 0)));
    }
    for (const column of [Infinity, Number.MAX_SAFE_INTEGER + 1, -1, 1.5, "100", null]) {
      assert.throws(() => new SourceMapConsumer(indexed(0, column)));
    }
    assert.throws(() => new SourceMapConsumer(indexed(6000000, 0, indexed(6000000, 0))));
    const consumer = new SourceMapConsumer(indexed(10000000, 0));
    assert.equal(SourceNode.fromStringWithSourceMap("x", consumer).toStringWithSourceMap().code, "x");
    const generator = new SourceMapGenerator({ file: "output.js" });
    generator.addMapping({ generated: { line: 1, column: 0 }, original: { line: 3, column: 2 }, source: "input.js" });
    const ordinary = new SourceMapConsumer(generator.toJSON());
    assert.deepEqual(ordinary.originalPositionFor({ line: 1, column: 0 }), { source: "input.js", line: 3, column: 2, name: null });
  `], { cwd: new URL("..", import.meta.url), timeout: 5000, stdio: "pipe" })
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
    '"user"@good.example(comment)evil.example',
    '"user"@good.example(a)evil.example(b)another.example',
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

test("malformed mail addresses cannot stall the parser or overflow recipient flattening", () => {
  // Run the advisory shapes in a separate, bounded process so a regressed
  // dependency cannot block the test runner's own event loop indefinitely.
  execFileSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const parse = require("nodemailer/lib/addressparser");
    const run = "[x]".repeat(40000);
    for (const value of [run, run + "@", "@" + run, " >" + ">[x][x]".repeat(40000)]) {
      assert.ok(Array.isArray(parse(value)));
    }
    const nodemailer = require("nodemailer");
    let to = "recipient@example.test";
    for (let depth = 0; depth < 5000; depth++) to = [to];
    nodemailer.createTransport({ streamTransport: true, buffer: true })
      .sendMail({ from: "sender@example.test", to, text: "test" })
      .then(result => assert.deepEqual(result.envelope.to, ["recipient@example.test"]))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: new URL("..", import.meta.url), timeout: 5000, stdio: "pipe" })
})

test("all locked brace parsers bound malicious nesting and preserve normal expansion", () => {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    packages: Record<string, PackageVersion>
  }
  for (const packagePath of Object.keys(lock.packages).filter(path => path.endsWith("/brace-expansion"))) {
    execFileSync(process.execPath, ["-e", `
      const assert = require("node:assert/strict");
      const loaded = require(${JSON.stringify(`./${packagePath}`)});
      const expand = typeof loaded === "function" ? loaded : loaded.expand;
      assert.deepEqual(expand("file-{a,b}.txt"), ["file-a.txt", "file-b.txt"]);
      for (const value of [
        "{".repeat(3200) + "a,b" + "}".repeat(3200),
        "{a,".repeat(4000) + "z" + "}".repeat(4000),
        "{a}" + "}".repeat(128000) + ",z}"
      ]) assert.ok(Array.isArray(expand(value)));
    `], { cwd: new URL("..", import.meta.url), timeout: 5000, stdio: "pipe" })
  }
})

test("Google HTTP clients retain CommonJS UUID generation with checked buffer bounds", () => {
  // Resolve from each actual consumer, covering its nested dependency layout.
  for (const consumer of [
    "../node_modules/@google-cloud/storage/node_modules/gaxios/package.json",
    "../node_modules/gtoken/node_modules/gaxios/package.json",
    "../node_modules/teeny-request/package.json",
  ]) {
    const consumerRequire = createRequire(new URL(consumer, import.meta.url))
    const uuid = consumerRequire("uuid") as typeof import("uuid")
    assert.match(uuid.v4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    for (const generate of [uuid.v3, uuid.v5]) {
      assert.throws(() => generate("example", uuid.v5.DNS, Buffer.alloc(1)), RangeError)
      assert.throws(() => generate("example", uuid.v5.DNS, Buffer.alloc(16), -1), RangeError)
    }
    assert.throws(() => uuid.v6({}, Buffer.alloc(1)), RangeError)
  }
  // Load the backup's SDK through its CommonJS entry without making a request.
  const { Storage } = require("@google-cloud/storage") as typeof import("@google-cloud/storage")
  assert.equal(new Storage({ projectId: "test-only" }).bucket("test-only").file("manifest.json").name, "manifest.json")
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

test("patched SVG renderer retains ordinary image conversion", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#0c2238"/></svg>')
  const { data, info } = await sharp(svg).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 2)
  assert.equal(info.height, 2)
  assert.deepEqual(data.subarray(0, 4), Buffer.from([12, 34, 56, 255]))
})
