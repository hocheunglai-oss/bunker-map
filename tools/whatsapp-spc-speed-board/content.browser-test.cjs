const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const { chromium } = require("playwright")

const extensionSource = fs.readFileSync(path.join(__dirname, "content.js"), "utf8")
const extensionStyles = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8")
const enquiryChatButton = fs.readFileSync(path.join(__dirname, "spc-enquiry-chat-button.webp"))
const enquiry = "taisei maru no.15 / 8710728 / 14 - 15 jan / vlsfo 600mts"
const enquiry2 = "shan ren / 9474606 / 11 - 13 jan / vlsfo 110mts / lsmgo 55mts"
const enquiry3 = "a keiga / 9385453 / 3 oct / vlsfo 260mts"
const enquiryReplyGroup = "Otto (FCBHK) SG Enqs"
const expected = `Good day, please quote for the following enquiries.\n\n${enquiry}`
const sharedFeedStartedAt = "2026-07-23T09:20:00.000Z"
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
    <title>SPC WhatsApp Send Harness</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 0; }
      #side { width: 360px; float: left; min-height: 540px; border-right: 1px solid #ddd; }
      #search { width: 300px; margin: 16px; padding: 10px; }
      #newChatControl { margin: 8px 16px 0; }
      #newChatDrawer, #phoneDialer { display: none; margin: 8px 16px; padding: 10px; border: 1px solid #ddd; }
      #phoneNumberInput { min-height: 24px; padding: 6px; border: 1px solid #ccc; }
      #phoneDialerResult { display: none; padding: 12px; cursor: pointer; border-top: 1px solid #eee; }
      #chatHeading, #commonHeading, #commonGroupRow, #renamedRow, #senderRow, #ottoSenderRow, #enquiryGroupRow { display: none; }
      #chatHeading, #commonHeading { padding: 8px 16px; }
      #renamedRow, #senderRow, #ottoSenderRow, #enquiryGroupRow, #commonGroupRow { padding: 16px; cursor: pointer; border-top: 1px solid #eee; }
      #main { width: 720px; min-height: 540px; }
      header { height: 56px; border-bottom: 1px solid #ddd; display: flex; align-items: center; padding: 0 16px; }
      .messages { height: 360px; background: #f6efe5; }
      .composer-row { display: flex; align-items: flex-end; gap: 8px; padding: 12px; }
      #composer { flex: 1; min-height: 120px; border: 1px solid #ccc; border-radius: 18px; padding: 10px; white-space: pre-wrap; }
      #sendButton { width: 48px; height: 48px; border-radius: 50%; background: #00a884; color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; }
      #decoySend { margin: 24px; padding: 8px 12px; }
      #sent { white-space: pre-wrap; border-top: 1px solid #ddd; padding: 10px; }
      #contactInfo { display: none; position: fixed; inset: 56px 0 0 auto; width: 360px; background: #fff; z-index: 5; }
    </style>
    <style>${extensionStyles.replaceAll("</style>", "<\/style>")}</style>
  </head>
  <body>
    <div id="side">
      <button id="newChatControl" type="button" aria-label="New chat" onclick="document.getElementById('newChatDrawer').style.display='block'">
        <span data-icon="new-chat-outline"><svg><title>new-chat-outline</title></svg></span>
      </button>
      <div id="newChatDrawer">
        <button id="newChatBack" type="button" onclick="this.parentElement.style.display='none'"><svg><title>ic-arrow-back</title></svg></button>
        <button id="phoneDialpad" type="button" onclick="document.getElementById('newChatDrawer').style.display='none';document.getElementById('phoneDialer').style.display='block'">
          <svg><title>ic-dialpad</title></svg>
        </button>
      </div>
      <div id="phoneDialer">
        <button id="phoneDialerBack" type="button" onclick="document.getElementById('phoneDialer').style.display='none';document.getElementById('newChatDrawer').style.display='block'"><svg><title>ic-arrow-back</title></svg></button>
        <div id="phoneNumberInput" data-testid="phone-number-input" contenteditable="true" role="textbox"></div>
        <div id="phoneDialerResult" data-testid="cell-frame-container" role="button" tabindex="0" onclick="window.openDialerContact()"></div>
        <div data-testid="dialer-pad-1" role="button">1</div>
      </div>
      <input id="search" type="text" aria-label="Search input textbox" />
      <div id="chatHeading" role="row"><h2>Chats</h2></div>
      <div id="renamedRow" role="row" data-testid="list-item-renamed">
        <div role="gridcell"><div data-testid="cell-frame-container" onclick="if (event.isTrusted || window.nativeClickInProgress) window.setChatTitle('Otto Tone')"><span title="Otto Tone">Otto Tone</span></div></div>
      </div>
      <div id="senderRow" role="row" data-testid="list-item-sender">
        <div role="gridcell"><div data-testid="cell-frame-container" onclick="if (event.isTrusted || window.nativeClickInProgress) window.setChatTitle('Barry Local Alias')"><span title="Barry Local Alias">Barry Local Alias</span></div></div>
      </div>
      <div id="ottoSenderRow" role="row" data-testid="list-item-otto-sender">
        <div role="gridcell"><div data-testid="cell-frame-container" onclick="if (event.isTrusted || window.nativeClickInProgress) window.setChatTitle('+852 9000 0002')"><span title="+852 9000 0002">+852 9000 0002</span></div></div>
      </div>
      <div id="enquiryGroupRow" role="row" data-testid="list-item-enquiry-group">
        <div role="gridcell"><div data-testid="cell-frame-container" onclick="if (event.isTrusted || window.nativeClickInProgress) window.setChatTitle('Otto (FCBHK) SG Enqs', 'group')"><span title="Otto (FCBHK) SG Enqs">Otto (FCBHK) SG Enqs</span></div></div>
      </div>
      <div id="commonHeading" role="row"><h2>Groups in common</h2></div>
      <div id="commonGroupRow" role="row" data-testid="list-item-common-group"><div role="gridcell"><div data-testid="cell-frame-container"><span title="Shared group">Shared group</span></div></div></div>
    </div>
    <div id="main">
      <header>
        <button id="profileDetails" type="button" aria-label="個人檔案詳情" onclick="window.profileOpenCount += 1;document.getElementById('contactInfo').style.display='block'">
          <span id="chatTitle" title="Otto Tone">Otto Tone</span>
        </button>
      </header>
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
    <aside id="contactInfo">
      <div>聯絡人資料</div><div>Otto Tone</div><div>+852 6688 5575</div><div>語音</div><div>視像</div><div>搜尋</div>
      <button type="button" aria-label="閂" onclick="this.parentElement.style.display='none'">閂</button>
    </aside>
    <pre id="sent"></pre>
    <script>
      window.sentMessages = [];
      window.decoyClicks = 0;
      window.editorModel = "";
      window.nativeEnterCount = 0;
      window.nativeClickCount = 0;
      window.nativeInsertCount = 0;
      window.nativeReplaceCount = 0;
      window.dialerOpenCount = 0;
      window.profileOpenCount = 0;
      window.nativeClickInProgress = false;
      window.searchValues = [];
      window.nativeEnterShouldSend = false;
      window.promptResponse = null;
      window.enquiryOverrides = {};
      window.prompt = () => window.promptResponse;
      window.__FCUNO_WA_SPC_ENABLE_TEST_API__ = true;
      const searchParams = new URLSearchParams(window.location.search);
      const firstRun = searchParams.get("firstRun") === "1";
      const staleVersion = searchParams.get("staleVersion") === "1";
      window.invalidateStorageOnRead = searchParams.get("invalidateStorage") === "1";
      window.storageData = firstRun ? {} : {
        "fcuno-wa-spc-board-v1": {
          feedStartedAt: "2026-06-30T00:00:00Z"
        }
      };
      window.setChatTitle = (name, kind = "contact") => {
        const title = document.getElementById("chatTitle");
        title.textContent = name;
        title.setAttribute("title", name);
        document.getElementById("profileDetails").setAttribute("aria-label", kind === "group" ? "群組資訊" : "個人檔案詳情");
      };
      document.getElementById("phoneNumberInput").addEventListener("input", (event) => {
        if (!event.isTrusted && event.inputType === "insertText" && event.data) {
          event.target.appendChild(document.createTextNode(String(event.data)));
        }
        const digits = String(event.target.innerText || event.target.textContent || "").replace(/\\D/g, "");
        const result = document.getElementById("phoneDialerResult");
        result.dataset.phone = digits;
        result.textContent = digits === "6590000001" ? "Saved Barry Alias" : digits ? "+" + digits : "";
        result.style.display = digits ? "block" : "none";
      });
      window.openDialerContact = () => {
        const digits = document.getElementById("phoneDialerResult").dataset.phone || "";
        if (!digits) return;
        window.dialerOpenCount += 1;
        document.getElementById("phoneDialer").style.display = "none";
        document.getElementById("newChatDrawer").style.display = "none";
        window.setChatTitle(digits === "6590000001" ? "Barry Local Alias" : digits === "85290000002" ? "+852 9000 0002" : "+" + digits);
        document.getElementById("composer").focus();
      };
      window.applySearchValue = (nextValue) => {
        const search = document.getElementById("search");
        search.value = String(nextValue || "");
        const value = search.value.toLowerCase();
        window.searchValues.push(value);
        const showRenamed = value.includes("otto tone");
        const showSender = value.includes("+6590000001");
        const showOttoSender = value.includes("+85290000002");
        const showEnquiryGroup = value === ${JSON.stringify(enquiryReplyGroup.toLowerCase())};
        const showDirect = showRenamed || showSender || showOttoSender || showEnquiryGroup;
        document.getElementById("chatHeading").style.display = showDirect ? "block" : "none";
        document.getElementById("renamedRow").style.display = showRenamed ? "block" : "none";
        document.getElementById("senderRow").style.display = showSender ? "block" : "none";
        document.getElementById("ottoSenderRow").style.display = showOttoSender ? "block" : "none";
        document.getElementById("enquiryGroupRow").style.display = showEnquiryGroup ? "block" : "none";
        document.getElementById("commonHeading").style.display = showSender || showOttoSender ? "block" : "none";
        document.getElementById("commonGroupRow").style.display = showSender || showOttoSender ? "block" : "none";
      };
      document.getElementById("search").addEventListener("input", (event) => {
        if (event.isTrusted) window.applySearchValue(event.target.value);
      });
      window.chrome = {
        runtime: {
          id: "fcuno-spc-test-extension",
          lastError: null,
          getURL: (asset) => new URL(asset, window.location.href).href,
          sendMessage: (message, callback) => {
            if (message && message.type === "load-spc-extension-version") {
              callback({
                ok: true,
                status: {
                  installedVersion: staleVersion ? "0.6.6" : "0.6.7",
                  latestVersion: "0.6.7",
                  requiredVersion: "0.6.7",
                  updateRequired: staleVersion,
                  updatePageUrl: "https://spc.fcuno.com/chrome"
                }
              });
              return;
            }
            if (message && message.type === "load-spc-enquiries") {
              const enquiries = [
                {
                  id: "enq-1",
                  formattedText: ${JSON.stringify(enquiry)},
                  vesselName: "taisei maru no.15",
                  createdAt: "2026-07-23T09:21:00Z",
                  updatedAt: "2026-07-23T09:21:00Z",
                  status: "sent",
                  createdByUsername: "barry@cosulich.com.sg",
                  createdByDisplayName: "OL"
                },
                {
                  id: "enq-2",
                  formattedText: ${JSON.stringify(enquiry2)},
                  createdAt: "2026-07-23T09:22:00Z",
                  updatedAt: "2026-07-23T09:22:00Z",
                  status: "sent",
                  createdByUsername: "otto@cosulich.com.hk",
                  createdByDisplayName: "OTTO LAI"
                },
                {
                  id: "enq-3",
                  formattedText: ${JSON.stringify(enquiry3)},
                  createdAt: "2026-07-23T09:23:00Z",
                  updatedAt: "2026-07-23T09:23:00Z",
                  status: "sent",
                  createdByUsername: "barry@cosulich.com.sg",
                  createdByDisplayName: "BARRY KHOO"
                }
              ];
              if (window.extraEnquiry) enquiries.push(window.extraEnquiry);
              enquiries.forEach((item) => Object.assign(item, window.enquiryOverrides[item.id] || {}));
              callback({
                ok: true,
                enquiries,
                senderContacts: {
                  "barry@cosulich.com.sg": {
                    username: "barry@cosulich.com.sg",
                    displayName: "BARRY KHOO",
                    phone: "6590000001",
                    phonebookContactId: "phonebook-barry"
                  },
                  "otto@cosulich.com.hk": {
                    username: "otto@cosulich.com.hk",
                    displayName: "OTTO LAI",
                    phone: "85290000002",
                    phonebookContactId: "phonebook-otto"
                  }
                }
              });
              return;
            }
            if (message && message.type === "load-crude-watch") {
              callback({ ok: true, crude: ${JSON.stringify(crudeWatch)} });
              return;
            }
            if (message && message.type === "spc-native-click") {
              window.nativeClickCount += 1;
              const target = document.elementFromPoint(Number(message.x), Number(message.y));
              const clickable = target && target.closest("button,[role='button'],[data-testid='cell-frame-container']");
              window.nativeClickInProgress = true;
              if (clickable) clickable.click();
              window.nativeClickInProgress = false;
              callback({ ok: Boolean(clickable) });
              return;
            }
            if (message && message.type === "spc-native-replace-text") {
              window.nativeReplaceCount += 1;
              if (document.activeElement === document.getElementById("search")) {
                window.applySearchValue(message.text || "");
                callback({ ok: true });
                return;
              }
              callback({ ok: false });
              return;
            }
            if (message && message.type === "spc-native-insert-text") {
              window.nativeInsertCount += 1;
              const composer = document.getElementById("composer");
              if (!String(composer.innerText || "").trim()) composer.replaceChildren();
              String(message.text || "").split("\\n").forEach((line, index) => {
                if (index > 0 || composer.childNodes.length > 0) composer.appendChild(document.createElement("br"));
                composer.appendChild(document.createTextNode(line));
              });
              window.editorModel = composer.innerText;
              composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(message.text || "") }));
              window.setTimeout(() => callback({ ok: true }), 40);
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
            get: (keys, callback) => {
              if (window.invalidateStorageOnRead) throw new Error("Extension context invalidated.");
              callback(Object.fromEntries(keys.filter((key) => key in window.storageData).map((key) => [key, window.storageData[key]])));
            },
            set: (values, callback) => { Object.assign(window.storageData, values); callback?.(); }
          }
        }
      };
    </script>
    <script>${extensionSource.replaceAll("</script>", "<\\/script>")}</script>
  </body>
</html>`

async function withServer(callback) {
  const server = http.createServer((request, response) => {
    if (request.url === "/spc-enquiry-chat-button.webp") {
      response.writeHead(200, { "content-type": "image/webp" })
      response.end(enquiryChatButton)
      return
    }
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
      executablePath: process.env.CHROME_EXECUTABLE_PATH || chromium.executablePath(),
      headless: true,
    })
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      await page.goto(url, { waitUntil: "domcontentloaded" })
      await page.waitForSelector("#fcuno-wa-spc-board [data-action='open-enquiry-chat'][data-id='enq-1']")
      await page.waitForFunction(() => document.querySelector(".fcuno-wa-spc-crude strong")?.textContent === "97.57")

      const crudeResult = await page.evaluate(() => ({
        price: document.querySelector(".fcuno-wa-spc-crude strong")?.textContent || "",
        change: document.querySelector(".fcuno-wa-spc-crude span")?.textContent || "",
        path: document.querySelector(".fcuno-wa-spc-crude path")?.getAttribute("d") || "",
        title: document.querySelector(".fcuno-wa-spc-crude")?.getAttribute("title") || "",
      }))

      assert.equal(crudeResult.price, "97.57")
      assert.equal(crudeResult.change, "+3.50 +3.72%")
      assert.match(crudeResult.path, /^M/)
      assert.match(crudeResult.path, /L/)
      assert.match(
        crudeResult.title,
        /ICE Brent crude futures · Sep26 · delayed at least 15 minutes/,
      )
      assert.equal(await page.locator(".fcuno-wa-spc-version-alert").count(), 0)

      const staleVersionPage = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      await staleVersionPage.goto(`${url}?staleVersion=1`, { waitUntil: "domcontentloaded" })
      await staleVersionPage.waitForSelector(".fcuno-wa-spc-version-alert.is-required")
      assert.equal(
        (await staleVersionPage.locator(".fcuno-wa-spc-version-alert").innerText()).replace(/\s+/g, " ").trim(),
        "UPDATE REQUIRED Installed v0.6.6 · Required v0.6.7 UPDATE",
      )
      assert.equal(
        await staleVersionPage.locator(".fcuno-wa-spc-version-alert a").getAttribute("href"),
        "https://spc.fcuno.com/chrome",
      )
      await staleVersionPage.close()

      await page.locator("#fcuno-wa-spc-board [data-action='add-current'][data-list='buyer']").click()
      await page.waitForFunction(() => {
        const contact = window.storageData["fcuno-wa-spc-board-v1"]?.contacts?.[0]
        return contact?.chatName === "Otto Tone"
      })
      const capturedContact = await page.evaluate(() => window.storageData["fcuno-wa-spc-board-v1"].contacts[0])
      assert.equal(capturedContact.phone, "")
      assert.equal(capturedContact.kind, "contact")
      assert.equal(await page.locator("#contactInfo").isVisible(), false)
      assert.equal(await page.evaluate(() => window.profileOpenCount), 0)
      const capturedContactLabel = await page.locator(".fcuno-wa-spc-contact-list[data-list='buyer'] .fcuno-wa-spc-list-button").innerText()
      assert.equal(capturedContactLabel.trim(), "Otto Tone")
      assert.notEqual(capturedContactLabel.trim(), "個人檔案詳情")
      assert.doesNotMatch(capturedContactLabel, /85266885575/)
      await page.evaluate(() => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        api.state.contacts = []
        api.render()
      })

      const stableRefresh = await page.evaluate(() => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        const boardMain = document.querySelector(".fcuno-wa-spc-main")
        api.loadEnquiries()
        api.loadCrudeWatch()
        return boardMain === document.querySelector(".fcuno-wa-spc-main")
      })
      assert.equal(stableRefresh, true, "unchanged background refresh must not replace the board")

      await page.click("#fcuno-wa-spc-board [data-action='edit-template']", { force: true })
      const editingRefresh = await page.evaluate(() => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        const textarea = document.querySelector("[data-action='template-text']")
        textarea.focus()
        textarea.value = "Good day, please quote for the following enquiries."
        textarea.setSelectionRange(6, 6)
        window.extraEnquiry = {
          id: "enq-4",
          formattedText: "new background enquiry",
          createdAt: "2026-07-23T09:24:00Z",
          updatedAt: "2026-07-23T09:24:00Z",
          status: "sent",
          createdByDisplayName: "OL"
        }
        api.loadEnquiries()
        return {
          sameTextarea: textarea === document.querySelector("[data-action='template-text']"),
          value: textarea.value,
          selectionStart: textarea.selectionStart,
          stateLoaded: api.state.enquiries.some((item) => item.id === "enq-4"),
        }
      })
      assert.equal(editingRefresh.sameTextarea, true)
      assert.equal(editingRefresh.value, "Good day, please quote for the following enquiries.")
      assert.equal(editingRefresh.selectionStart, 6)
      assert.equal(editingRefresh.stateLoaded, true)
      await page.click("#fcuno-wa-spc-board [data-action='edit-template']", { force: true })
      await page.waitForSelector("#fcuno-wa-spc-board [data-id='enq-4']")

      const enquiryUi = await page.evaluate(() => {
        const row = document.querySelector("#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1']")
        const arrow = row?.querySelector("[data-action='open-enquiry-chat']")
        return {
          checkboxCount: row?.querySelectorAll("input[type='checkbox']").length || 0,
          arrowTag: arrow?.tagName || "",
          arrowHref: arrow?.getAttribute("href") || "",
          arrowText: arrow?.textContent?.trim() || "",
          arrowWidth: arrow ? getComputedStyle(arrow).width : "",
          arrowHeight: arrow ? getComputedStyle(arrow).height : "",
          imageSrc: arrow?.querySelector("img")?.getAttribute("src") || "",
          imageWidth: arrow?.querySelector("img")?.naturalWidth || 0,
          imageHeight: arrow?.querySelector("img")?.naturalHeight || 0,
          vesselText: row?.querySelector(".fcuno-wa-spc-enquiry-vessel")?.textContent || "",
          vesselColor: row?.querySelector(".fcuno-wa-spc-enquiry-vessel") ? getComputedStyle(row.querySelector(".fcuno-wa-spc-enquiry-vessel")).color : "",
          senderText: row?.querySelector(".fcuno-wa-spc-enquiry-sender")?.textContent || "",
          senderColor: row?.querySelector(".fcuno-wa-spc-enquiry-sender") ? getComputedStyle(row.querySelector(".fcuno-wa-spc-enquiry-sender")).color : "",
        }
      })
      assert.deepEqual(enquiryUi, {
        checkboxCount: 0,
        arrowTag: "BUTTON",
        arrowHref: "",
        arrowText: "",
        arrowWidth: "34px",
        arrowHeight: "34px",
        imageSrc: `${url}spc-enquiry-chat-button.webp`,
        imageWidth: 224,
        imageHeight: 224,
        vesselText: "taisei maru no.15",
        vesselColor: "rgb(22, 131, 232)",
        senderText: "OL",
        senderColor: "rgb(22, 131, 232)",
      })
      const senderOpenBeforeUrl = page.url()
      await page.evaluate(() => {
        window.senderOpenDocument = document.documentElement
        window.setChatTitle("Other Chat")
        document.getElementById("search").value = ""
        document.getElementById("enquiryGroupRow").style.display = "none"
      })
      await page.click("#fcuno-wa-spc-board [data-action='open-enquiry-chat'][data-id='enq-1']", { force: true })
      await page.waitForFunction(() => (
        document.getElementById("chatTitle")?.getAttribute("title") === "Otto (FCBHK) SG Enqs" &&
        document.getElementById("profileDetails")?.getAttribute("aria-label") === "群組資訊" &&
        window.editorModel === "*taisei maru no.15 / 8710728 / 14 - 15 jan / vlsfo 600mts*\n" &&
        document.getElementById("search")?.value === "" &&
        document.activeElement === document.getElementById("composer")
      ), { timeout: 5000 })
      const senderOpenResult = await page.evaluate(() => ({
        sameDocument: window.senderOpenDocument === document.documentElement,
        chatTitle: document.getElementById("chatTitle")?.getAttribute("title") || "",
        searchText: document.getElementById("search")?.value || "",
        composerText: window.editorModel,
        composerFocused: document.activeElement === document.getElementById("composer"),
        sentCount: window.sentMessages.length,
        dialerOpenCount: window.dialerOpenCount,
        dialerValue: document.getElementById("phoneNumberInput")?.textContent || "",
        searchedGroup: window.searchValues.includes("otto (fcbhk) sg enqs"),
        nativeReplaceCount: window.nativeReplaceCount,
        nativeClickCount: window.nativeClickCount,
      }))
      assert.equal(page.url(), senderOpenBeforeUrl)
      assert.deepEqual(senderOpenResult, {
        sameDocument: true,
        chatTitle: "Otto (FCBHK) SG Enqs",
        searchText: "",
        composerText: "*taisei maru no.15 / 8710728 / 14 - 15 jan / vlsfo 600mts*\n",
        composerFocused: true,
        sentCount: 0,
        dialerOpenCount: 0,
        dialerValue: "",
        searchedGroup: true,
        nativeReplaceCount: 2,
        nativeClickCount: 1,
      })

      await page.waitForTimeout(750)
      await page.evaluate(() => {
        window.editorModel = ""
        window.nativeInsertCount = 0
        document.getElementById("composer").replaceChildren()
        document.getElementById("composer").blur()
        window.setChatTitle("Other Chat")
        const button = document.querySelector("#fcuno-wa-spc-board [data-action='open-enquiry-chat'][data-id='enq-1']")
        button.click()
        button.click()
      })
      await page.waitForFunction(() => (
        document.getElementById("chatTitle")?.getAttribute("title") === "Otto (FCBHK) SG Enqs" &&
        document.getElementById("profileDetails")?.getAttribute("aria-label") === "群組資訊" &&
        window.editorModel === "*taisei maru no.15 / 8710728 / 14 - 15 jan / vlsfo 600mts*\n" &&
        window.nativeInsertCount === 1
      ), { timeout: 5000 })
      assert.deepEqual(await page.evaluate(() => ({
        composerText: window.editorModel,
        nativeInsertCount: window.nativeInsertCount,
      })), {
        composerText: "*taisei maru no.15 / 8710728 / 14 - 15 jan / vlsfo 600mts*\n",
        nativeInsertCount: 1,
      })

      await page.waitForTimeout(750)
      await page.evaluate(() => {
        window.editorModel = ""
        document.getElementById("composer").replaceChildren()
        document.getElementById("composer").blur()
      })
      await page.click("#fcuno-wa-spc-board [data-action='open-enquiry-chat'][data-id='enq-1']", { force: true })
      await page.waitForFunction(() => window.editorModel === "*taisei maru no.15 / 8710728 / 14 - 15 jan / vlsfo 600mts*\n", { timeout: 3000 })
      const sameChatPrefill = await page.evaluate(() => ({
        composerText: window.editorModel,
        composerFocused: document.activeElement === document.getElementById("composer"),
        sentCount: window.sentMessages.length,
      }))
      assert.deepEqual(sameChatPrefill, {
        composerText: "*taisei maru no.15 / 8710728 / 14 - 15 jan / vlsfo 600mts*\n",
        composerFocused: true,
        sentCount: 0,
      })

      await page.waitForTimeout(750)
      await page.evaluate(() => {
        window.editorModel = ""
        document.getElementById("composer").replaceChildren()
        document.getElementById("composer").blur()
        window.setChatTitle("Other Chat")
      })
      await page.click("#fcuno-wa-spc-board [data-action='open-enquiry-chat'][data-id='enq-2']", { force: true })
      await page.waitForFunction(() => (
        document.getElementById("chatTitle")?.getAttribute("title") === "Otto (FCBHK) SG Enqs" &&
        document.getElementById("profileDetails")?.getAttribute("aria-label") === "群組資訊" &&
        window.editorModel === "*shan ren / 9474606 / 11 - 13 jan / vlsfo 110mts / lsmgo 55mts*\n" &&
        document.activeElement === document.getElementById("composer")
      ), { timeout: 5000 })
      const unsavedSenderOpenResult = await page.evaluate(() => ({
        chatTitle: document.getElementById("chatTitle")?.getAttribute("title") || "",
        composerText: window.editorModel,
        composerFocused: document.activeElement === document.getElementById("composer"),
        sentCount: window.sentMessages.length,
        dialerOpenCount: window.dialerOpenCount,
        dialerValue: document.getElementById("phoneNumberInput")?.textContent || "",
        searchedGroup: window.searchValues.includes("otto (fcbhk) sg enqs"),
      }))
      assert.deepEqual(unsavedSenderOpenResult, {
        chatTitle: "Otto (FCBHK) SG Enqs",
        composerText: "*shan ren / 9474606 / 11 - 13 jan / vlsfo 110mts / lsmgo 55mts*\n",
        composerFocused: true,
        sentCount: 0,
        dialerOpenCount: 0,
        dialerValue: "",
        searchedGroup: true,
      })

      await page.evaluate(() => {
        window.editorModel = ""
        window.nativeInsertCount = 0
        window.nativeEnterCount = 0
        window.nativeClickCount = 0
        document.getElementById("composer").replaceChildren()
      })

      const firstEnquiryText = page.locator("#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1'] em")
      const sendButtonBeforeSelection = await page.locator("#fcuno-wa-spc-board [data-action='send-selected']").evaluate((button) => ({
        text: button.textContent.trim(),
        width: getComputedStyle(button).width,
        height: getComputedStyle(button).height,
      }))
      assert.equal(sendButtonBeforeSelection.text, "Send")
      await firstEnquiryText.click({ force: true })
      assert.equal(await page.locator("#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1']").evaluate((row) => row.classList.contains("is-selected")), true)
      assert.equal(await page.locator("#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1']").evaluate((row) => getComputedStyle(row).backgroundColor), "rgb(231, 243, 255)")
      const sendButtonAfterSelection = await page.locator("#fcuno-wa-spc-board [data-action='send-selected']").evaluate((button) => ({
        text: button.textContent.trim(),
        width: getComputedStyle(button).width,
        height: getComputedStyle(button).height,
      }))
      assert.equal(sendButtonAfterSelection.text, "Send Temp & 1 Enq")
      assert.equal(sendButtonAfterSelection.width, sendButtonBeforeSelection.width)
      assert.equal(sendButtonAfterSelection.height, sendButtonBeforeSelection.height)
      if (process.env.SPC_BROWSER_SCREENSHOT) {
        await page.screenshot({ path: process.env.SPC_BROWSER_SCREENSHOT })
      }
      await firstEnquiryText.click({ force: true })
      assert.equal(await page.locator("#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1']").evaluate((row) => row.classList.contains("is-selected")), false)
      await firstEnquiryText.click({ force: true })
      await page.click("#fcuno-wa-spc-board [data-action='send-selected']", { force: true })
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

      await page.click("#fcuno-wa-spc-board [data-action='send-selected']", { force: true })
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
        api.state.templateEnabled = false
        const twoSelectedLabel = api.sendSelectionLabel()
        api.state.templateEnabled = true
        const templateAndTwoSelectedLabel = api.sendSelectionLabel()
        const manySelected = api.activeDragEnquiryIds("enq-2")
        const manyText = api.enquiryTextForIds(manySelected)
        return { noneSelected, oneSelected, twoSelectedLabel, templateAndTwoSelectedLabel, manySelected, manyText }
      })

      assert.deepEqual(dragRuleResult.noneSelected, ["enq-2"])
      assert.deepEqual(dragRuleResult.oneSelected, ["enq-2"])
      assert.equal(dragRuleResult.twoSelectedLabel, "Send 2 Enqs")
      assert.equal(dragRuleResult.templateAndTwoSelectedLabel, "Send Temp & 2 Enqs")
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

      assert.deepEqual(contactMenuResult.disabledButtons.map((button) => button.text), ["Rename", "Send Selected", "Remove"])
      assert.equal(contactMenuResult.disabledButtons[1].disabled, true)
      assert.deepEqual(contactMenuResult.activeButtons.map((button) => button.text), ["Rename", "Send Selected", "Remove"])
      assert.equal(contactMenuResult.activeButtons[1].disabled, false)

      await page.evaluate(() => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        api.state.contacts = [
          { id: "supplier-a", name: "Supplier A", chatName: "Supplier A", phone: "", list: "supplier", order: 1000 },
          { id: "supplier-b", name: "Supplier B", chatName: "Supplier B", phone: "", list: "supplier", order: 2000 },
          { id: "supplier-c", name: "Supplier C", chatName: "Supplier C", phone: "", list: "supplier", order: 3000 },
        ]
        api.state.contactMenuId = ""
        api.render()
      })
      await page.locator("[data-action='contact-menu'][data-id='supplier-c']").dragTo(
        page.locator(".fcuno-wa-spc-row[data-id='supplier-a']"),
        { targetPosition: { x: 18, y: 2 } },
      )
      const reorderedContacts = await page.evaluate(() => ({
        rendered: Array.from(document.querySelectorAll(".fcuno-wa-spc-contact-list[data-list='supplier'] .fcuno-wa-spc-row")).map((row) => row.dataset.id),
        saved: (window.storageData["fcuno-wa-spc-board-v1"]?.contacts || [])
          .filter((contact) => contact.list === "supplier")
          .sort((a, b) => Number(a.order) - Number(b.order))
          .map((contact) => contact.id),
      }))
      assert.deepEqual(reorderedContacts.rendered, ["supplier-c", "supplier-a", "supplier-b"])
      assert.deepEqual(reorderedContacts.saved, ["supplier-c", "supplier-a", "supplier-b"])

      await page.evaluate(() => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        api.state.contacts = [{ id: "menu-contact", name: "Menu Contact", chatName: "Menu Contact", phone: "", list: "supplier", order: 1000 }]
        api.state.contactMenuId = "menu-contact"
        api.render()
      })
      await page.locator(".fcuno-wa-spc-row-actions").first().hover()
      await page.mouse.move(24, 24)
      await page.waitForTimeout(1000)
      assert.equal(await page.locator(".fcuno-wa-spc-contact-menu").count(), 1)
      await page.waitForFunction(() => !document.querySelector(".fcuno-wa-spc-contact-menu"), undefined, { timeout: 3000 })

      await page.evaluate(() => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        const contact = { id: "renamed-contact", name: "Otto Tone", chatName: "Otto Tone", phone: "", kind: "group", list: "buyer", order: 1000 }
        api.state.contacts = [contact]
        api.state.contactMenuId = contact.id
        window.promptResponse = "OTTO"
        api.render()
      })
      await page.click("#fcuno-wa-spc-board [data-action='rename-contact'][data-id='renamed-contact']", { force: true })
      await page.evaluate((message) => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        const contact = api.state.contacts.find((item) => item.id === "renamed-contact")
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
        alias: document.querySelector(".fcuno-wa-spc-row strong")?.textContent || "",
        originalName: document.querySelector(".fcuno-wa-spc-original-name")?.textContent || "",
        savedName: window.storageData["fcuno-wa-spc-board-v1"]?.contacts?.[0]?.name || "",
        savedChatName: window.storageData["fcuno-wa-spc-board-v1"]?.contacts?.[0]?.chatName || "",
      }))

      assert.equal(renamedResult.sentText, enquiry)
      assert.equal(renamedResult.composerText, "")
      assert.equal(renamedResult.sentCount, 1)
      assert.equal(renamedResult.chatTitle, "Otto Tone")
      assert.equal(renamedResult.searchText, "")
      assert.equal(renamedResult.alias, "OTTO")
      assert.equal(renamedResult.originalName, "")
      assert.equal(renamedResult.savedName, "OTTO")
      assert.equal(renamedResult.savedChatName, "Otto Tone")

      await page.waitForTimeout(2600)
      await page.evaluate((message) => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        const contact = api.state.contacts.find((item) => item.id === "renamed-contact")
        api.sendTextToContact(contact, message)
      }, enquiry)
      await page.waitForFunction(() => window.sentMessages.length === 2, { timeout: 5000 })
      assert.equal(
        await page.evaluate(() => window.sentMessages[1]),
        enquiry,
        "the same enquiry/contact should be sendable again after the short duplicate-event guard",
      )

      const firstRunPage = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      await firstRunPage.goto(`${url}?firstRun=1`, { waitUntil: "domcontentloaded" })
      await firstRunPage.waitForFunction(() => Boolean(window.__FCUNO_WA_SPC_TEST_API__?.state.feedStartedAt))
      const firstRunResult = await firstRunPage.evaluate(() => ({
        baseline: window.__FCUNO_WA_SPC_TEST_API__.state.feedStartedAt,
        policyVersion: window.__FCUNO_WA_SPC_TEST_API__.state.feedPolicyVersion,
        visibleCount: window.__FCUNO_WA_SPC_TEST_API__.visibleEnquiries().length,
        renderedRows: document.querySelectorAll(".fcuno-wa-spc-enquiry").length,
        savedBaseline: window.storageData["fcuno-wa-spc-board-v1"]?.feedStartedAt || "",
        savedPolicyVersion: window.storageData["fcuno-wa-spc-board-v1"]?.feedPolicyVersion || 0,
      }))
      assert.equal(firstRunResult.baseline, sharedFeedStartedAt)
      assert.equal(firstRunResult.policyVersion, 1)
      assert.equal(firstRunResult.visibleCount, 3)
      assert.equal(firstRunResult.renderedRows, 3)
      assert.equal(firstRunResult.savedBaseline, sharedFeedStartedAt)
      assert.equal(firstRunResult.savedPolicyVersion, 1)

      await firstRunPage.evaluate(() => {
        window.extraEnquiry = {
          id: "enq-new",
          formattedText: "new enquiry after installation",
          createdAt: "2026-07-23T09:25:00Z",
          updatedAt: "2026-07-23T09:25:00Z",
          status: "sent",
          createdByDisplayName: "OL"
        }
        window.__FCUNO_WA_SPC_TEST_API__.loadEnquiries()
      })
      await firstRunPage.waitForSelector("#fcuno-wa-spc-board [data-id='enq-new']")
      assert.equal(await firstRunPage.locator(".fcuno-wa-spc-enquiry").count(), 4)

      await firstRunPage.click(
        "#fcuno-wa-spc-board [data-action='hide-enquiry'][data-id='enq-1']",
        { force: true },
      )
      await firstRunPage.waitForFunction(
        () => !document.querySelector("#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1']"),
      )
      const firstTraderHide = await firstRunPage.evaluate(() => ({
        hiddenInState: Boolean(window.__FCUNO_WA_SPC_TEST_API__.state.hiddenEnquiryIds["enq-1"]),
        hiddenInStorage: Boolean(
          window.storageData["fcuno-wa-spc-board-v1"]?.hiddenEnquiryIds?.["enq-1"],
        ),
      }))
      assert.deepEqual(firstTraderHide, { hiddenInState: true, hiddenInStorage: true })

      const secondTraderPage = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      await secondTraderPage.goto(`${url}?firstRun=1`, { waitUntil: "domcontentloaded" })
      await secondTraderPage.waitForSelector(
        "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1']",
      )
      const secondTraderInitial = await secondTraderPage.evaluate(() => ({
        enquiryIds: Array.from(
          document.querySelectorAll("#fcuno-wa-spc-board .fcuno-wa-spc-enquiry"),
          (row) => row.getAttribute("data-id"),
        ),
        senders: Array.from(
          document.querySelectorAll("#fcuno-wa-spc-board .fcuno-wa-spc-enquiry-sender"),
          (sender) => sender.textContent,
        ),
        locallyHidden: Boolean(
          window.storageData["fcuno-wa-spc-board-v1"]?.hiddenEnquiryIds?.["enq-1"],
        ),
      }))
      assert.deepEqual(secondTraderInitial.enquiryIds.sort(), ["enq-1", "enq-2", "enq-3"])
      assert.deepEqual(secondTraderInitial.senders.sort(), ["BARRY KHOO", "OL", "OTTO LAI"])
      assert.equal(secondTraderInitial.locallyHidden, false)

      const amendmentUpdate = {
        formattedText: "taisei maru no.15 / 8710728 / 14 - 15 jan / vlsfo 650mts",
        revisionNumber: 2,
        lastAmendedAt: "2026-07-23T09:25:00Z",
        amendmentChanges: [
          { field: "quantity", label: "Quantity", before: "vlsfo 500mts", after: "vlsfo 650mts" },
        ],
        updatedAt: "2026-07-23T09:25:00Z",
      }
      await Promise.all([
        firstRunPage.evaluate((update) => {
          window.enquiryOverrides["enq-1"] = update
          window.__FCUNO_WA_SPC_TEST_API__.loadEnquiries()
        }, amendmentUpdate),
        secondTraderPage.evaluate((update) => {
          window.enquiryOverrides["enq-1"] = update
          window.__FCUNO_WA_SPC_TEST_API__.loadEnquiries()
        }, amendmentUpdate),
      ])
      await secondTraderPage.waitForSelector(
        "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1'].is-amended",
      )
      assert.equal(
        await secondTraderPage.locator(
          "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1'] .fcuno-wa-spc-amendment-diff del",
        ).innerText(),
        "vlsfo 500mts",
      )
      assert.equal(
        await secondTraderPage.locator(
          "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1'] .fcuno-wa-spc-amendment-diff strong",
        ).innerText(),
        "vlsfo 650mts",
      )
      assert.equal(
        await secondTraderPage.locator(
          "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1'] .fcuno-wa-spc-enquiry-amendment",
        ).innerText().then((text) => text.replace(/\s+/g, " ").trim()),
        "AMENDED ✓",
      )
      assert.equal(
        await secondTraderPage.locator(
          "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1'] [data-action='acknowledge-amendment']",
        ).count(),
        1,
      )
      assert.equal(
        await secondTraderPage.locator(
          "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1']",
        ).evaluate((row) => getComputedStyle(row).backgroundColor),
        "rgb(255, 240, 239)",
      )
      assert.deepEqual(
        await secondTraderPage.locator(
          "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1']",
        ).evaluate((row) => ({
          padding: getComputedStyle(row).padding,
          marginBottom: getComputedStyle(row).marginBottom,
        })),
        { padding: "6px", marginBottom: "5px" },
      )
      if (process.env.SPC_BROWSER_TEST_SCREENSHOT) {
        await secondTraderPage.locator(
          "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry-panel",
        ).screenshot({ path: process.env.SPC_BROWSER_TEST_SCREENSHOT })
      }

      const pendingAmendmentSelection = await secondTraderPage.evaluate(() => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        api.state.selectedEnquiries = { "enq-2": true }
        const amended = api.state.enquiries.find((enquiry) => enquiry.id === "enq-1")
        api.toggleEnquirySelection(amended)
        return {
          ids: api.selectedSendableEnquiryIds(),
          text: api.selectedEnquiryText(),
          pending: api.isPendingAmendment(amended),
        }
      })
      assert.deepEqual(pendingAmendmentSelection.ids, ["enq-1"])
      assert.equal(pendingAmendmentSelection.pending, true)
      assert.equal(
        pendingAmendmentSelection.text,
        "Quantity Amended\ntaisei maru no.15 / 8710728 / 14 - 15 jan / *vlsfo 650mts*",
      )
      assert.equal(
        await secondTraderPage.locator(
          "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1']",
        ).evaluate((row) => getComputedStyle(row).backgroundColor),
        "rgb(231, 243, 255)",
      )

      await secondTraderPage.click(
        "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1'] [data-action='acknowledge-amendment']",
      )
      await secondTraderPage.waitForFunction(
        () => !document.querySelector("#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1'].is-amendment-pending"),
      )
      const acknowledgedAmendment = await secondTraderPage.evaluate(() => {
        const api = window.__FCUNO_WA_SPC_TEST_API__
        const enquiry = api.state.enquiries.find((item) => item.id === "enq-1")
        return {
          storedRevision:
            window.storageData["fcuno-wa-spc-board-v1"]?.acknowledgedAmendmentRevisions?.["enq-1"],
          pending: api.isPendingAmendment(enquiry),
          text: api.enquiryTextForIds(["enq-1"]),
        }
      })
      assert.deepEqual(acknowledgedAmendment, {
        storedRevision: 2,
        pending: false,
        text: `Good day, please quote for the following enquiries.\n\n${amendmentUpdate.formattedText}`,
      })
      assert.equal(
        await secondTraderPage.locator(
          "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1']",
        ).evaluate((row) => getComputedStyle(row).backgroundColor),
        "rgb(244, 246, 248)",
      )

      const thirdTraderPage = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      await thirdTraderPage.goto(`${url}?firstRun=1`, { waitUntil: "domcontentloaded" })
      await thirdTraderPage.evaluate((update) => {
        window.enquiryOverrides["enq-1"] = update
        window.__FCUNO_WA_SPC_TEST_API__.loadEnquiries()
      }, amendmentUpdate)
      await thirdTraderPage.waitForSelector(
        "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1'].is-amendment-pending",
      )
      assert.equal(
        await thirdTraderPage.evaluate(
          () => window.storageData["fcuno-wa-spc-board-v1"]?.acknowledgedAmendmentRevisions?.["enq-1"] || 0,
        ),
        0,
      )
      await thirdTraderPage.close()

      const outcomeCases = [
        {
          label: "STEM",
          update: {
            status: "quoted",
            meta: {},
            updatedAt: "2026-07-23T09:26:00Z",
          },
        },
        {
          label: "LOST",
          update: {
            status: "cancelled",
            meta: {},
            updatedAt: "2026-07-23T09:27:00Z",
          },
        },
        {
          label: "POST",
          update: {
            status: "sent",
            meta: { postponedAt: "2026-07-23T09:28:00Z" },
            updatedAt: "2026-07-23T09:28:00Z",
          },
        },
        {
          label: "CANX",
          update: {
            status: "sent",
            meta: { cancelledAt: "2026-07-23T09:29:00Z" },
            updatedAt: "2026-07-23T09:29:00Z",
          },
        },
      ]
      for (const outcomeCase of outcomeCases) {
        await Promise.all([
          firstRunPage.evaluate((update) => {
            window.enquiryOverrides["enq-1"] = update
            window.__FCUNO_WA_SPC_TEST_API__.loadEnquiries()
          }, outcomeCase.update),
          secondTraderPage.evaluate((update) => {
            window.enquiryOverrides["enq-1"] = update
            window.__FCUNO_WA_SPC_TEST_API__.loadEnquiries()
          }, outcomeCase.update),
        ])
        await secondTraderPage.waitForFunction(
          (label) =>
            document.querySelector(
              "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1'] .fcuno-wa-spc-status",
            )?.textContent === label,
          outcomeCase.label,
        )
        assert.equal(
          await firstRunPage.locator(
            "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1']",
          ).count(),
          0,
        )
      }
      assert.equal(
        await secondTraderPage.locator(
          "#fcuno-wa-spc-board .fcuno-wa-spc-enquiry[data-id='enq-1'] .fcuno-wa-spc-status",
        ).textContent(),
        "CANX",
      )
      await secondTraderPage.close()
      await firstRunPage.close()

      const invalidStartPage = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      const invalidStartErrors = []
      invalidStartPage.on("pageerror", (error) => invalidStartErrors.push(error.message))
      await invalidStartPage.goto(`${url}?invalidateStorage=1`, { waitUntil: "domcontentloaded" })
      await invalidStartPage.waitForTimeout(100)
      const invalidStartState = await invalidStartPage.evaluate(() => ({
        boards: document.querySelectorAll("#fcuno-wa-spc-board").length,
        owner: document.documentElement.getAttribute("data-fcuno-whatsapp-board-owner") || "",
        activeClass: document.body.classList.contains("fcuno-wa-spc-active") || document.body.classList.contains("fcuno-wa-spc-collapsed"),
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
      await lifecyclePage.waitForSelector("#fcuno-wa-spc-board")
      await lifecyclePage.evaluate(() => {
        const originalSet = window.chrome.storage.local.set
        window.restoreStorageSet = () => { window.chrome.storage.local.set = originalSet }
        window.chrome.storage.local.set = () => { throw new Error("Extension context invalidated.") }
        window.promptResponse = "RELOAD TEST"
        const api = window.__FCUNO_WA_SPC_TEST_API__
        api.state.contacts = [{ id: "reload-contact", name: "Reload Contact", chatName: "Reload Contact", list: "supplier", order: 1000 }]
        api.renameContact("reload-contact")
      })
      await lifecyclePage.waitForFunction(() => !document.getElementById("fcuno-wa-spc-board"))
      const stoppedLifecycle = await lifecyclePage.evaluate(() => ({
        owner: document.documentElement.getAttribute("data-fcuno-whatsapp-board-owner") || "",
        activeClass: document.body.classList.contains("fcuno-wa-spc-active") || document.body.classList.contains("fcuno-wa-spc-collapsed"),
      }))
      assert.deepEqual(stoppedLifecycle, { owner: "", activeClass: false })

      await lifecyclePage.evaluate(() => window.restoreStorageSet())
      await lifecyclePage.addScriptTag({ content: extensionSource })
      await lifecyclePage.waitForSelector("#fcuno-wa-spc-board")
      const restartedLifecycle = await lifecyclePage.evaluate(() => ({
        boards: document.querySelectorAll("#fcuno-wa-spc-board").length,
        owner: document.documentElement.getAttribute("data-fcuno-whatsapp-board-owner") || "",
      }))
      assert.deepEqual(restartedLifecycle, { boards: 1, owner: "spc" })
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
    console.log("SPC WhatsApp browser send test passed")
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
