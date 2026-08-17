(() => {
  "use strict"

  const BOARD_ID = "fcuno-spc-group-dispatcher"
  const POLL_MS = 2000
  const VERSION = chrome.runtime.getManifest().version
  let state = {
    paired: false,
    paused: false,
    busy: false,
    groupName: "",
    deviceLabel: "SPC Trading Desktop",
    status: "Loading...",
    error: "",
    lastDelivery: "",
  }
  let timer = 0

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim()
  }

  function comparable(value) {
    return cleanText(value).replace(/\*/g, "").toLowerCase()
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
  }

  function isVisible(element) {
    if (!element || element.closest(`#${BOARD_ID}`)) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError
          if (error) reject(new Error(error.message || String(error)))
          else if (!response?.ok) reject(new Error(response?.message || "Dispatcher request failed."))
          else resolve(response)
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  function render() {
    let root = document.getElementById(BOARD_ID)
    if (!root) {
      root = document.createElement("aside")
      root.id = BOARD_ID
      document.body.appendChild(root)
      document.body.classList.add("fcuno-spc-dispatcher-active")
    }
    root.innerHTML = `
      <header>
        <img src="${escapeHtml(chrome.runtime.getURL("spc-sidebar-logo.png"))}" alt="Singapore Purchasing Center" />
        <span>GROUP DISPATCHER <b>v${escapeHtml(VERSION)}</b></span>
      </header>
      <main>
        ${state.paired ? `
          <dl>
            <div><dt>DEVICE</dt><dd>${escapeHtml(state.deviceLabel)}</dd></div>
            <div><dt>TRADING GROUP</dt><dd>${escapeHtml(state.groupName)}</dd></div>
          </dl>
          <div class="fcuno-spc-dispatcher-status${state.error ? " is-error" : ""}">
            <i></i><span>${escapeHtml(state.error || state.status)}</span>
          </div>
          ${state.lastDelivery ? `<p class="fcuno-spc-dispatcher-last">${escapeHtml(state.lastDelivery)}</p>` : ""}
          <button type="button" data-action="pause" class="is-secondary">${state.paused ? "RESUME" : "PAUSE"}</button>
        ` : `
          <p>Pair this dedicated Windows desktop with one exact WhatsApp trading group.</p>
          <label>DEVICE LABEL<input name="deviceLabel" value="${escapeHtml(state.deviceLabel)}" maxlength="100" /></label>
          <label>EXACT GROUP NAME<input name="groupName" value="${escapeHtml(state.groupName)}" maxlength="200" /></label>
          <button type="button" data-action="pair">PAIR DISPATCHER</button>
          <small>Open and log in to spc.fcuno.com in this Chrome profile before pairing.</small>
        `}
      </main>
    `
  }

  function getMain() {
    return document.querySelector("#main") || document.querySelector("[role='main']")
  }

  function textCandidates(root) {
    if (!root) return []
    return Array.from(root.querySelectorAll("span[title], div[title], [dir='auto']"))
      .filter(isVisible)
      .map((element) => cleanText(element.getAttribute("title") || element.textContent))
      .filter(Boolean)
  }

  function currentChatName() {
    const header = getMain()?.querySelector("header")
    return textCandidates(header)[0] || ""
  }

  function currentChatIsGroup() {
    const main = getMain()
    if (!main) return false
    const labels = Array.from(main.querySelectorAll("header [aria-label], header [title]"))
      .map((element) => cleanText(element.getAttribute("aria-label") || element.getAttribute("title")))
    if (labels.some((label) => /group info|message to group/i.test(label))) return true
    const subtitle = textCandidates(main.querySelector("header")).slice(1).join(" ")
    return /[,，]/.test(subtitle) && /\byou\b/i.test(subtitle)
  }

  function exactGroupIsOpen(groupName) {
    return currentChatName().toLowerCase() === cleanText(groupName).toLowerCase() && currentChatIsGroup()
  }

  function findSearchBox() {
    const root = document.querySelector("#side") || document.body
    const candidates = Array.from(root.querySelectorAll("input[type='text'], [contenteditable='true'][role='textbox'], [role='textbox']"))
      .filter(isVisible)
    return candidates.find((element) => {
      const label = cleanText(element.getAttribute("aria-label") || element.getAttribute("placeholder")).toLowerCase()
      return label.includes("search")
    }) || candidates.find((element) => element.getBoundingClientRect().top < 180) || null
  }

  function editableText(element) {
    return element && "value" in element ? String(element.value || "") : String(element?.textContent || "")
  }

  async function replaceText(element, text) {
    if (!element || !isVisible(element)) return false
    element.focus()
    await runtimeMessage({ type: "native-replace-text", text })
    await new Promise((resolve) => setTimeout(resolve, 60))
    return editableText(element) === text
  }

  function visibleChatRows() {
    const pane = document.querySelector("#pane-side") || document.querySelector("#side")
    if (!pane) return []
    const rows = Array.from(pane.querySelectorAll("[data-testid='cell-frame-container'], [role='listitem'], [role='row']"))
      .filter(isVisible)
      .filter((row) => !row.closest("[role='search']"))
    return rows.filter((row, index) => rows.indexOf(row) === index)
  }

  function rowPrimaryName(row) {
    return textCandidates(row)[0] || ""
  }

  async function nativeClick(element) {
    element.scrollIntoView({ block: "center", inline: "nearest" })
    const rect = element.getBoundingClientRect()
    await runtimeMessage({
      type: "native-click",
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    })
  }

  async function openExactGroup(groupName) {
    if (exactGroupIsOpen(groupName)) return true
    const search = findSearchBox()
    if (!search) throw new Error("WhatsApp search is unavailable.")
    if (!(await replaceText(search, groupName))) throw new Error("WhatsApp did not accept the group search text.")

    for (const delay of [80, 150, 260, 420, 650]) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      const exactRows = visibleChatRows().filter(
        (row) => rowPrimaryName(row).toLowerCase() === groupName.toLowerCase(),
      )
      if (exactRows.length > 1) throw new Error("STOP_REVIEW: More than one exact WhatsApp group match was found.")
      if (exactRows.length !== 1) continue
      await nativeClick(exactRows[0])
      for (const verifyDelay of [100, 180, 300, 500]) {
        await new Promise((resolve) => setTimeout(resolve, verifyDelay))
        if (exactGroupIsOpen(groupName)) {
          await replaceText(findSearchBox(), "").catch(() => false)
          return true
        }
      }
      throw new Error("STOP_REVIEW: WhatsApp opened a different chat or a non-group result.")
    }
    throw new Error(`Exact WhatsApp group not found: ${groupName}`)
  }

  function findComposer() {
    const main = getMain()
    if (!main) return null
    const candidates = Array.from(main.querySelectorAll("[contenteditable='true'][role='textbox'], [contenteditable='true']"))
      .filter(isVisible)
    return candidates[candidates.length - 1] || null
  }

  function outgoingMessageCount(message) {
    const target = comparable(message)
    if (!target) return 0
    return Array.from(getMain()?.querySelectorAll("[data-id^='true_'], [data-id*='true_']") || [])
      .filter(isVisible)
      .filter((row) => comparable(row.innerText || row.textContent).includes(target))
      .length
  }

  async function sendAndVerify(message) {
    const composer = findComposer()
    if (!composer) throw new Error("WhatsApp message box is unavailable.")
    const beforeCount = outgoingMessageCount(message)
    composer.focus()
    await runtimeMessage({ type: "native-replace-text", text: "" })
    await runtimeMessage({ type: "native-insert-text", text: message })
    await new Promise((resolve) => setTimeout(resolve, 120))
    if (!comparable(composer.innerText || composer.textContent).includes(comparable(message))) {
      throw new Error("WhatsApp did not accept the enquiry text.")
    }
    await runtimeMessage({ type: "native-enter" })

    for (const delay of [180, 320, 500, 800, 1200]) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      const nextComposer = findComposer()
      if (outgoingMessageCount(message) > beforeCount && !cleanText(nextComposer?.innerText || nextComposer?.textContent)) {
        return true
      }
    }
    throw new Error("SEND_UNCERTAIN: WhatsApp did not confirm a new outgoing message.")
  }

  async function processQueue() {
    if (!state.paired || state.paused || state.busy) return
    state.busy = true
    state.error = ""
    state.status = "Checking queue..."
    render()
    let claim = null
    try {
      claim = await runtimeMessage({ type: "dispatcher-claim" })
      if (!claim.job) {
        state.status = "Connected. Waiting for enquiries."
        return
      }
      state.groupName = claim.dispatcher.groupName
      state.status = `Sending REV ${claim.job.revisionNumber}...`
      render()
      await openExactGroup(state.groupName)
      if (claim.job.attemptCount > 1 && outgoingMessageCount(claim.job.messageText) > 0) {
        await runtimeMessage({
          type: "dispatcher-complete",
          jobId: claim.job.id,
          claimToken: claim.claimToken,
          result: "sent",
        })
        state.lastDelivery = `Recovered ${claim.job.eventType} enquiry REV ${claim.job.revisionNumber} without resending.`
        state.status = "Connected. Waiting for enquiries."
        return
      }
      await sendAndVerify(claim.job.messageText)
      await runtimeMessage({
        type: "dispatcher-complete",
        jobId: claim.job.id,
        claimToken: claim.claimToken,
        result: "sent",
      })
      state.lastDelivery = `Sent ${claim.job.eventType} enquiry REV ${claim.job.revisionNumber}.`
      state.status = "Connected. Waiting for enquiries."
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const requiresReview = /^(SEND_UNCERTAIN|STOP_REVIEW):/.test(message)
      state.error = requiresReview
        ? message.replace(/^(SEND_UNCERTAIN|STOP_REVIEW):\s*/, "Manual review required: ")
        : message
      if (claim?.job && claim?.claimToken) {
        await runtimeMessage({
          type: "dispatcher-complete",
          jobId: claim.job.id,
          claimToken: claim.claimToken,
          result: requiresReview ? "manual_review" : "failed",
          error: message,
        }).catch(() => {})
      }
    } finally {
      state.busy = false
      render()
    }
  }

  async function load() {
    try {
      const saved = await runtimeMessage({ type: "dispatcher-state" })
      state.paired = Boolean(saved.token)
      state.paused = Boolean(saved.paused)
      state.groupName = cleanText(saved.groupName)
      state.deviceLabel = cleanText(saved.deviceLabel) || state.deviceLabel
      state.status = state.paired ? "Connected. Waiting for enquiries." : "Pairing required."
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    }
    render()
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.(`#${BOARD_ID} button[data-action]`)
    if (!button) return
    const action = button.dataset.action
    if (action === "pair") {
      const root = document.getElementById(BOARD_ID)
      const deviceLabel = cleanText(root?.querySelector("input[name='deviceLabel']")?.value)
      const groupName = cleanText(root?.querySelector("input[name='groupName']")?.value)
      state.error = ""
      state.status = "Pairing..."
      render()
      try {
        const paired = await runtimeMessage({ type: "dispatcher-pair", deviceLabel, groupName })
        state.paired = true
        state.paused = false
        state.deviceLabel = paired.deviceLabel
        state.groupName = paired.groupName
        state.status = "Connected. Waiting for enquiries."
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error)
      }
      render()
    }
    if (action === "pause") {
      state.paused = !state.paused
      await runtimeMessage({ type: "dispatcher-set-paused", paused: state.paused }).catch(() => {})
      state.status = state.paused ? "Paused by operator." : "Connected. Waiting for enquiries."
      render()
    }
  })

  void load().then(() => {
    timer = window.setInterval(() => void processQueue(), POLL_MS)
    void processQueue()
  })

  window.addEventListener("beforeunload", () => {
    if (timer) window.clearInterval(timer)
  })
})()
