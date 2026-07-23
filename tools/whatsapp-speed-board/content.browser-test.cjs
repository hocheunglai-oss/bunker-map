const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const { chromium } = require("playwright")

const extensionSource = fs.readFileSync(path.join(__dirname, "content.js"), "utf8")
const enquiry = "lake dream / 9172442 / 7 - 8 jul / vlsfo 440mts"
const expected = `Good day, please quote for the following enquiries.\n\n${enquiry}`
const crudeWatch = {
  price: 97.57,
  change: 3.5,
  changePercent: 3.72,
  points: [95.17, 96.03, 97.61, 97.94, 97.57],
  contract: "Sep26",
  updatedAt: "2026-07-23T08:51:00.000Z",
  source: "ICE",
  sourceName: "Intercontinental Exchange",
  delayedMinutes: 15,
  verified: true,
}

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>FCUNO WhatsApp Send Harness</title>
    <style>
      body { margin: 0; font-family: Arial, sans-serif; }
      #side { width: 320px; float: left; min-height: 540px; border-right: 1px solid #ddd; }
      #search { width: 270px; margin: 16px; padding: 10px; }
      #supplierRow { display: none; padding: 16px; cursor: pointer; border-top: 1px solid #eee; }
      #main { width: 720px; min-height: 540px; margin-left: 320px; }
      header { height: 56px; display: flex; align-items: center; padding: 0 16px; }
      .messages { height: 360px; background: #f6efe5; }
      .composer-row { display: flex; align-items: flex-end; gap: 8px; padding: 12px; }
      #composer { flex: 1; min-height: 80px; border: 1px solid #ccc; padding: 10px; white-space: pre-wrap; }
      #sendButton { width: 48px; height: 48px; background: #00a884; color: #fff; }
      #sent { white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div id="side">
      <input id="search" type="text" aria-label="Search input textbox" />
      <div id="supplierRow" data-testid="cell-frame-container" onclick="window.setChatTitle('Supplier Group')">
        <span title="Supplier Group">Supplier Group</span>
      </div>
    </div>
    <div id="main">
      <header><span id="chatTitle" title="Supplier Group">Supplier Group</span></header>
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
      window.promptResponse = null;
      window.prompt = () => window.promptResponse;
      window.__FCUNO_WA_ENABLE_TEST_API__ = true;
      window.invalidateStorageOnRead = new URLSearchParams(window.location.search).get("invalidateStorage") === "1";
      window.storageListeners = new Set();
      window.storageData = {
        "fcuno-wa-speed-board-v1": {
          contacts: [{ id: "supplier-1", name: "Supplier Group", chatName: "Supplier Group", list: "supplier", order: 1000 }],
          templateEnabled: true,
          templateText: "Good day, please quote for the following enquiries."
        },
        "fcuno-wa-speed-board-enquiries-v1": {
          enquiries: [{ id: "enq-1", body: ${JSON.stringify(enquiry)}, createdAt: "2026-07-13T08:00:00Z", buyer: "OL" }]
        }
      };
      window.setChatTitle = (name) => {
        const title = document.getElementById("chatTitle");
        title.textContent = name;
        title.setAttribute("title", name);
      };
      document.getElementById("search").addEventListener("input", (event) => {
        const value = String(event.target.value || "").toLowerCase();
        document.getElementById("supplierRow").style.display = value.includes("supplier group") ? "block" : "none";
      });
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
            get: (keys, callback) => {
              if (window.invalidateStorageOnRead) throw new Error("Extension context invalidated.");
              callback(Object.fromEntries(keys.filter((key) => key in window.storageData).map((key) => [key, window.storageData[key]])));
            },
            set: (values, callback) => { Object.assign(window.storageData, values); callback?.(); }
          },
          onChanged: {
            addListener: (listener) => window.storageListeners.add(listener),
            removeListener: (listener) => window.storageListeners.delete(listener)
          }
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
      await page.waitForFunction(() => document.querySelector(".fcuno-wa-crude strong")?.textContent === "97.57")
      const loaded = await page.evaluate(() => ({
        selected: document.querySelector("[data-action='toggle-enquiry'][data-id='enq-1']")?.checked,
        contact: document.querySelector(".fcuno-wa-row strong")?.textContent,
        crudePrice: document.querySelector(".fcuno-wa-crude strong")?.textContent || "",
        crudeChange: document.querySelector(".fcuno-wa-crude span")?.textContent || "",
        crudeTitle: document.querySelector(".fcuno-wa-crude")?.getAttribute("title") || "",
        crudePath: document.querySelector(".fcuno-wa-crude path")?.getAttribute("d") || "",
      }))
      assert.equal(loaded.selected, true)
      assert.equal(loaded.contact, "Supplier Group")
      assert.equal(loaded.crudePrice, "97.57")
      assert.equal(loaded.crudeChange, "+3.50 +3.72%")
      assert.match(
        loaded.crudeTitle,
        /ICE Brent crude futures · Sep26 · delayed at least 15 minutes/,
      )
      assert.match(loaded.crudePath, /^M/)
      assert.match(loaded.crudePath, /L/)

      await page.click("#fcuno-wa-board [data-action='contact-menu'][data-id='supplier-1']", { force: true })
      const contactMenuLabels = await page.locator(".fcuno-wa-contact-menu button").allTextContents()
      assert.deepEqual(contactMenuLabels.map((label) => label.trim()), ["Rename", "Send Selected", "Remove"])
      await page.evaluate(() => { window.promptResponse = "LOCAL SUPPLIER" })
      await page.click("#fcuno-wa-board [data-action='rename-contact'][data-id='supplier-1']", { force: true })
      const renamed = await page.evaluate(() => {
        const saved = window.storageData["fcuno-wa-speed-board-v1"]
        const restored = window.__FCUNO_WA_TEST_API__.sanitizeSavedState(saved).contacts[0]
        return {
          alias: document.querySelector(".fcuno-wa-row strong")?.textContent || "",
          original: document.querySelector(".fcuno-wa-original-name")?.textContent || "",
          savedName: restored?.name || "",
          savedChatName: restored?.chatName || "",
        }
      })
      assert.deepEqual(renamed, {
        alias: "LOCAL SUPPLIER",
        original: "Supplier Group",
        savedName: "LOCAL SUPPLIER",
        savedChatName: "Supplier Group",
      })

      await page.evaluate(() => {
        window.setChatTitle("Other Chat")
        document.getElementById("search").value = ""
        document.getElementById("supplierRow").style.display = "none"
      })
      await page.click("#fcuno-wa-board [data-action='open-contact'][data-id='supplier-1']", { force: true })
      await page.waitForFunction(() => document.getElementById("chatTitle")?.getAttribute("title") === "Supplier Group")
      await page.waitForFunction(() => document.getElementById("search")?.value === "")

      const boardMainStable = await page.evaluate(() => {
        const api = window.__FCUNO_WA_TEST_API__
        const main = document.querySelector(".fcuno-wa-main")
        api.loadCrudeWatch()
        return main === document.querySelector(".fcuno-wa-main")
      })
      assert.equal(boardMainStable, true)

      await page.click("#fcuno-wa-board [data-action='contact-menu'][data-id='supplier-1']", { force: true })
      await page.click("#fcuno-wa-board [data-action='send-selected-contact'][data-id='supplier-1']", { force: true })
      await page.waitForFunction(() => window.sentMessages.length === 1, { timeout: 3000 })
      const result = await page.evaluate(() => ({
        sent: document.getElementById("sent").innerText,
        composer: document.getElementById("composer").innerText,
        insertCount: window.nativeInsertCount,
        enterCount: window.nativeEnterCount,
        chatTitle: document.getElementById("chatTitle").getAttribute("title"),
      }))
      assert.equal(result.sent, expected)
      assert.equal(result.composer, "")
      assert.equal(result.insertCount, 1)
      assert.equal(result.enterCount, 1)
      assert.equal(result.chatTitle, "Supplier Group")

      const invalidStartPage = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      const invalidStartErrors = []
      invalidStartPage.on("pageerror", (error) => invalidStartErrors.push(error.message))
      await invalidStartPage.goto(`${url}?invalidateStorage=1`, { waitUntil: "domcontentloaded" })
      await invalidStartPage.waitForTimeout(100)
      const invalidStartState = await invalidStartPage.evaluate(() => ({
        boards: document.querySelectorAll("#fcuno-wa-board").length,
        owner: document.documentElement.getAttribute("data-fcuno-whatsapp-board-owner") || "",
        activeClass: document.body.classList.contains("fcuno-wa-active") || document.body.classList.contains("fcuno-wa-collapsed"),
      }))
      assert.deepEqual(invalidStartState, { boards: 0, owner: "", activeClass: false })
      assert.deepEqual(invalidStartErrors, [])
      await invalidStartPage.close()

      const lifecyclePage = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      const lifecycleErrors = []
      const lifecycleWarnings = []
      lifecyclePage.on("pageerror", (error) => lifecycleErrors.push(error.message))
      lifecyclePage.on("console", (message) => {
        if (message.type() === "warning") lifecycleWarnings.push(message.text())
      })
      await lifecyclePage.goto(url, { waitUntil: "domcontentloaded" })
      await lifecyclePage.waitForSelector("#fcuno-wa-board")
      assert.equal(await lifecyclePage.evaluate(() => window.storageListeners.size), 1)

      await lifecyclePage.evaluate(() => {
        const originalSet = window.chrome.storage.local.set
        window.restoreStorageSet = () => { window.chrome.storage.local.set = originalSet }
        window.chrome.storage.local.set = () => { throw new Error("Extension context invalidated.") }
        window.promptResponse = "RELOAD TEST"
        window.__FCUNO_WA_TEST_API__.renameContact("supplier-1")
      })
      await lifecyclePage.waitForFunction(() => !document.getElementById("fcuno-wa-board"))
      const stoppedLifecycle = await lifecyclePage.evaluate(() => ({
        owner: document.documentElement.getAttribute("data-fcuno-whatsapp-board-owner") || "",
        activeClass: document.body.classList.contains("fcuno-wa-active") || document.body.classList.contains("fcuno-wa-collapsed"),
        storageListeners: window.storageListeners.size,
      }))
      assert.deepEqual(stoppedLifecycle, { owner: "", activeClass: false, storageListeners: 0 })

      await lifecyclePage.evaluate(() => window.restoreStorageSet())
      await lifecyclePage.addScriptTag({ content: extensionSource })
      await lifecyclePage.waitForSelector("#fcuno-wa-board")
      const restartedLifecycle = await lifecyclePage.evaluate(() => ({
        boards: document.querySelectorAll("#fcuno-wa-board").length,
        owner: document.documentElement.getAttribute("data-fcuno-whatsapp-board-owner") || "",
        storageListeners: window.storageListeners.size,
      }))
      assert.deepEqual(restartedLifecycle, { boards: 1, owner: "fcuno", storageListeners: 1 })
      assert.deepEqual(lifecycleErrors, [])
      assert.equal(lifecycleWarnings.some((message) => message.includes("already active")), false)
      await lifecyclePage.close()
    } finally {
      await browser.close()
    }
  })
}

main()
  .then(() => {
    console.log("FCUNO WhatsApp browser send test passed")
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
