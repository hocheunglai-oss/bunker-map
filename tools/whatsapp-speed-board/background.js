const BRENT_API_URL = "https://fcuno.com/api/market/brent"
const CRUDE_CACHE_TTL_MS = 30000
const MAX_CRUDE_AGE_MS = 60 * 60 * 1000
const NETWORK_TIMEOUT_MS = 8000
const STORAGE_KEY = "fcuno-wa-speed-board-v1"
const ENQUIRY_STORAGE_KEY = "fcuno-wa-speed-board-enquiries-v1"
const MAX_ENQUIRIES = 120

let crudeCache = { at: 0, payload: null }
const debuggerQueues = new Map()
let enquiryQueue = Promise.resolve()

function uid() {
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `fcuno-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function cleanMessage(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
}

function readEnquiryState() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEY, ENQUIRY_STORAGE_KEY], (items) => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message || String(error)))
        return
      }
      const board = items?.[STORAGE_KEY] && typeof items[STORAGE_KEY] === "object" ? items[STORAGE_KEY] : {}
      const queue = items?.[ENQUIRY_STORAGE_KEY] && typeof items[ENQUIRY_STORAGE_KEY] === "object"
        ? items[ENQUIRY_STORAGE_KEY]
        : {}
      resolve({ board, queue })
    })
  })
}

function writeEnquiryQueue(queue) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [ENQUIRY_STORAGE_KEY]: queue }, () => {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message || String(error)))
      else resolve()
    })
  })
}

function notifyNewEnquiries(count) {
  const total = Math.max(Number(count || 0), 1)
  if (!chrome.notifications?.create) return
  chrome.notifications.create(`fcuno-enquiries-${Date.now()}`, {
    type: "basic",
    iconUrl: "fc-uno-sidebar-logo.png",
    title: "New FCUNO enquiry",
    message: total === 1 ? "1 new enquiry is ready to send." : `${total} new enquiries are ready to send.`,
  })
}

async function enqueueFcunoEnquiry(text, buyer) {
  const message = cleanMessage(text)
  if (!message) throw new Error("Shortened enquiry is empty.")

  const { board, queue } = await readEnquiryState()
  const id = uid()
  const createdAt = new Date().toISOString()
  const buyerName = cleanText(buyer)
  const enquiries = Array.isArray(queue.enquiries)
    ? queue.enquiries
    : Array.isArray(board.enquiries)
      ? board.enquiries
      : []

  await writeEnquiryQueue({
    enquiries: [
      {
        id,
        body: message,
        title: message.split("\n").find(Boolean) || "ENQUIRY",
        createdAt,
        buyer: buyerName,
        createdByDisplayName: buyerName,
        source: "enquiryworksheet",
      },
      ...enquiries,
    ].slice(0, MAX_ENQUIRIES),
  })
  notifyNewEnquiries(1)
  return { id, createdAt }
}

async function fetchWithTimeout(url, options = {}) {
  if (typeof AbortController === "undefined") return fetch(url, options)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function enqueueDebuggerAction(tabId, action) {
  const previous = debuggerQueues.get(tabId) || Promise.resolve()
  const current = previous.catch(() => {}).then(action)
  debuggerQueues.set(tabId, current)
  const cleanup = () => {
    if (debuggerQueues.get(tabId) === current) debuggerQueues.delete(tabId)
  }
  current.then(cleanup, cleanup)
  return current
}

function chromeCall(invoke) {
  return new Promise((resolve, reject) => {
    invoke((result) => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message || String(error)))
        return
      }
      resolve(result)
    })
  })
}

async function nativeClick(tabId, x, y) {
  const target = { tabId }
  let attached = false
  try {
    await chromeCall((callback) => chrome.debugger.attach(target, "1.3", callback))
    attached = true
    await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
    }, callback))
    await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    }, callback))
    await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    }, callback))
  } finally {
    if (attached) {
      await chromeCall((callback) => chrome.debugger.detach(target, callback)).catch(() => {})
    }
  }
}

async function withDebugger(tabId, action) {
  const target = { tabId }
  let attached = false
  try {
    await chromeCall((callback) => chrome.debugger.attach(target, "1.3", callback))
    attached = true
    await action(target)
  } finally {
    if (attached) {
      await chromeCall((callback) => chrome.debugger.detach(target, callback)).catch(() => {})
    }
  }
}

async function nativeEnter(tabId) {
  await withDebugger(tabId, async (target) => {
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

async function nativeInsertText(tabId, text) {
  await withDebugger(tabId, async (target) => {
    await chromeCall((callback) => chrome.debugger.sendCommand(target, "Input.insertText", {
      text: String(text || ""),
    }, callback))
  })
}

function finiteNumber(value) {
  if (value == null || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function parseCrudePayload(data, now = Date.now()) {
  const crude = data?.crude
  if (!crude || crude.source !== "ICE" || crude.verified !== true) {
    throw new Error("Verified ICE Brent quote unavailable.")
  }

  const price = finiteNumber(crude.price)
  const change = finiteNumber(crude.change)
  const changePercent = finiteNumber(crude.changePercent)
  const updatedAt = Date.parse(String(crude.updatedAt || ""))
  const points = Array.isArray(crude.points)
    ? crude.points.map(finiteNumber).filter((value) => value != null)
    : []

  if (
    price == null ||
    change == null ||
    changePercent == null ||
    price < 20 ||
    price > 250 ||
    points.length < 2 ||
    !Number.isFinite(updatedAt) ||
    now - updatedAt > MAX_CRUDE_AGE_MS ||
    updatedAt - now > 5 * 60 * 1000 ||
    !/^[A-Z][a-z]{2}\d{2}$/.test(String(crude.contract || ""))
  ) {
    throw new Error("Verified ICE Brent quote failed validation.")
  }

  return {
    ...crude,
    price,
    change,
    changePercent,
    points,
  }
}

async function fetchCrudeWatch() {
  const now = Date.now()
  if (crudeCache.payload && now - crudeCache.at < CRUDE_CACHE_TTL_MS) return crudeCache.payload

  const response = await fetchWithTimeout(BRENT_API_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.message || `Crude quote failed: ${response.status}`)

  const payload = parseCrudePayload(data)
  crudeCache = { at: now, payload }
  return payload
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false

  if (message.type === "enqueue-fcuno-enquiry") {
    const task = enquiryQueue
      .catch(() => {})
      .then(() => enqueueFcunoEnquiry(message.text, message.buyer))
    enquiryQueue = task.catch(() => {})
    task
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "Could not enqueue FCUNO enquiry.",
      }))
    return true
  }

  if (message.type === "notify-new-enquiries") {
    notifyNewEnquiries(message.count)
    return false
  }

  if (message.type === "fcuno-native-click") {
    const tabId = _sender.tab && _sender.tab.id
    const x = Number(message.x)
    const y = Number(message.y)
    if (!tabId || !Number.isFinite(x) || !Number.isFinite(y)) {
      sendResponse({ ok: false, message: "Missing tab or click coordinates." })
      return false
    }

    enqueueDebuggerAction(tabId, () => nativeClick(tabId, x, y))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : "Native click failed.",
        })
      })

    return true
  }

  if (message.type === "fcuno-native-enter") {
    const tabId = _sender.tab && _sender.tab.id
    if (!tabId) {
      sendResponse({ ok: false, message: "Missing tab." })
      return false
    }

    enqueueDebuggerAction(tabId, () => nativeEnter(tabId))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : "Native enter failed.",
        })
      })

    return true
  }

  if (message.type === "fcuno-native-insert-text") {
    const tabId = _sender.tab && _sender.tab.id
    const text = String(message.text || "")
    if (!tabId || !text) {
      sendResponse({ ok: false, message: "Missing tab or text." })
      return false
    }

    enqueueDebuggerAction(tabId, () => nativeInsertText(tabId, text))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : "Native text insert failed.",
        })
      })

    return true
  }

  if (message.type === "load-crude-watch") {
    fetchCrudeWatch()
      .then((crude) => sendResponse({ ok: true, crude }))
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : "Unable to load crude quote.",
        })
      })

    return true
  }

  return false
})
