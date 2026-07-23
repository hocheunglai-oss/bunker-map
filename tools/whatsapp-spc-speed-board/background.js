const SPC_ENQUIRIES_URL = "https://spc.fcuno.com/api/spc/enquiries?limit=160"
const SPC_ENQUIRY_CHAT_CONTACTS_URL = "https://spc.fcuno.com/api/spc/enquiry-chat-contacts"
const BRENT_API_URL = "https://spc.fcuno.com/api/market/brent"
const CRUDE_CACHE_TTL_MS = 30000
const MAX_CRUDE_AGE_MS = 60 * 60 * 1000
const SPC_ENQUIRY_LIMIT = 160
const NETWORK_TIMEOUT_MS = 8000

let crudeCache = { at: 0, payload: null }
let enquiryCache = { payload: null, cursor: "", sessionKey: "" }
let enquiryPromise = null
let senderContactCache = { sessionKey: "", byUsername: new Map() }
let senderContactPromise = null
const debuggerQueues = new Map()

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

function mergeSpcEnquiries(current, changes, limit = SPC_ENQUIRY_LIMIT, activeIds) {
  const byId = new Map()
  ;[...(current || []), ...(changes || [])].forEach((enquiry) => {
    const id = String(enquiry?.id || "")
    if (id) byId.set(id, enquiry)
  })

  const activeIdSet = Array.isArray(activeIds)
    ? new Set(activeIds.map((id) => String(id || "")).filter(Boolean))
    : null

  return Array.from(byId.values())
    .filter((enquiry) => !activeIdSet || activeIdSet.has(String(enquiry.id || "")))
    .sort((first, second) => {
      const dateOrder = String(second.createdAt || "").localeCompare(String(first.createdAt || ""))
      return dateOrder || String(first.id || "").localeCompare(String(second.id || ""))
    })
    .slice(0, limit)
}

function latestEnquiryCursor(enquiries, fallback = "") {
  return (enquiries || []).reduce((latest, enquiry) => {
    const updatedAt = String(enquiry?.updatedAt || "")
    const id = String(enquiry?.id || "")
    if (!updatedAt || !id) return latest
    const candidate = `${updatedAt}|${id}`
    if (!latest) return candidate
    const [latestDate, latestId = ""] = String(latest).split("|")
    const dateOrder = Date.parse(updatedAt) - Date.parse(latestDate)
    return dateOrder > 0 || (dateOrder === 0 && id.localeCompare(latestId) > 0)
      ? candidate
      : latest
  }, fallback)
}

async function fetchSpcEnquiries() {
  if (enquiryPromise) return enquiryPromise

  enquiryPromise = (async () => {
    let incremental = Array.isArray(enquiryCache.payload) && Boolean(enquiryCache.cursor)
    let url = incremental
      ? `${SPC_ENQUIRIES_URL}&updatedAfter=${encodeURIComponent(enquiryCache.cursor)}`
      : SPC_ENQUIRIES_URL

    const requestEnquiries = async (requestUrl) => {
      const response = await fetchWithTimeout(requestUrl, {
        cache: "no-store",
        credentials: "include",
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          enquiryCache = { payload: null, cursor: "", sessionKey: "" }
        }
        throw new Error(data.message || `SPC enquiries failed: ${response.status}`)
      }
      return data
    }

    let data = await requestEnquiries(url)
    let sessionKey = String(data.sessionKey || "")
    if (incremental && enquiryCache.sessionKey && sessionKey && enquiryCache.sessionKey !== sessionKey) {
      enquiryCache = { payload: null, cursor: "", sessionKey: "" }
      senderContactCache = { sessionKey: "", byUsername: new Map() }
      incremental = false
      url = SPC_ENQUIRIES_URL
      data = await requestEnquiries(url)
      sessionKey = String(data.sessionKey || "")
    }

    const changes = Array.isArray(data.enquiries) ? data.enquiries : []
    const payload = incremental
      ? mergeSpcEnquiries(enquiryCache.payload, changes, SPC_ENQUIRY_LIMIT, data.activeIds)
      : mergeSpcEnquiries([], changes)
    const cursor = String(data.cursor || latestEnquiryCursor(changes, enquiryCache.cursor))
    enquiryCache = { payload, cursor, sessionKey }
    return payload
  })().finally(() => {
    enquiryPromise = null
  })

  return enquiryPromise
}

function enquirySenderUsernames(enquiries) {
  return Array.from(new Set((enquiries || [])
    .map((enquiry) => String(enquiry?.createdByUsername || enquiry?.created_by_username || "").trim().toLowerCase())
    .filter(Boolean)))
}

async function fetchSpcEnquiryChatContacts(usernames, sessionKey = enquiryCache.sessionKey) {
  const requested = Array.from(new Set((usernames || []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)))
  if (requested.length === 0) return {}

  if (senderContactCache.sessionKey !== sessionKey) {
    senderContactCache = { sessionKey, byUsername: new Map() }
    senderContactPromise = null
  }

  const missing = requested.filter((username) => !senderContactCache.byUsername.has(username))
  if (missing.length && !senderContactPromise) {
    senderContactPromise = (async () => {
      for (let index = 0; index < missing.length; index += 40) {
        const usernameChunk = missing.slice(index, index + 40)
        const query = usernameChunk.map((username) => `username=${encodeURIComponent(username)}`).join("&")
        const response = await fetchWithTimeout(`${SPC_ENQUIRY_CHAT_CONTACTS_URL}?${query}`, {
          cache: "no-store",
          credentials: "include",
          headers: { Accept: "application/json" },
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            senderContactCache = { sessionKey: "", byUsername: new Map() }
          }
          throw new Error(data.message || `SPC chat contacts failed: ${response.status}`)
        }

        usernameChunk.forEach((username) => senderContactCache.byUsername.set(username, null))
        ;(Array.isArray(data.contacts) ? data.contacts : []).forEach((contact) => {
          const username = String(contact?.username || "").trim().toLowerCase()
          const phone = String(contact?.phone || "").replace(/\D/g, "")
          if (!username || phone.length < 8 || phone.length > 15) return
          senderContactCache.byUsername.set(username, {
            username,
            displayName: String(contact?.displayName || username).trim(),
            phone,
            phonebookContactId: String(contact?.phonebookContactId || ""),
          })
        })
      }
    })().finally(() => {
      senderContactPromise = null
    })
  }

  if (senderContactPromise) await senderContactPromise
  return Object.fromEntries(requested.flatMap((username) => {
    const contact = senderContactCache.byUsername.get(username)
    return contact ? [[username, contact]] : []
  }))
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

  if (message.type === "spc-native-enter") {
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

  if (message.type === "spc-native-insert-text") {
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

  if (message.type !== "load-spc-enquiries") return false

  fetchSpcEnquiries()
    .then(async (enquiries) => {
      const usernames = enquirySenderUsernames(enquiries)
      const senderContacts = await fetchSpcEnquiryChatContacts(usernames).catch(() => ({}))
      sendResponse({ ok: true, enquiries, senderContacts })
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "Unable to load SPC enquiries.",
      })
    })

  return true
})
