const API_URL = "https://spc.fcuno.com/api/spc/group-dispatcher"
const STORAGE_KEY = "fcunoSpcGroupDispatcherV1"
const UPDATE_PENDING_KEY = "fcunoSpcGroupDispatcherUpdatePendingV1"
const VERSION = chrome.runtime.getManifest().version
const debuggerQueues = new Map()
const submissionPermits = new Map()
let updateReloadPromise = null

function chromeCall(invoke) {
  return new Promise((resolve, reject) => {
    invoke((result) => {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message || String(error)))
      else resolve(result)
    })
  })
}

function reloadOpenWhatsAppTabs() {
  chrome.tabs.query({ url: "https://web.whatsapp.com/*" }, (tabs) => {
    if (chrome.runtime.lastError) return
    for (const tab of tabs || []) {
      if (!Number.isInteger(tab.id)) continue
      chrome.tabs.reload(tab.id, () => void chrome.runtime.lastError)
    }
  })
}

function reloadWhatsAppAfterUpdateOnce() {
  if (!updateReloadPromise) {
    updateReloadPromise = chromeCall((callback) => chrome.storage.local.remove([UPDATE_PENDING_KEY], callback))
      .then(() => {
        reloadOpenWhatsAppTabs()
        return { refreshedWhatsApp: true }
      })
      .catch((error) => {
        updateReloadPromise = null
        throw error
      })
  }
  return updateReloadPromise
}

// The install event and the refreshed SPC updater page can both arrive after
// one extension reload. Share the same operation and consume the persisted
// legacy pending flag so a later page-ready event cannot interrupt a new claim.
chrome.runtime.onInstalled.addListener(() => reloadWhatsAppAfterUpdateOnce().catch(() => {}))

function isTrustedSpcPage(sender) {
  const senderUrl = String(sender?.url || sender?.tab?.url || "")
  return senderUrl === "https://spc.fcuno.com/" || senderUrl.startsWith("https://spc.fcuno.com/")
}

async function prepareInPlaceUpdate(sender) {
  if (!isTrustedSpcPage(sender)) throw new Error("Dispatcher updates are accepted only from spc.fcuno.com.")
  await chromeCall((callback) => chrome.storage.local.set({ [UPDATE_PENDING_KEY]: true }, callback))
  setTimeout(() => chrome.runtime.reload(), 350)
  return { message: "Extension reload scheduled." }
}

async function finishInPlaceUpdate(sender) {
  if (!isTrustedSpcPage(sender)) return {}
  const result = await chromeCall((callback) => chrome.storage.local.get([UPDATE_PENDING_KEY], callback))
  if (!result?.[UPDATE_PENDING_KEY]) return {}
  return reloadWhatsAppAfterUpdateOnce()
}

function enqueueDebuggerAction(tabId, action) {
  const previous = debuggerQueues.get(tabId) || Promise.resolve()
  const current = previous.catch(() => {}).then(action)
  debuggerQueues.set(tabId, current)
  const clearQueue = () => {
    if (debuggerQueues.get(tabId) === current) debuggerQueues.delete(tabId)
  }
  void current.then(clearQueue, clearQueue)
  return current
}

async function withDebugger(tabId, action) {
  const target = { tabId }
  let attached = false
  try {
    await chromeCall((callback) => chrome.debugger.attach(target, "1.3", callback))
    attached = true
    return await action(target)
  } finally {
    if (attached) {
      await chromeCall((callback) => chrome.debugger.detach(target, callback)).catch(() => {})
    }
  }
}

function consumeSubmissionPermit(tabId, fence) {
  const permit = submissionPermits.get(tabId)
  submissionPermits.delete(tabId)
  if (!permit || permit.jobId !== fence.jobId || permit.claimToken !== fence.claimToken
      || performance.now() >= permit.deadline) {
    throw new Error("SEND_UNCERTAIN: Submission permit expired or was already used. Check WhatsApp before sending again.")
  }
}

async function nativeClick(tabId, x, y, sendFence) {
  if (sendFence) return nativeSubmit(tabId, sendFence)
  return withDebugger(tabId, async (target) => {
    await clickWithTarget(target, x, y)
  })
}

async function preparedSubmissionTarget(target, fence) {
  if (!fence.groupName || !fence.expectedMessage) {
    throw new Error("SEND_UNCERTAIN: The prepared chat and enquiry text are required.")
  }
  const evaluation = await chromeCall((callback) => chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const chatKey = (value) => clean(String(value || "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")).normalize("NFC").toLowerCase();
      const textKey = (value) => clean(value).replace(/\\*/g, "").toLowerCase();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const main = document.querySelector("#main") || document.querySelector("[role='main']");
      if (!main) return { verified: false };
      const names = Array.from(main.querySelector("header")?.querySelectorAll("span[title], div[title], [dir='auto']") || [])
        .filter(visible).map(element => chatKey(element.getAttribute("title") || element.textContent));
      if (!names.includes(chatKey(${JSON.stringify(fence.groupName)}))) return { verified: false };
      const composers = Array.from(main.querySelectorAll("[contenteditable='true'][role='textbox'], [contenteditable='true']")).filter(visible);
      const composer = composers[composers.length - 1];
      if (!composer || textKey(composer.innerText || composer.textContent) !== textKey(${JSON.stringify(fence.expectedMessage)})) return { verified: false };
      composer.focus();
      if (document.activeElement !== composer) return { verified: false };
      const composerRect = composer.getBoundingClientRect();
      const controls = [];
      for (const element of main.querySelectorAll("[data-testid='compose-btn-send'], [data-testid='send'], [data-testid='wds-ic-send-filled'], [data-icon='send'], [data-icon='send-filled'], [data-icon='wds-ic-send-filled'], button[aria-label='Send'], [role='button'][aria-label='Send']")) {
        const control = element.closest("button, [role='button']") || element;
        const rect = control.getBoundingClientRect();
        const aligned = rect.bottom >= composerRect.top - 20 && rect.top <= composerRect.bottom + 40 && rect.left >= composerRect.right - 180;
        if (aligned && !control.hasAttribute("disabled") && control.getAttribute("aria-disabled") !== "true" && visible(control) && !controls.includes(control)) controls.push(control);
      }
      if (controls.length === 1) {
        const rect = controls[0].getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === controls[0] || controls[0].contains(hit))) return { verified: true, method: "click", x, y };
      }
      return { verified: true, method: "enter" };
    })()`,
    returnByValue: true,
  }, callback))
  const value = evaluation?.result?.value
  if (!value?.verified || !["click", "enter"].includes(value.method)) {
    throw new Error("SEND_UNCERTAIN: WhatsApp changed the prepared chat, message, or composer focus.")
  }
  return value
}

async function nativeSubmit(tabId, sendFence) {
  return withDebugger(tabId, async (target) => {
    // Attaching the debugger can move the whole page when Chrome displays its
    // banner. Resolve the real target now; content-script coordinates are stale.
    const submission = await preparedSubmissionTarget(target, sendFence)
    if (submission.method === "click") {
      await clickWithTarget(target, submission.x, submission.y, () => consumeSubmissionPermit(tabId, sendFence))
    } else {
      consumeSubmissionPermit(tabId, sendFence)
      await enterWithTarget(target)
    }
  })
}

async function clickWithTarget(target, x, y, beforePress) {
  for (const event of [
    { type: "mouseMoved", button: "none", buttons: 0 },
    { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 },
    { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 },
  ]) {
    if (event.type === "mousePressed") beforePress?.()
    await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      ...event,
      x,
      y,
    }, callback))
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function comparable(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\*/g, "").trim().toLowerCase()
}

async function replaceTextWithTarget(target, text) {
  await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      modifiers: 2,
      commands: ["SelectAll"],
    }, callback))
  await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: 2,
    }, callback))
  await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    }, callback))
  await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    }, callback))
  if (text) {
    await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.insertText", {
        text: String(text),
      }, callback))
  }
}

async function nativeReplaceText(tabId, text) {
  return withDebugger(tabId, (target) => replaceTextWithTarget(target, text))
}

async function nativeInsertText(tabId, text) {
  return withDebugger(tabId, (target) =>
    chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.insertText", {
      text: String(text || ""),
    }, callback)),
  )
}

async function enterWithTarget(target) {
  await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      unmodifiedText: "\r",
      text: "\r",
  }, callback))
  await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
  }, callback))
}

async function nativeEnter(tabId, sendFence) {
  return nativeSubmit(tabId, sendFence)
}

async function focusVisibleComposer(target) {
  const evaluation = await chromeCall((callback) => chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
      }
      const candidates = Array.from(document.querySelectorAll(
        "[data-testid='conversation-compose-box-input'], [contenteditable='true'][role='textbox'], [contenteditable='true']",
      ))
        .filter((element) => visible(element) && !element.closest("#fcuno-spc-dispatcher-root"))
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > window.innerHeight * 0.55)
        .sort((left, right) => right.rect.bottom - left.rect.bottom)
      const active = document.activeElement
      const composer = candidates.find(({ element }) => element === active)?.element || candidates[0]?.element
      if (!composer) return { found: false, focused: false, text: "" }
      composer.focus()
      const selection = window.getSelection()
      if (selection) {
        const range = document.createRange()
        range.selectNodeContents(composer)
        range.collapse(false)
        selection.removeAllRanges()
        selection.addRange(range)
      }
      return {
        found: true,
        focused: document.activeElement === composer,
        text: String(composer.innerText || composer.textContent || ""),
      }
    })()`,
    returnByValue: true,
  }, callback))
  const value = evaluation?.result?.value || {}
  return {
    found: Boolean(value.found),
    focused: Boolean(value.focused),
    text: String(value.text || ""),
  }
}

async function readActiveComposer(target) {
  const evaluation = await chromeCall((callback) => chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
      }
      const candidates = Array.from(document.querySelectorAll(
        "[data-testid='conversation-compose-box-input'], [contenteditable='true'][role='textbox'], [contenteditable='true']",
      ))
        .filter((element) => visible(element) && !element.closest("#fcuno-spc-dispatcher-root"))
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > window.innerHeight * 0.55)
        .sort((left, right) => right.rect.bottom - left.rect.bottom)
      const active = document.activeElement
      const composer = candidates.find(({ element }) => element === active)?.element || candidates[0]?.element
      return String(composer?.innerText || composer?.textContent || "")
    })()`,
    returnByValue: true,
  }, callback))
  return String(evaluation?.result?.value || "")
}

async function findVisibleSendButton(target) {
  const evaluation = await chromeCall((callback) => chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
      }
      const controls = []
      const add = (element) => {
        const control = element?.closest?.("button, [role='button']") || element
        if (control && !control.hasAttribute("disabled") && visible(control) && !controls.includes(control)) controls.push(control)
      }
      for (const element of document.querySelectorAll(
        "[data-testid='compose-btn-send'], [data-testid='send'], [data-testid='wds-ic-send-filled'], [data-icon='send'], [data-icon='send-filled'], [data-icon='wds-ic-send-filled']",
      )) add(element)
      for (const element of document.querySelectorAll("button[aria-label='Send'], [role='button'][aria-label='Send']")) add(element)
      if (controls.length !== 1) return { count: controls.length }
      const rect = controls[0].getBoundingClientRect()
      return { count: 1, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`,
    returnByValue: true,
  }, callback))
  const value = evaluation?.result?.value || {}
  return {
    count: Number(value.count || 0),
    x: Number(value.x || 0),
    y: Number(value.y || 0),
  }
}

async function nativeSendText(tabId, text) {
  const expected = comparable(text)
  if (!expected) throw new Error("The enquiry text is empty.")
  return withDebugger(tabId, async (target) => {
    const composer = await focusVisibleComposer(target)
    if (!composer.found || !composer.focused) {
      return { accepted: false, submitted: false }
    }
    await replaceTextWithTarget(target, "")
    await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.insertText", {
      text: String(text),
    }, callback))

    let sendButton = { count: 0, x: 0, y: 0 }
    let stagedText = ""
    for (const wait of [250, 500, 900, 1400]) {
      await delay(wait)
      ;[sendButton, stagedText] = await Promise.all([
        findVisibleSendButton(target),
        readActiveComposer(target),
      ])
      if (comparable(stagedText) === expected && sendButton.count === 1) break
    }
    if (comparable(stagedText) !== expected) {
      return { accepted: false, submitted: false }
    }

    if (sendButton.count === 1) {
      await clickWithTarget(target, sendButton.x, sendButton.y)
    } else {
      await enterWithTarget(target)
    }
    for (const wait of [350, 650, 1000, 1600]) {
      await delay(wait)
      const [composer, remainingButton] = await Promise.all([
        readActiveComposer(target),
        findVisibleSendButton(target),
      ])
      if (!comparable(composer) || remainingButton.count === 0) {
        return { accepted: true, submitted: true }
      }
    }
    return { accepted: true, submitted: false }
  })
}

async function readState() {
  const result = await chromeCall((callback) => chrome.storage.local.get([STORAGE_KEY], callback))
  return result?.[STORAGE_KEY] || {}
}

async function writeState(patch) {
  const current = await readState()
  const next = { ...current, ...patch }
  await chromeCall((callback) => chrome.storage.local.set({ [STORAGE_KEY]: next }, callback))
  return next
}

async function apiRequest(body, token = "") {
  const response = await fetch(API_URL, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ ...body, extensionVersion: VERSION }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.message || `SPC dispatcher request failed (${response.status}).`)
  return data
}

async function handleApiMessage(message, sender) {
  const state = await readState()
  if (message.type === "dispatcher-state") return state
  if (message.type === "dispatcher-pair") {
    const data = await apiRequest({
      action: "pair",
      dispatcherId: state.dispatcherId || message.dispatcherId,
      deviceLabel: message.deviceLabel,
    })
    await writeState({
      dispatcherId: data.dispatcherId,
      token: data.token,
      groupName: "",
      deviceLabel: data.deviceLabel,
      paused: false,
    })
    return data
  }
  if (!state.token) throw new Error("This dispatcher is not paired.")
  if (message.type === "dispatcher-heartbeat") {
    return apiRequest({ action: "heartbeat" }, state.token)
  }
  if (message.type === "dispatcher-claim") {
    return apiRequest({ action: "claim" }, state.token)
  }
  if (message.type === "dispatcher-prepare") {
    const tabId = sender?.tab?.id
    if (!Number.isInteger(tabId)) throw new Error("A WhatsApp tab is required to prepare a submission.")
    submissionPermits.delete(tabId)
    const startedAt = performance.now()
    const data = await apiRequest({
      action: "prepare_send",
      jobId: message.jobId,
      claimToken: message.claimToken,
    }, state.token)
    // Start the monotonic deadline before the request so network latency is
    // deducted and a slow local clock cannot extend the database lease.
    const remaining = Math.min(90000, Date.parse(data.job?.leaseExpiresAt) - Date.parse(data.job?.serverNow))
    if (!Number.isFinite(remaining) || remaining <= 0 || performance.now() >= startedAt + remaining) {
      throw new Error("SEND_UNCERTAIN: Submission permit expired before WhatsApp could send.")
    }
    submissionPermits.set(tabId, {
      jobId: message.jobId,
      claimToken: message.claimToken,
      deadline: startedAt + remaining,
    })
    return data
  }
  if (message.type === "dispatcher-latest") {
    return apiRequest({ action: "latest" }, state.token)
  }
  if (message.type === "dispatcher-history") {
    return apiRequest({ action: "history" }, state.token)
  }
  if (message.type === "dispatcher-complete") {
    return apiRequest({
      action: "complete",
      jobId: message.jobId,
      claimToken: message.claimToken,
      result: message.result,
      error: message.error || "",
    }, state.token)
  }
  if (message.type === "dispatcher-set-paused") return writeState({ paused: Boolean(message.paused) })
  if (message.type === "dispatcher-set-collapsed") return writeState({ collapsed: Boolean(message.collapsed) })
  throw new Error("Unsupported dispatcher request.")
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id
  const respond = (promise) => {
    Promise.resolve(promise)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : String(error) }))
    return true
  }

  if (message?.type === "extension-apply-update") {
    return respond(prepareInPlaceUpdate(sender))
  }
  if (message?.type === "extension-update-page-ready") {
    return respond(finishInPlaceUpdate(sender))
  }
  if (String(message?.type || "").startsWith("dispatcher-")) {
    return respond(handleApiMessage(message, sender))
  }
  if (!tabId) return false
  if (message?.type === "native-click") {
    const sendFence = message.jobId || message.claimToken ? message : undefined
    return respond(enqueueDebuggerAction(tabId, () => nativeClick(tabId, Number(message.x), Number(message.y), sendFence)))
  }
  if (message?.type === "native-replace-text") {
    return respond(enqueueDebuggerAction(tabId, () => nativeReplaceText(tabId, message.text)))
  }
  if (message?.type === "native-insert-text") {
    return respond(enqueueDebuggerAction(tabId, () => nativeInsertText(tabId, message.text)))
  }
  if (message?.type === "native-enter") {
    return respond(enqueueDebuggerAction(tabId, () => nativeEnter(tabId, message)))
  }
  if (message?.type === "native-send-text") {
    return respond(enqueueDebuggerAction(tabId, () => nativeSendText(tabId, message.text)))
  }
  return false
})
