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
    collapsed: false,
    phase: "connecting",
    status: "Starting redelivery",
    error: "",
    errorType: "",
    activity: null,
    history: [],
  }
  let timer = 0
  let nextPairAttempt = 0

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim()
  }

  function comparable(value) {
    return cleanText(value).replace(/\*/g, "").toLowerCase()
  }

  function chatNameKey(value) {
    // WhatsApp adds direction controls around some search highlights. They are
    // presentation metadata, not part of the configured group name.
    return cleanText(String(value || "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ""))
      .normalize("NFC")
      .toLowerCase()
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

  function amendmentNumber(activity) {
    const storedRevision = Math.max(2, Math.floor(Number(activity?.revisionNumber) || 2))
    return storedRevision - 1
  }

  function activityBadge(activity) {
    if (activity.eventType === "amended") return `REV ${amendmentNumber(activity)}`
    if (activity.eventType === "postponed") return "POST"
    if (activity.eventType === "reoffer") return "REOFFER"
    return "NEW"
  }

  function sendingStatus(activity) {
    if (activity.eventType === "amended") return `Sending revision ${amendmentNumber(activity)}`
    if (activity.eventType === "postponed") return "Sending postponement"
    if (activity.eventType === "reoffer") return "Sending reoffer"
    return "Sending enquiry"
  }

  function activityTime(value) {
    const date = new Date(String(value || ""))
    if (Number.isNaN(date.getTime())) return ""
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  function recentHistory(items) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const seen = new Set()
    return (Array.isArray(items) ? items : [])
      .filter((item) => item?.id && item?.status === "sent" && Date.parse(item.updatedAt || "") >= cutoff)
      .filter((item) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
      .slice(0, 100)
  }

  function recordSentActivity(activity) {
    const sent = { ...activity, status: "sent", updatedAt: new Date().toISOString() }
    state.activity = sent
    state.history = recentHistory([sent, ...state.history])
  }

  function renderHistory(items) {
    const rows = recentHistory(items).map((item) => `
      <article class="fcuno-spc-dispatcher-history-row">
        <div>
          <strong>${escapeHtml(activityBadge(item))} · SENT</strong>
          <time>${escapeHtml(activityTime(item.updatedAt))}</time>
        </div>
        <p>${escapeHtml(item.messageText)}</p>
        <span>To ${escapeHtml(item.groupName)}</span>
      </article>
    `).join("")
    return rows || '<p class="fcuno-spc-dispatcher-history-empty">No confirmed sends in the last 24 hours.</p>'
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
          <button type="button" data-action="toggle" title="Minimize REDelivery" aria-label="Minimize REDelivery">›</button>
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
          <section class="fcuno-spc-dispatcher-history">
            <h2>Sent · last 24 hours <span data-role="history-count"></span></h2>
            <div data-role="history"></div>
          </section>
        </main>
      `
      root.querySelector("[data-action='toggle']")?.addEventListener("click", () => {
        state.collapsed = !state.collapsed
        void runtimeMessage({ type: "dispatcher-set-collapsed", collapsed: state.collapsed }).catch(() => {})
        render()
      })
    }
    root.classList.toggle("is-collapsed", state.collapsed)
    document.body.classList.toggle("fcuno-spc-dispatcher-collapsed", state.collapsed)
    document.body.classList.toggle("fcuno-spc-dispatcher-active", !state.collapsed)
    const toggle = root.querySelector("[data-action='toggle']")
    setText(toggle, state.collapsed ? "‹" : "›")
    toggle?.setAttribute("title", state.collapsed ? "Open REDelivery" : "Minimize REDelivery")
    toggle?.setAttribute("aria-label", state.collapsed ? "Open REDelivery" : "Minimize REDelivery")
    const status = root.querySelector("[data-role='status']")
    const statusPhase = state.error
      ? state.errorType === "connection" ? "connecting" : "error"
      : state.phase
    status.className = `fcuno-spc-dispatcher-status is-${statusPhase}`
    setText(root.querySelector("[data-role='status-title']"), state.error || state.status)
    const statusDetail = state.error
      ? state.errorType === "connection"
        ? "Retrying automatically; last delivery result is unchanged"
        : state.errorType === "review"
          ? "Enquiry retained for review"
          : state.errorType === "delivery"
            ? "Delivery will retry automatically"
            : "Open SPC, sign in, then refresh WhatsApp Web"
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
    const currentActivity = state.activity?.status === "sent" ? null : state.activity
    if (!currentActivity) {
      activity.hidden = true
      empty.hidden = state.history.length > 0
    } else {
      empty.hidden = true
      activity.hidden = false
      activity.className = `fcuno-spc-dispatcher-activity is-${currentActivity.status || "received"}`
      setText(activity.querySelector("[data-role='activity-badge']"), activityBadge(currentActivity))
      setText(activity.querySelector("[data-role='activity-result']"), activityResult(currentActivity))
      setText(activity.querySelector("[data-role='activity-message']"), currentActivity.messageText)
      setText(activity.querySelector("[data-role='activity-route']"), `To ${currentActivity.groupName}`)
    }
    const history = recentHistory(state.history)
    state.history = history
    setText(root.querySelector("[data-role='history-count']"), String(history.length))
    const historyRoot = root.querySelector("[data-role='history']")
    if (historyRoot) historyRoot.innerHTML = renderHistory(history)
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
    const expected = chatNameKey(groupName)
    return Boolean(expected) && currentChatNames().some((candidate) => chatNameKey(candidate) === expected)
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

  function exactVisibleChatRows(groupName) {
    const pane = document.querySelector("#pane-side") || document.querySelector("#side")
    if (!pane) return []
    const expected = chatNameKey(groupName)
    if (!expected) return []
    // Find the exact visible name first. The first text in a chat row can be an
    // avatar label, unread badge, or accessibility metadata; it is not reliably
    // the chat title. Current WhatsApp also uses focusable gridcells without
    // the older cell-frame-container test id.
    const names = Array.from(pane.querySelectorAll("span[title], div[title], [dir='auto']"))
      .filter(isVisible)
      .filter((element) => !element.closest("[role='search'], [role='textbox'], [contenteditable='true']"))
      .filter((element) => chatNameKey(element.getAttribute("title") || element.textContent) === expected)
    const rows = names.map((element) => (
      element.closest("[data-testid='cell-frame-container']")
      || element.closest("[role='listitem']")
      || element.closest("[role='row']")
      || element.closest("[role='gridcell'][tabindex]")
      || element.closest("div[tabindex='0'], div[tabindex='-1']")
    ))
      .filter((row) => row && row !== pane && pane.contains(row) && isVisible(row))
    return uniqueVisualChatRows(rows)
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

  async function nativeClick(element, sendFence = {}) {
    element.scrollIntoView({ block: "center", inline: "nearest" })
    const rect = element.getBoundingClientRect()
    await runtimeMessage({
      type: "native-click",
      ...sendFence,
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
      const exactRows = exactVisibleChatRows(groupName)
      if (exactRows.length > 1) throw new Error("STOP_REVIEW: More than one exact WhatsApp group match was found.")
      if (exactRows.length !== 1) continue
      await new Promise((resolve) => setTimeout(resolve, 500))
      // Search results can change during the settling delay. Never click a
      // stale DOM node or a result that has become ambiguous.
      const settledRows = exactVisibleChatRows(groupName)
      if (settledRows.length > 1) throw new Error("STOP_REVIEW: More than one exact WhatsApp group match was found.")
      if (settledRows.length !== 1) continue
      await nativeClick(settledRows[0])
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

  function hasOutgoingAcknowledgement(row) {
    const labels = Array.from(row.querySelectorAll("[aria-label]"))
      .map((element) => cleanText(element.getAttribute("aria-label")).toLowerCase())
    return labels.some((label) => /^(?:\d{1,2}:\d{2}(?:\s*[ap]m)?\s+)?(sent|delivered|read|已发送|已傳送|已送达|已送達|已读|已讀)$/.test(label))
      || Boolean(row.querySelector("[data-icon='msg-check'], [data-icon='msg-dblcheck'], [data-icon='msg-dblcheck-ack'], [data-testid='msg-check'], [data-testid='msg-dblcheck'], [data-icon='wds-ic-read'], [aria-label='wds-ic-read'], [alt='wds-ic-read']"))
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
        if (String(identified?.getAttribute("data-id") || "").includes("true_")) return true

        // Current WhatsApp Web no longer exposes message-out/data-id on every
        // outgoing bubble. Its accessible message metadata still identifies
        // the author as the signed-in user and exposes the delivery state.
        const container = row.matches("[data-testid='msg-container']")
          ? row
          : row.closest("[data-testid='msg-container']")
        if (!container) return false
        const labels = Array.from(container.querySelectorAll("[aria-label]"))
          .map((element) => cleanText(element.getAttribute("aria-label")).toLowerCase())
          .filter(Boolean)
        const authoredByCurrentUser = labels.some((label) => /^(you|you:|你|你:|您|您:)$/.test(label))
        const hasOutgoingState = hasOutgoingAcknowledgement(container) || labels.some((label) => label === "pending")
        return authoredByCurrentUser && hasOutgoingState
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
    const rows = matchingOutgoingMessageRows(message)
    return rows.some((row) => {
      // A pending bubble only proves that WhatsApp queued a local message.
      // Require its sent/read acknowledgement before recording success.
      if (!hasOutgoingAcknowledgement(row)) return false
      const identity = outgoingMessageIdentity(row)
      if (identity) return !before.identities.has(identity)
      // React can replace a historical bubble with a new DOM element. Without
      // a stable message id, replacement alone is not evidence of a new send.
      return rows.length > before.rows.size && !before.rows.has(row)
    })
  }

  async function waitForOutgoingMessage(message, groupName, beforeSnapshot, delays) {
    for (const delay of delays) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      if (!exactChatIsOpen(groupName)) throw new Error("SEND_UNCERTAIN: WhatsApp changed chats while confirming the send.")
      if (hasNewOutgoingMessage(message, beforeSnapshot)) return true
    }
    return false
  }

  async function sendAndVerify(message, groupName, sendFence) {
    const composer = findComposer()
    if (!composer) throw new Error("WhatsApp message box is unavailable.")
    if (composerText(composer)) throw new Error("STOP_REVIEW: WhatsApp already has an unsent draft in this group.")
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

    try {
      const prepared = await runtimeMessage({ type: "dispatcher-prepare", ...sendFence })
      if (!(Date.parse(prepared.job?.leaseExpiresAt || "") > Date.now())) {
        throw new Error("The prepared delivery permission expired.")
      }
    } catch (error) {
      throw new Error(`SEND_UNCERTAIN: SPC could not confirm permission to submit this enquiry: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!exactChatIsOpen(groupName) || comparable(composerText(findComposer())) !== comparable(message)) {
      throw new Error("SEND_UNCERTAIN: WhatsApp changed the prepared chat or enquiry text.")
    }
    const preparedComposer = findComposer()
    preparedComposer.focus()
    sendButton = findSendButton(preparedComposer)
    try {
      // Exactly one submit action per prepared job. A slow acknowledgement or
      // retained composer must never trigger a second press of Send/Enter.
      if (sendButton) await nativeClick(sendButton, sendFence)
      else await runtimeMessage({ type: "native-enter", ...sendFence })
    } catch (error) {
      throw new Error(`SEND_UNCERTAIN: WhatsApp send input was interrupted: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (await waitForOutgoingMessage(message, groupName, beforeSnapshot, [500, 900, 1400, 2200, 3500])) return true
    throw new Error("SEND_UNCERTAIN: WhatsApp did not confirm a new outgoing message.")
  }

  async function processQueue() {
    if (!state.paired || state.busy) return
    state.busy = true
    let claim = null
    let sendConfirmed = false
    try {
      claim = await runtimeMessage({ type: "dispatcher-claim" })
      if (state.errorType === "connection") {
        state.error = ""
        state.errorType = ""
      }
      if (!claim.job) {
        if (state.phase === "connecting") {
          state.phase = "ready"
          state.status = "Ready for enquiries"
          render()
        }
        return
      }
      state.error = ""
      state.errorType = ""
      state.phase = "working"
      state.status = sendingStatus(claim.job)
      state.activity = { ...claim.job, status: "sending" }
      render()
      await openExactGroup(claim.job.groupName)
      if (claim.job.attemptCount > 1 && outgoingMessageCount(claim.job.messageText) > 0) {
        throw new Error("STOP_REVIEW: A matching outgoing enquiry already exists; verify delivery before retrying.")
      }
      await sendAndVerify(claim.job.messageText, claim.job.groupName, {
        jobId: claim.job.id,
        claimToken: claim.claimToken,
      })
      sendConfirmed = true
      const completion = await runtimeMessage({
        type: "dispatcher-complete",
        jobId: claim.job.id,
        claimToken: claim.claimToken,
        result: "sent",
      })
      if (completion.job?.status !== "sent") {
        throw new Error(completion.job?.lastError || "SPC retained this delivery for review.")
      }
      state.phase = "sent"
      state.status = "Enquiry sent"
      recordSentActivity(claim.job)
    } catch (error) {
      const originalMessage = error instanceof Error ? error.message : String(error)
      const message = sendConfirmed
        ? `SEND_UNCERTAIN: WhatsApp showed the outgoing enquiry, but SPC did not confirm its delivery record: ${originalMessage}`
        : originalMessage
      const requiresReview = /^(SEND_UNCERTAIN|STOP_REVIEW):/.test(message)
      const queueConnectionFailure = !claim?.job && !requiresReview
      state.phase = queueConnectionFailure ? "connecting" : "error"
      state.errorType = queueConnectionFailure ? "connection" : requiresReview ? "review" : "delivery"
      state.error = queueConnectionFailure
        ? "Connection interrupted"
        : requiresReview
          ? message.replace(/^(SEND_UNCERTAIN|STOP_REVIEW):\s*/, "Manual review required: ")
          : message
      if (claim?.job) {
        state.activity = { ...claim.job, status: requiresReview ? "manual_review" : "failed" }
      }
      if (claim?.job && claim?.claimToken) {
        const completion = await runtimeMessage({
          type: "dispatcher-complete",
          jobId: claim.job.id,
          claimToken: claim.claimToken,
          result: requiresReview ? "manual_review" : "failed",
          error: message,
        }).catch(() => null)
        if (completion?.job?.status === "manual_review") {
          state.errorType = "review"
          state.activity = { ...claim.job, ...completion.job, status: "manual_review" }
          if (completion.job.lastError) {
            state.error = completion.job.lastError.replace(/^(SEND_UNCERTAIN|STOP_REVIEW):\s*/, "Manual review required: ")
          }
        }
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
    state.errorType = ""
    state.phase = "connecting"
    state.status = "Connecting redelivery"
    render()
    try {
      const saved = await runtimeMessage({ type: "dispatcher-state" })
      state.collapsed = Boolean(saved.collapsed)
      if (saved.paused) await runtimeMessage({ type: "dispatcher-set-paused", paused: false })
      if (!saved.token) {
        await runtimeMessage({ type: "dispatcher-pair", deviceLabel: "SPC Trading Desktop" })
      }
      state.paired = true
      const [latest, history] = await Promise.all([
        runtimeMessage({ type: "dispatcher-latest" }),
        runtimeMessage({ type: "dispatcher-history" }).catch(() => ({ jobs: [] })),
      ])
      state.history = recentHistory(history.jobs)
      if (latest.job) {
        state.activity = latest.job
        if (latest.job.status === "manual_review" || latest.job.status === "failed") {
          state.phase = "error"
          state.errorType = latest.job.status === "manual_review" ? "review" : "delivery"
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
      state.errorType = "setup"
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
