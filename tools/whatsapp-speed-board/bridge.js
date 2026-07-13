(function () {
  const STORAGE_KEY = "fcuno-wa-speed-board-v1"
  const ENQUIRY_STORAGE_KEY = "fcuno-wa-speed-board-enquiries-v1"
  const REQUEST_TYPE = "fcuno-wa-enquiry-send"
  const RESPONSE_TYPE = "fcuno-wa-enquiry-send-result"
  let enqueueChain = Promise.resolve()

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

  function getStorage() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return null
    return chrome.storage.local
  }

  function readState() {
    const storage = getStorage()
    if (!storage) return Promise.resolve({ board: {}, queue: {} })

    return new Promise((resolve) => {
      storage.get([STORAGE_KEY, ENQUIRY_STORAGE_KEY], (items) => {
        if (chrome.runtime.lastError) {
          resolve({ board: {}, queue: {} })
          return
        }
        const board = items && items[STORAGE_KEY] && typeof items[STORAGE_KEY] === "object" ? items[STORAGE_KEY] : {}
        const queue = items && items[ENQUIRY_STORAGE_KEY] && typeof items[ENQUIRY_STORAGE_KEY] === "object"
          ? items[ENQUIRY_STORAGE_KEY]
          : {}
        resolve({ board, queue })
      })
    })
  }

  function writeQueue(queue) {
    const storage = getStorage()
    if (!storage) return Promise.resolve(false)

    return new Promise((resolve) => {
      storage.set({ [ENQUIRY_STORAGE_KEY]: queue }, () => {
        resolve(!chrome.runtime.lastError)
      })
    })
  }

  function notifyNewEnquiry() {
    try {
      chrome.runtime?.sendMessage?.({ type: "notify-new-enquiries", count: 1 })
    } catch {
      // Notifications are a convenience; storage is the delivery mechanism.
    }
  }

  async function enqueueEnquiry(text, buyer) {
    const message = cleanMessage(text)
    if (!message) throw new Error("Shortened enquiry is empty.")
    const buyerName = cleanText(buyer)

    const { board, queue } = await readState()
    const id = uid()
    const now = new Date().toISOString()
    const enquiries = Array.isArray(queue.enquiries)
      ? queue.enquiries
      : Array.isArray(board.enquiries)
        ? board.enquiries
        : []

    const nextQueue = {
      enquiries: [
        {
          id,
          body: message,
          title: message.split("\n").find(Boolean) || "ENQUIRY",
          createdAt: now,
          buyer: buyerName,
          createdByDisplayName: buyerName,
          source: "enquiryworksheet",
        },
        ...enquiries,
      ].slice(0, 120),
    }

    const ok = await writeQueue(nextQueue)
    if (!ok) throw new Error("Could not write to FCUNO WhatsApp Speed Board storage.")
    notifyNewEnquiry()
    return { id, createdAt: now }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return
    const payload = event.data && typeof event.data === "object" ? event.data : null
    if (!payload || payload.type !== REQUEST_TYPE) return

    const enqueueTask = enqueueChain
      .catch(() => {})
      .then(() => enqueueEnquiry(payload.text, payload.buyer))
    enqueueChain = enqueueTask.catch(() => {})

    enqueueTask
      .then((result) => {
        window.postMessage(
          {
            type: RESPONSE_TYPE,
            ok: true,
            requestId: cleanText(payload.requestId),
            ...result,
          },
          window.location.origin,
        )
      })
      .catch((error) => {
        window.postMessage(
          {
            type: RESPONSE_TYPE,
            ok: false,
            requestId: cleanText(payload.requestId),
            message: error instanceof Error ? error.message : "Could not send to FCUNO WhatsApp Speed Board.",
          },
          window.location.origin,
        )
      })
  })
})()
