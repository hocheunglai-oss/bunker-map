const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const { chromium } = require("playwright")

const extensionSource = fs.readFileSync(path.join(__dirname, "content.js"), "utf8")
const enquiry = "lake dream / 9172442 / 7 - 8 jul / vlsfo 440mts"
const expected = `Good day, please quote for the following enquiries.\n\n${enquiry}`
const crudeWatch = {
  price: 73.14,
  change: 0.28,
  changePercent: 0.38,
  points: [72.9, 73.0, 72.96, 73.08, 73.14],
}

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>FCUNO WhatsApp Send Harness</title>
    <style>
      body { margin: 0; font-family: Arial, sans-serif; }
      #main { width: 720px; min-height: 540px; }
      header { height: 56px; display: flex; align-items: center; padding: 0 16px; }
      .messages { height: 360px; background: #f6efe5; }
      .composer-row { display: flex; align-items: flex-end; gap: 8px; padding: 12px; }
      #composer { flex: 1; min-height: 80px; border: 1px solid #ccc; padding: 10px; white-space: pre-wrap; }
      #sendButton { width: 48px; height: 48px; background: #00a884; color: #fff; }
      #sent { white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div id="main">
      <header><span title="Supplier One">Supplier One</span></header>
      <div class="messages"><div id="sent"></div></div>
      <div class="composer-row">
        <div id="composer" contenteditable="true" role="textbox"></div>
        <button id="sendButton" aria-label="Send"><span data-icon="wds-ic-send-filled">Send</span></button>
      </div>
    </div>
    <script>
      window.sentMessages = [];
      window.editorModel = "";
      window.nativeInsertCount = 0;
      window.nativeEnterCount = 0;
      window.__FCUNO_WA_ENABLE_TEST_API__ = true;
      const storageData = {
        "fcuno-wa-speed-board-v1": {
          contacts: [{ id: "supplier-1", name: "Supplier One", chatName: "Supplier One", list: "supplier", order: 1000 }],
          templateEnabled: true,
          templateText: "Good day, please quote for the following enquiries."
        },
        "fcuno-wa-speed-board-enquiries-v1": {
          enquiries: [{ id: "enq-1", body: ${JSON.stringify(enquiry)}, createdAt: "2026-07-13T08:00:00Z", buyer: "OL" }]
        }
      };
      document.getElementById("composer").addEventListener("input", (event) => {
        window.editorModel = event.currentTarget.innerText;
      });
      document.getElementById("sendButton").addEventListener("click", () => {
        const composer = document.getElementById("composer");
        const text = window.editorModel || composer.innerText;
        if (!text) return;
        window.sentMessages.push(text);
        document.getElementById("sent").innerText = text;
        window.editorModel = "";
        composer.replaceChildren();
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: "" }));
      });
      window.chrome = {
        runtime: {
          id: "fcuno-test-extension",
          lastError: null,
          getURL: (asset) => asset,
          sendMessage: (message, callback) => {
            if (message?.type === "load-crude-watch") {
              callback({ ok: true, crude: ${JSON.stringify(crudeWatch)} });
              return;
            }
            if (message?.type === "fcuno-native-insert-text") {
              window.nativeInsertCount += 1;
              const composer = document.getElementById("composer");
              composer.replaceChildren();
              String(message.text || "").split("\\n").forEach((line, index) => {
                if (index) composer.appendChild(document.createElement("br"));
                composer.appendChild(document.createTextNode(line));
              });
              composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: message.text }));
              callback({ ok: true });
              return;
            }
            if (message?.type === "fcuno-native-enter") {
              window.nativeEnterCount += 1;
              document.getElementById("sendButton").click();
              callback({ ok: true });
              return;
            }
            callback?.({ ok: true });
          }
        },
        storage: {
          local: {
            get: (keys, callback) => callback(Object.fromEntries(keys.filter((key) => key in storageData).map((key) => [key, storageData[key]]))),
            set: (values, callback) => { Object.assign(storageData, values); callback?.(); }
          },
          onChanged: { addListener: () => {} }
        }
      };
    </script>
    <script>${extensionSource.replaceAll("</script>", "<\\/script>")}</script>
  </body>
</html>`

async function withServer(callback) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(html)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    await callback(`http://127.0.0.1:${server.address().port}/`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function main() {
  await withServer(async (url) => {
    const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      await page.goto(url, { waitUntil: "domcontentloaded" })
      await page.waitForSelector("#fcuno-wa-board [data-id='enq-1']")
      const loaded = await page.evaluate(() => ({
        selected: document.querySelector("[data-action='toggle-enquiry'][data-id='enq-1']")?.checked,
        contact: document.querySelector(".fcuno-wa-row strong")?.textContent,
      }))
      assert.equal(loaded.selected, true)
      assert.equal(loaded.contact, "Supplier One")

      const boardMainStable = await page.evaluate(() => {
        const api = window.__FCUNO_WA_TEST_API__
        const main = document.querySelector(".fcuno-wa-main")
        api.loadCrudeWatch()
        return main === document.querySelector(".fcuno-wa-main")
      })
      assert.equal(boardMainStable, true)

      await page.click("#fcuno-wa-board [data-action='send-selected']", { force: true })
      await page.waitForFunction(() => window.sentMessages.length === 1, { timeout: 3000 })
      const result = await page.evaluate(() => ({
        sent: document.getElementById("sent").innerText,
        composer: document.getElementById("composer").innerText,
        insertCount: window.nativeInsertCount,
        enterCount: window.nativeEnterCount,
      }))
      assert.equal(result.sent, expected)
      assert.equal(result.composer, "")
      assert.equal(result.insertCount, 1)
      assert.equal(result.enterCount, 1)
    } finally {
      await browser.close()
    }
  })
}

main()
  .then(() => console.log("FCUNO WhatsApp browser send test passed"))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
