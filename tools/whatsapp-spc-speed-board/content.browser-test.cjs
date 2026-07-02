const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const { chromium } = require("playwright")

const extensionSource = fs.readFileSync(path.join(__dirname, "content.js"), "utf8")
const enquiry = "taisei maru no.15 / 8710728 / 14 - 15 jan / vlsfo 600mts"
const enquiry2 = "shan ren / 9474606 / 11 - 13 jan / vlsfo 110mts / lsmgo 55mts"
const enquiry3 = "a keiga / 9385453 / 3 oct / vlsfo 260mts"
const expected = `Good day, please quote for the following enquiries.\n\n${enquiry}`

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>SPC WhatsApp Send Harness</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 0; }
      #side { width: 360px; float: left; min-height: 540px; border-right: 1px solid #ddd; }
      #search { width: 300px; margin: 16px; padding: 10px; }
      #renamedRow { display: none; padding: 16px; cursor: pointer; border-top: 1px solid #eee; }
      #main { width: 720px; min-height: 540px; }
      header { height: 56px; border-bottom: 1px solid #ddd; display: flex; align-items: center; padding: 0 16px; }
      .messages { height: 360px; background: #f6efe5; }
      .composer-row { display: flex; align-items: flex-end; gap: 8px; padding: 12px; }
      #composer { flex: 1; min-height: 120px; border: 1px solid #ccc; border-radius: 18px; padding: 10px; white-space: pre-wrap; }
      #sendButton { width: 48px; height: 48px; border-radius: 50%; background: #00a884; color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; }
      #decoySend { margin: 24px; padding: 8px 12px; }
      #sent { white-space: pre-wrap; border-top: 1px solid #ddd; padding: 10px; }
    </style>
  </head>
  <body>
    <div id="side">
      <input id="search" type="text" aria-label="Search input textbox" />
      <div id="renamedRow" data-testid="cell-frame-container" onclick="window.setChatTitle('Otto Tone')">
        <span title="Otto Tone">Otto Tone</span>
      </div>
    </div>
    <div id="main">
      <header><span id="chatTitle" title="Otto Tone">Otto Tone</span></header>
      <div class="messages">
        <button id="decoySend" aria-label="Send" onclick="window.decoyClicks += 1">Old send-like control</button>
      </div>
      <div class="composer-row">
        <div id="composer" contenteditable="true" role="textbox"></div>
        <div id="sendButton" role="button" onclick="
          if (!window.editorModel) return;
          window.sentMessages.push(window.editorModel);
          document.getElementById('sent').textContent = window.sentMessages.join('\\n---\\n');
          window.editorModel = '';
          document.getElementById('composer').replaceChildren();
          document.getElementById('composer').dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        "><span data-icon="wds-ic-send-filled">send</span></div>
      </div>
    </div>
    <pre id="sent"></pre>
    <script>
      window.sentMessages = [];
      window.decoyClicks = 0;
      window.editorModel = "";
      window.nativeEnterCount = 0;
      window.nativeClickCount = 0;
      window.nativeInsertCount = 0;
      window.nativeEnterShouldSend = false;
      window.__FCUNO_WA_SPC_ENABLE_TEST_API__ = true;
      window.setChatTitle = (name) => {
        const title = document.getElementById("chatTitle");
        title.textContent = name;
        title.setAttribute("title", name);
      };
      document.getElementById("search").addEventListener("input", (event) => {
        const value = String(event.target.value || "").toLowerCase();
        document.getElementById("renamedRow").style.display = value.includes("otto tone") ? "block" : "none";
      });
      window.chrome = {
        runtime: {
          id: "fcuno-spc-test-extension",
          lastError: null,
          getURL: (asset) => asset,
          sendMessage: (message, callback) => {
            if (message && message.type === "load-spc-enquiries") {
              callback({
                ok: true,
                enquiries: [
                  {
                    id: "enq-1",
                    formattedText: ${JSON.stringify(enquiry)},
                    createdAt: "2026-07-01T08:00:00Z",
                    status: "sent",
                    createdByDisplayName: "OL"
                  },
                  {
                    id: "enq-2",
                    formattedText: ${JSON.stringify(enquiry2)},
                    createdAt: "2026-07-01T08:05:00Z",
                    status: "sent",
                    createdByDisplayName: "OL"
                  },
                  {
                    id: "enq-3",
                    formattedText: ${JSON.stringify(enquiry3)},
                    createdAt: "2026-07-01T08:10:00Z",
                    status: "sent",
                    createdByDisplayName: "OL"
                  }
                ]
              });
              return;
            }
            if (message && message.type === "spc-native-click") {
              window.nativeClickCount += 1;
              const target = document.elementFromPoint(Number(message.x), Number(message.y));
              const clickable = target && target.closest("button,[role='button']");
              if (clickable) clickable.click();
              callback({ ok: Boolean(clickable) });
              return;
            }
            if (message && message.type === "spc-native-insert-text") {
              window.nativeInsertCount += 1;
              window.editorModel = String(message.text || "");
              const composer = document.getElementById("composer");
              composer.replaceChildren();
              String(message.text || "").split("\\n").forEach((line, index) => {
                if (index > 0) composer.appendChild(document.createElement("br"));
                composer.appendChild(document.createTextNode(line));
              });
              composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(message.text || "") }));
              callback({ ok: true });
              return;
            }
            if (message && message.type === "spc-native-enter") {
              window.nativeEnterCount += 1;
              if (window.nativeEnterShouldSend) document.getElementById("sendButton").click();
              callback({ ok: true });
              return;
            }
            if (callback) callback({ ok: true });
          }
        },
        storage: {
          local: {
            get: (_keys, callback) => callback({}),
            set: () => {}
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
    const browser = await chromium.launch({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    })
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      await page.goto(url, { waitUntil: "domcontentloaded" })
      await page.waitForSelector("#fcuno-wa-spc-board [data-action='toggle-enquiry']")
      await page.click("#fcuno-wa-spc-board [data-action='toggle-enquiry']")
      await page.click("#fcuno-wa-spc-board [data-action='send-selected']")
      await page.waitForFunction(() => window.sentMessages.length === 1, { timeout: 3000 })
      await page.waitForTimeout(100)

      const firstResult = await page.evaluate(() => ({
        sentText: document.getElementById("sent").innerText,
        composerText: document.getElementById("composer").innerText,
        sentCount: window.sentMessages.length,
        decoyClicks: window.decoyClicks,
        nativeInsertCount: window.nativeInsertCount,
        nativeEnterCount: window.nativeEnterCount,
        nativeClickCount: window.nativeClickCount,
      }))

      assert.equal(firstResult.sentText, expected)
      assert.equal(firstResult.composerText, "")
      assert.equal(firstResult.sentCount, 1)
      assert.equal(firstResult.decoyClicks, 0)
      assert.equal(firstResult.nativeInsertCount, 1)
      assert.equal(firstResult.nativeEnterCount, 1)
      assert.equal(firstResult.nativeClickCount, 1)

      await page.click("#fcuno-wa-spc-board [data-action='send-selected']")
      await page.waitForTimeout(300)

      const secondResult = await page.evaluate(() => ({
        sentText: document.getElementById("sent").innerText,
        composerText: document.getElementById("composer").innerText,
        sentCount: window.sentMessages.length,
      }))

      assert.equal(secondResult.sentText, expected)
      assert.equal(secondResult.composerText, "")
      assert.equal(secondResult.sentCount, 1)

      const dragRuleResult = await page.evaluate(() => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        api.state.selectedEnquiries = {}
        const noneSelected = api.activeDragEnquiryIds("enq-2")
        api.state.selectedEnquiries = { "enq-1": true }
        const oneSelected = api.activeDragEnquiryIds("enq-2")
        api.state.selectedEnquiries = { "enq-1": true, "enq-3": true }
        const manySelected = api.activeDragEnquiryIds("enq-2")
        const manyText = api.enquiryTextForIds(manySelected)
        return { noneSelected, oneSelected, manySelected, manyText }
      })

      assert.deepEqual(dragRuleResult.noneSelected, ["enq-2"])
      assert.deepEqual(dragRuleResult.oneSelected, ["enq-2"])
      assert.deepEqual(dragRuleResult.manySelected, ["enq-1", "enq-3"])
      assert.equal(
        dragRuleResult.manyText,
        `Good day, please quote for the following enquiries.\n\n${enquiry}\n\n${enquiry3}`,
      )

      const contactMenuResult = await page.evaluate(() => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        const contact = { id: "menu-contact", name: "Menu Contact", chatName: "Menu Contact", phone: "", list: "supplier", order: 1000 }
        api.state.contacts = [contact]
        api.state.selectedEnquiries = {}
        api.state.contactMenuId = "menu-contact"
        api.render()
        const disabledButtons = Array.from(document.querySelectorAll(".fcuno-wa-spc-contact-menu button")).map((button) => ({
          text: button.textContent.trim(),
          disabled: button.disabled,
        }))
        api.state.selectedEnquiries = { "enq-1": true }
        api.state.contactMenuId = "menu-contact"
        api.render()
        const activeButtons = Array.from(document.querySelectorAll(".fcuno-wa-spc-contact-menu button")).map((button) => ({
          text: button.textContent.trim(),
          disabled: button.disabled,
        }))
        return { disabledButtons, activeButtons }
      })

      assert.deepEqual(contactMenuResult.disabledButtons.map((button) => button.text), ["Send Selected", "Remove"])
      assert.equal(contactMenuResult.disabledButtons[0].disabled, true)
      assert.deepEqual(contactMenuResult.activeButtons.map((button) => button.text), ["Send Selected", "Remove"])
      assert.equal(contactMenuResult.activeButtons[0].disabled, false)

      await page.evaluate((message) => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        const contact = { id: "renamed-contact", name: "OTTO", chatName: "Otto Tone", phone: "", list: "buyer", order: 1000 }
        api.state.contacts = [contact]
        window.sentMessages = []
        window.editorModel = ""
        document.getElementById("sent").textContent = ""
        document.getElementById("composer").replaceChildren()
        document.getElementById("search").value = ""
        document.getElementById("renamedRow").style.display = "none"
        window.setChatTitle("Other Chat")
        api.sendTextToContact(contact, message)
      }, enquiry)

      await page.waitForFunction(() => window.sentMessages.length === 1, { timeout: 5000 })
      await page.waitForTimeout(250)

      const renamedResult = await page.evaluate(() => ({
        sentText: document.getElementById("sent").innerText,
        composerText: document.getElementById("composer").innerText,
        sentCount: window.sentMessages.length,
        chatTitle: document.getElementById("chatTitle").getAttribute("title"),
        searchText: document.getElementById("search").value,
      }))

      assert.equal(renamedResult.sentText, enquiry)
      assert.equal(renamedResult.composerText, "")
      assert.equal(renamedResult.sentCount, 1)
      assert.equal(renamedResult.chatTitle, "Otto Tone")
      assert.equal(renamedResult.searchText, "")

      const invalidRuntimeResult = await page.evaluate(() => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        const originalSendMessage = window.chrome.runtime.sendMessage
        window.chrome.runtime.sendMessage = () => {
          throw new Error("Extension context invalidated.")
        }
        api.state.loadingEnquiries = false
        api.state.enquiryError = ""
        api.loadEnquiries()
        const result = {
          loading: api.state.loadingEnquiries,
          enquiryError: api.state.enquiryError,
        }
        window.chrome.runtime.sendMessage = originalSendMessage
        return result
      })

      assert.equal(invalidRuntimeResult.loading, false)
      assert.match(invalidRuntimeResult.enquiryError, /Reload WhatsApp Web/)

      const invalidUnreadResult = await page.evaluate(() => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        const row = document.getElementById("renamedRow")
        const originalQuerySelectorAll = row.querySelectorAll
        row.style.display = "block"
        row.querySelectorAll = () => {
          throw new Error("Extension context invalidated.")
        }
        api.state.contacts = [{ id: "unread-contact", name: "Otto Tone", chatName: "Otto Tone", phone: "", list: "buyer", order: 1000 }]
        api.state.unreadById = { "unread-contact": "1" }
        api.state.enquiryError = ""
        api.refreshUnreadIndicators()
        const result = {
          unread: api.state.unreadById["unread-contact"] || "",
          enquiryError: api.state.enquiryError,
        }
        row.querySelectorAll = originalQuerySelectorAll
        return result
      })

      assert.equal(invalidUnreadResult.unread, "")
      assert.match(invalidUnreadResult.enquiryError, /Reload WhatsApp Web/)
    } finally {
      await browser.close()
    }
  })
}

main()
  .then(() => console.log("SPC WhatsApp browser send test passed"))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
