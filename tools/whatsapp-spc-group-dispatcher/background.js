const API_URL = "https://spc.fcuno.com/api/spc/group-dispatcher"
const STORAGE_KEY = "fcunoSpcGroupDispatcherV1"
const UPDATE_PENDING_KEY = "fcunoSpcGroupDispatcherUpdatePendingV1"
const VERSION = chrome.runtime.getManifest().version
const debuggerQueues = new Map()

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

chrome.runtime.onInstalled.addListener(reloadOpenWhatsAppTabs)

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
  await chromeCall((callback) => chrome.storage.local.remove([UPDATE_PENDING_KEY], callback))
  reloadOpenWhatsAppTabs()
  return { refreshedWhatsApp: true }
}

function enqueueDebuggerAction(tabId, action) {
  const previous = debuggerQueues.get(tabId) || Promise.resolve()
  const current = previous.catch(() => {}).then(action)
  debuggerQueues.set(tabId, current)
  current.finally(() => {
    if (debuggerQueues.get(tabId) === current) debuggerQueues.delete(tabId)
  })
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

async function nativeClick(tabId, x, y) {
  return withDebugger(tabId, async (target) => {
    for (const event of [
      { type: "mouseMoved", button: "none", buttons: 0 },
      { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 },
    ]) {
      await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        ...event,
        x,
        y,
      }, callback))
    }
  })
}

async function nativeReplaceText(tabId, text) {
  return withDebugger(tabId, async (target) => {
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
  })
}

async function nativeInsertText(tabId, text) {
  return withDebugger(tabId, (target) =>
    chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.insertText", {
      text: String(text || ""),
    }, callback)),
  )
}

async function nativeEnter(tabId) {
  return withDebugger(tabId, async (target) => {
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

async function handleApiMessage(message) {
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
    return respond(handleApiMessage(message))
  }
  if (!tabId) return false
  if (message?.type === "native-click") {
    return respond(enqueueDebuggerAction(tabId, () => nativeClick(tabId, Number(message.x), Number(message.y))))
  }
  if (message?.type === "native-replace-text") {
    return respond(enqueueDebuggerAction(tabId, () => nativeReplaceText(tabId, message.text)))
  }
  if (message?.type === "native-insert-text") {
    return respond(enqueueDebuggerAction(tabId, () => nativeInsertText(tabId, message.text)))
  }
  if (message?.type === "native-enter") {
    return respond(enqueueDebuggerAction(tabId, () => nativeEnter(tabId)))
  }
  return false
})
