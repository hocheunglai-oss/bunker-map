(() => {
  "use strict"

  const BOARD_ID = "fcuno-spc-group-dispatcher"
  const POLL_MS = 2000
  const PAIR_RETRY_MS = 10000
  const VERSION = chrome.runtime.getManifest().version
  const LOGO_URL = chrome.runtime.getURL("spc-sidebar-logo.png")
  let state = {
    paired: false,
    busy: false,
    status: "Loading...",
    error: "",
  }
  let timer = 0
  let nextPairAttempt = 0

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
        <img src="${escapeHtml(LOGO_URL)}" alt="Singapore Purchasing Center" />
        <span>DELIVERY <b>v${escapeHtml(VERSION)}</b></span>
      </header>
      <main>
        <div class="fcuno-spc-dispatcher-status${state.error ? " is-error" : ""}">
          <i></i><span>${escapeHtml(state.error || state.status)}</span>
        </div>
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

  function currentChatNames() {
    const header = getMain()?.querySelector("header")
    return textCandidates(header)
  }

  function exactChatIsOpen(groupName) {
    const expected = cleanText(groupName).toLowerCase()
    return currentChatNames().some((candidate) => candidate.toLowerCase() === expected)
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

  function sameVisualChatRow(left, right) {
    if (left === right || left.contains(right) || right.contains(left)) return true
    const leftRect = left.getBoundingClientRect()
    const rightRect = right.getBoundingClientRect()
    return Math.abs(leftRect.top - rightRect.top) <= 2
      && Math.abs(leftRect.bottom - rightRect.bottom) <= 2
      && Math.abs(leftRect.left - rightRect.left) <= 2
      && Math.abs(leftRect.right - rightRect.right) <= 2
  }

  function preferredVisualChatRow(left, right) {
    if (left.contains(right)) return left
    if (right.contains(left)) return right
    const leftIsCell = left.matches("[data-testid='cell-frame-container']")
    const rightIsCell = right.matches("[data-testid='cell-frame-container']")
    if (leftIsCell !== rightIsCell) return leftIsCell ? left : right
    const leftRect = left.getBoundingClientRect()
    const rightRect = right.getBoundingClientRect()
    return leftRect.width * leftRect.height >= rightRect.width * rightRect.height ? left : right
  }

  function uniqueVisualChatRows(rows) {
    return rows.reduce((unique, row) => {
      const matchIndex = unique.findIndex((candidate) => sameVisualChatRow(candidate, row))
      if (matchIndex === -1) unique.push(row)
      else unique[matchIndex] = preferredVisualChatRow(unique[matchIndex], row)
      return unique
    }, [])
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
    if (exactChatIsOpen(groupName)) return true
    const search = findSearchBox()
    if (!search) throw new Error("WhatsApp search is unavailable.")
    if (!(await replaceText(search, groupName))) throw new Error("WhatsApp did not accept the group search text.")

    for (const delay of [500, 900, 1400, 2200]) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      const exactRows = uniqueVisualChatRows(visibleChatRows().filter(
        (row) => rowPrimaryName(row).toLowerCase() === groupName.toLowerCase(),
      ))
      if (exactRows.length > 1) throw new Error("STOP_REVIEW: More than one exact WhatsApp group match was found.")
      if (exactRows.length !== 1) continue
      await new Promise((resolve) => setTimeout(resolve, 500))
      await nativeClick(exactRows[0])
      for (const verifyDelay of [700, 1200, 1800, 2600]) {
        await new Promise((resolve) => setTimeout(resolve, verifyDelay))
        if (exactChatIsOpen(groupName)) {
          await replaceText(findSearchBox(), "").catch(() => false)
          return true
        }
      }
      throw new Error("STOP_REVIEW: WhatsApp opened a chat with a different title.")
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
    const rows = Array.from(getMain()?.querySelectorAll(
      ".message-out, [data-testid='msg-container'], [data-id^='true_'], [data-id*='true_']",
    ) || [])
      .filter((row, index, allRows) => allRows.indexOf(row) === index)
      .filter(isVisible)
      .filter((row) => {
        if (row.matches(".message-out") || row.closest(".message-out")) return true
        const identified = row.matches("[data-id]") ? row : row.closest("[data-id]")
        return String(identified?.getAttribute("data-id") || "").includes("true_")
      })
    return rows
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
    let accepted = false
    for (const delay of [250, 500, 900]) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      const nextComposer = findComposer()
      if (comparable(nextComposer?.innerText || nextComposer?.textContent).includes(comparable(message))) {
        accepted = true
        break
      }
      if (outgoingMessageCount(message) > beforeCount) return true
    }
    if (!accepted) {
      throw new Error("SEND_UNCERTAIN: WhatsApp did not confirm the enquiry text before sending.")
    }
    await runtimeMessage({ type: "native-enter" })

    for (const delay of [700, 1200, 2000, 3000, 4500]) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      if (outgoingMessageCount(message) > beforeCount) return true
    }
    throw new Error("SEND_UNCERTAIN: WhatsApp did not confirm a new outgoing message.")
  }

  async function processQueue() {
    if (!state.paired || state.busy) return
    state.busy = true
    if (!state.error) state.status = "Checking for enquiries..."
    render()
    let claim = null
    try {
      claim = await runtimeMessage({ type: "dispatcher-claim" })
      if (!claim.job) {
        if (!state.error) state.status = "Delivery active."
        return
      }
      state.error = ""
      state.status = `Delivering REV ${claim.job.revisionNumber}...`
      render()
      await openExactGroup(claim.job.groupName)
      if (claim.job.attemptCount > 1 && outgoingMessageCount(claim.job.messageText) > 0) {
        await runtimeMessage({
          type: "dispatcher-complete",
          jobId: claim.job.id,
          claimToken: claim.claimToken,
          result: "sent",
        })
        state.status = "Delivery active."
        return
      }
      await sendAndVerify(claim.job.messageText)
      await runtimeMessage({
        type: "dispatcher-complete",
        jobId: claim.job.id,
        claimToken: claim.claimToken,
        result: "sent",
      })
      state.status = "Delivery active."
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

  async function connect() {
    if (state.paired || state.busy || Date.now() < nextPairAttempt) return
    nextPairAttempt = Date.now() + PAIR_RETRY_MS
    state.busy = true
    state.error = ""
    state.status = "Connecting..."
    render()
    try {
      const saved = await runtimeMessage({ type: "dispatcher-state" })
      if (saved.paused) await runtimeMessage({ type: "dispatcher-set-paused", paused: false })
      if (!saved.token) {
        await runtimeMessage({ type: "dispatcher-pair", deviceLabel: "SPC Trading Desktop" })
      }
      state.paired = true
      state.status = "Delivery active."
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.error = `Connection failed. Sign in to spc.fcuno.com, then refresh WhatsApp Web. ${message}`
    } finally {
      state.busy = false
      render()
    }
  }

  void connect().then(() => {
    timer = window.setInterval(() => {
      if (state.paired) void processQueue()
      else void connect()
    }, POLL_MS)
    if (state.paired) void processQueue()
  })

  window.addEventListener("beforeunload", () => {
    if (timer) window.clearInterval(timer)
  })
})()
