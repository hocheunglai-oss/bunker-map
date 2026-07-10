const SPC_ENQUIRIES_URL = "https://spc.fcuno.com/api/spc/enquiries?limit=160"
const BRENT_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/BZ%3DF?range=5d&interval=15m"
const CRUDE_CACHE_TTL_MS = 15000
const SPC_ENQUIRY_LIMIT = 160

let crudeCache = { at: 0, payload: null }
let enquiryCache = { payload: null, cursor: "" }
let enquiryPromise = null

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

function parseCrudeChart(data) {
  const result = data?.chart?.result?.[0]
  if (!result) throw new Error("Crude quote unavailable.")

  const meta = result.meta || {}
  const closes = Array.isArray(result.indicators?.quote?.[0]?.close)
    ? result.indicators.quote[0].close.map(finiteNumber).filter((value) => value != null)
    : []
  const price =
    finiteNumber(meta.regularMarketPrice) ||
    closes.slice().reverse().find((value) => value != null) ||
    null
  const previousClose =
    finiteNumber(meta.previousClose) ||
    finiteNumber(meta.chartPreviousClose) ||
    closes.find((value) => value != null) ||
    null

  if (price == null || previousClose == null) throw new Error("Crude quote unavailable.")

  const change = price - previousClose
  const changePercent = previousClose ? (change / previousClose) * 100 : 0
  const points = closes.slice(-48)

  return {
    symbol: "Brent",
    price,
    change,
    changePercent,
    points,
    updatedAt: new Date().toISOString(),
  }
}

async function fetchCrudeWatch() {
  const now = Date.now()
  if (crudeCache.payload && now - crudeCache.at < CRUDE_CACHE_TTL_MS) return crudeCache.payload

  const response = await fetch(BRENT_CHART_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.chart?.error?.description || `Crude quote failed: ${response.status}`)

  const payload = parseCrudeChart(data)
  crudeCache = { at: now, payload }
  return payload
}

function mergeSpcEnquiries(current, changes, limit = SPC_ENQUIRY_LIMIT) {
  const byId = new Map()
  ;[...(current || []), ...(changes || [])].forEach((enquiry) => {
    const id = String(enquiry?.id || "")
    if (id) byId.set(id, enquiry)
  })

  return Array.from(byId.values())
    .sort((first, second) => {
      const dateOrder = String(second.createdAt || "").localeCompare(String(first.createdAt || ""))
      return dateOrder || String(first.id || "").localeCompare(String(second.id || ""))
    })
    .slice(0, limit)
}

function latestEnquiryCursor(enquiries, fallback = "") {
  return (enquiries || []).reduce(
    (latest, enquiry) => !latest || Date.parse(enquiry?.updatedAt || "") > Date.parse(latest)
      ? String(enquiry.updatedAt)
      : latest,
    fallback,
  )
}

async function fetchSpcEnquiries() {
  if (enquiryPromise) return enquiryPromise

  const incremental = Array.isArray(enquiryCache.payload) && Boolean(enquiryCache.cursor)
  const url = incremental
    ? `${SPC_ENQUIRIES_URL}&updatedAfter=${encodeURIComponent(enquiryCache.cursor)}`
    : SPC_ENQUIRIES_URL

  enquiryPromise = fetch(url, {
    cache: "no-store",
    credentials: "include",
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.message || `SPC enquiries failed: ${response.status}`)
      }

      const changes = Array.isArray(data.enquiries) ? data.enquiries : []
      const payload = incremental
        ? mergeSpcEnquiries(enquiryCache.payload, changes)
        : mergeSpcEnquiries([], changes)
      const cursor = String(data.cursor || latestEnquiryCursor(changes, enquiryCache.cursor))
      enquiryCache = { payload, cursor }
      return payload
    })
    .finally(() => {
      enquiryPromise = null
    })

  return enquiryPromise
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false

  if (message.type === "notify-new-enquiries") {
    const count = Math.max(Number(message.count || 0), 1)
    if (chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create(`spc-enquiries-${Date.now()}`, {
        type: "basic",
        iconUrl: "spc-sidebar-logo.png",
        title: "New SPC enquiry",
        message: count === 1 ? "1 new enquiry is ready to send." : `${count} new enquiries are ready to send.`,
      })
    }
    return false
  }

  if (message.type === "spc-native-click") {
    const tabId = _sender.tab && _sender.tab.id
    const x = Number(message.x)
    const y = Number(message.y)
    if (!tabId || !Number.isFinite(x) || !Number.isFinite(y)) {
      sendResponse({ ok: false, message: "Missing tab or click coordinates." })
      return false
    }

    nativeClick(tabId, x, y)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : "Native click failed.",
        })
      })

    return true
  }

  if (message.type === "spc-native-enter") {
    const tabId = _sender.tab && _sender.tab.id
    if (!tabId) {
      sendResponse({ ok: false, message: "Missing tab." })
      return false
    }

    nativeEnter(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : "Native enter failed.",
        })
      })

    return true
  }

  if (message.type === "spc-native-insert-text") {
    const tabId = _sender.tab && _sender.tab.id
    const text = String(message.text || "")
    if (!tabId || !text) {
      sendResponse({ ok: false, message: "Missing tab or text." })
      return false
    }

    nativeInsertText(tabId, text)
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

  if (message.type !== "load-spc-enquiries") return false

  fetchSpcEnquiries()
    .then((enquiries) => sendResponse({ ok: true, enquiries }))
    .catch((error) => {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "Unable to load SPC enquiries.",
      })
    })

  return true
})
