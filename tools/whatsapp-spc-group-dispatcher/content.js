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
    phase: "connecting",
    status: "Starting redelivery",
    error: "",
    activity: null,
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

  function setText(element, value) {
    const next = String(value || "")
    if (element && element.textContent !== next) element.textContent = next
  }

  function activityResult(activity) {
    if (!activity) return ""
    if (activity.status === "sending" || activity.status === "claimed") return "Sending"
    if (activity.status === "sent") return "Sent"
    if (activity.status === "manual_review") return "Manual review"
    if (activity.status === "failed") return "Not delivered"
    return "Received"
  }

  function activityBadge(activity) {
    if (activity.eventType === "amended") return `REV ${activity.revisionNumber}`
    if (activity.eventType === "postponed") return "POST"
    if (activity.eventType === "reoffer") return "REOFFER"
    return "NEW"
  }

  function sendingStatus(activity) {
    if (activity.eventType === "amended") return `Sending revision ${activity.revisionNumber}`
    if (activity.eventType === "postponed") return "Sending postponement"
    if (activity.eventType === "reoffer") return "Sending reoffer"
    return "Sending enquiry"
  }

  function render() {
    let root = document.getElementById(BOARD_ID)
    if (!root) {
      root = document.createElement("aside")
      root.id = BOARD_ID
      document.body.appendChild(root)
      document.body.classList.add("fcuno-spc-dispatcher-active")
      root.innerHTML = `
        <header>
          <img src="${escapeHtml(LOGO_URL)}" alt="Singapore Purchasing Center" />
          <span>REDELIVERY <b>v${escapeHtml(VERSION)}</b></span>
        </header>
        <main>
          <div class="fcuno-spc-dispatcher-status is-connecting" data-role="status">
            <i><em></em></i>
            <div>
              <strong data-role="status-title"></strong>
              <span data-role="status-detail"></span>
            </div>
          </div>
          <section class="fcuno-spc-dispatcher-activity" data-role="activity" hidden>
            <div class="fcuno-spc-dispatcher-activity-head">
              <span data-role="activity-badge"></span>
              <strong data-role="activity-result"></strong>
            </div>
            <p data-role="activity-message"></p>
            <span data-role="activity-route"></span>
          </section>
          <p class="fcuno-spc-dispatcher-empty" data-role="empty">Waiting for the next enquiry.</p>
        </main>
      `
    }
    const status = root.querySelector("[data-role='status']")
    status.className = `fcuno-spc-dispatcher-status is-${state.error ? "error" : state.phase}`
    setText(root.querySelector("[data-role='status-title']"), state.error || state.status)
    const statusDetail = state.error
      ? "Enquiry retained for review"
      : state.phase === "working"
        ? "WhatsApp is preparing the message"
        : state.phase === "sent"
          ? "Monitoring SPC enquiries"
          : state.phase === "ready"
            ? "Monitoring SPC enquiries"
            : "Connecting securely to SPC"
    setText(root.querySelector("[data-role='status-detail']"), statusDetail)

    const activity = root.querySelector("[data-role='activity']")
    const empty = root.querySelector("[data-role='empty']")
    if (!state.activity) {
      activity.hidden = true
      empty.hidden = false
      return
    }
    empty.hidden = true
    activity.hidden = false
    activity.className = `fcuno-spc-dispatcher-activity is-${state.activity.status || "received"}`
    setText(activity.querySelector("[data-role='activity-badge']"), activityBadge(state.activity))
    setText(activity.querySelector("[data-role='activity-result']"), activityResult(state.activity))
    setText(activity.querySelector("[data-role='activity-message']"), state.activity.messageText)
    setText(activity.querySelector("[data-role='activity-route']"), `To ${state.activity.groupName}`)
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

  function composerText(composer) {
    return cleanText(composer?.innerText || composer?.textContent || "")
  }

  function clearComposerText(composer) {
    composer.focus()
    const selection = window.getSelection()
    if (selection) {
      const range = document.createRange()
      range.selectNodeContents(composer)
      selection.removeAllRanges()
      selection.addRange(range)
    } else {
      document.execCommand("selectAll", false)
    }
    document.execCommand("delete", false)
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "deleteContentBackward",
      data: "",
    }))
    if (composerText(composer)) {
      composer.replaceChildren()
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
        data: "",
      }))
    }
  }

  function setComposerDomText(composer, text) {
    const lines = String(text || "").split("\n")
    composer.replaceChildren()
    lines.forEach((line, index) => {
      if (index > 0) composer.appendChild(document.createElement("br"))
      composer.appendChild(document.createTextNode(line))
    })
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text,
    }))
  }

  function replaceComposerText(composer, text) {
    clearComposerText(composer)
    setComposerDomText(composer, text)
  }

  function sendButtonLabel(element) {
    const labels = [element, ...element.querySelectorAll("[aria-label], [title], [data-testid], [data-icon]")]
      .flatMap((candidate) => [
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title"),
        candidate.getAttribute("data-testid"),
        candidate.getAttribute("data-icon"),
      ])
      .map(cleanText)
      .filter(Boolean)
    return labels.join(" ").toLowerCase()
  }

  function isSendButton(element) {
    return /\bsend\b|send-filled|wds-ic-send/.test(sendButtonLabel(element))
  }

  function findSendButton(composer) {
    const main = getMain()
    if (!main || !composer) return null
    const composerRect = composer.getBoundingClientRect()
    const candidates = Array.from(main.querySelectorAll(
      "button, [role='button'], span[data-icon], [data-testid]",
    ))
      .map((element) => element.closest("button, [role='button']") || element)
      .filter((element, index, all) => all.indexOf(element) === index)
      .filter(isVisible)
      .filter(isSendButton)
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        const verticallyAligned = rect.bottom >= composerRect.top - 20
          && rect.top <= composerRect.bottom + 40
        const toComposerRight = rect.left >= composerRect.right - 180
        return verticallyAligned && toComposerRight
      })
    if (candidates.length !== 1) return null
    return candidates[0]
  }

  function matchingOutgoingMessageRows(message) {
    const target = comparable(message)
    if (!target) return []
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
    return rows.filter((row) => comparable(row.innerText || row.textContent).includes(target))
  }

  function outgoingMessageCount(message) {
    return matchingOutgoingMessageRows(message).length
  }

  function outgoingMessageIdentity(row) {
    const identified = row.matches("[data-id]") ? row : row.closest("[data-id]") || row.querySelector("[data-id]")
    return cleanText(identified?.getAttribute("data-id"))
  }

  function outgoingMessageSnapshot(message) {
    const rows = matchingOutgoingMessageRows(message)
    return {
      identities: new Set(rows.map(outgoingMessageIdentity).filter(Boolean)),
      rows: new Set(rows),
    }
  }

  function hasNewOutgoingMessage(message, before) {
    return matchingOutgoingMessageRows(message).some((row) => {
      const identity = outgoingMessageIdentity(row)
      if (identity) return !before.identities.has(identity)
      return !before.rows.has(row)
    })
  }

  async function waitForOutgoingMessage(message, beforeSnapshot, delays) {
    for (const delay of delays) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      if (hasNewOutgoingMessage(message, beforeSnapshot)) return true
    }
    return false
  }

  async function sendAndVerify(message, groupName) {
    const composer = findComposer()
    if (!composer) throw new Error("WhatsApp message box is unavailable.")
    const beforeSnapshot = outgoingMessageSnapshot(message)
    replaceComposerText(composer, message)

    let staged = false
    let sendButton = null
    for (const delay of [120, 250, 500, 800, 1200]) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      const nextComposer = findComposer()
      if (comparable(composerText(nextComposer)) !== comparable(message)) continue
      staged = true
      sendButton = findSendButton(nextComposer)
      if (sendButton) break
    }
    if (!staged) {
      throw new Error("SEND_UNCERTAIN: WhatsApp did not stage the exact enquiry text.")
    }
    if (!exactChatIsOpen(groupName)) {
      throw new Error("STOP_REVIEW: WhatsApp changed to a different chat before sending.")
    }
    if (comparable(composerText(findComposer())) !== comparable(message)) {
      throw new Error("SEND_UNCERTAIN: WhatsApp changed the staged enquiry text.")
    }

    await runtimeMessage({ type: "native-enter" })
    if (await waitForOutgoingMessage(message, beforeSnapshot, [500, 900, 1400])) return true

    const remainingComposer = findComposer()
    const remainingTextIsExact = comparable(composerText(remainingComposer)) === comparable(message)
    if (remainingTextIsExact) {
      sendButton = findSendButton(remainingComposer)
      if (sendButton) {
        await nativeClick(sendButton)
        if (await waitForOutgoingMessage(message, beforeSnapshot, [500, 900, 1400, 2200, 3500])) return true
      }
    }
    throw new Error("SEND_UNCERTAIN: WhatsApp did not confirm a new outgoing message.")
  }

  async function processQueue() {
    if (!state.paired || state.busy) return
    state.busy = true
    let claim = null
    try {
      claim = await runtimeMessage({ type: "dispatcher-claim" })
      if (!claim.job) {
        if (!state.error && state.phase === "connecting") {
          state.phase = "ready"
          state.status = "Ready for enquiries"
          render()
        }
        return
      }
      state.error = ""
      state.phase = "working"
      state.status = sendingStatus(claim.job)
      state.activity = { ...claim.job, status: "sending" }
      render()
      await openExactGroup(claim.job.groupName)
      if (claim.job.attemptCount > 1 && outgoingMessageCount(claim.job.messageText) > 0) {
        await runtimeMessage({
          type: "dispatcher-complete",
          jobId: claim.job.id,
          claimToken: claim.claimToken,
          result: "sent",
        })
        state.phase = "sent"
        state.status = "Enquiry sent"
        state.activity = { ...claim.job, status: "sent" }
        return
      }
      await sendAndVerify(claim.job.messageText, claim.job.groupName)
      await runtimeMessage({
        type: "dispatcher-complete",
        jobId: claim.job.id,
        claimToken: claim.claimToken,
        result: "sent",
      })
      state.phase = "sent"
      state.status = "Enquiry sent"
      state.activity = { ...claim.job, status: "sent" }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const requiresReview = /^(SEND_UNCERTAIN|STOP_REVIEW):/.test(message)
      state.phase = "error"
      state.error = requiresReview
        ? message.replace(/^(SEND_UNCERTAIN|STOP_REVIEW):\s*/, "Manual review required: ")
        : message
      if (claim?.job) {
        state.activity = { ...claim.job, status: requiresReview ? "manual_review" : "failed" }
      }
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
    state.phase = "connecting"
    state.status = "Connecting redelivery"
    render()
    try {
      const saved = await runtimeMessage({ type: "dispatcher-state" })
      if (saved.paused) await runtimeMessage({ type: "dispatcher-set-paused", paused: false })
      if (!saved.token) {
        await runtimeMessage({ type: "dispatcher-pair", deviceLabel: "SPC Trading Desktop" })
      }
      state.paired = true
      const latest = await runtimeMessage({ type: "dispatcher-latest" })
      if (latest.job) {
        state.activity = latest.job
        if (latest.job.status === "manual_review" || latest.job.status === "failed") {
          state.phase = "error"
          state.error = latest.job.lastError
            ? latest.job.lastError.replace(/^(SEND_UNCERTAIN|STOP_REVIEW):\s*/, "Manual review required: ")
            : "The latest enquiry requires review."
        } else if (latest.job.status === "sent") {
          state.phase = "sent"
          state.status = "Latest enquiry sent"
        }
      }
      if (!state.error && state.phase !== "sent") {
        state.phase = "ready"
        state.status = "Ready for enquiries"
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.phase = "error"
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
