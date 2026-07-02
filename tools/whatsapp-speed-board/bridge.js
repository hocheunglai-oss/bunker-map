(function () {
  const STORAGE_KEY = "fcuno-wa-speed-board-v1"
  const REQUEST_TYPE = "fcuno-wa-enquiry-send"
  const RESPONSE_TYPE = "fcuno-wa-enquiry-send-result"

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
    if (!storage) return Promise.resolve({})

    return new Promise((resolve) => {
      storage.get([STORAGE_KEY], (items) => {
        if (chrome.runtime.lastError) {
          resolve({})
          return
        }
        resolve(items && items[STORAGE_KEY] && typeof items[STORAGE_KEY] === "object" ? items[STORAGE_KEY] : {})
      })
    })
  }

  function writeState(state) {
    const storage = getStorage()
    if (!storage) return Promise.resolve(false)

    return new Promise((resolve) => {
      storage.set({ [STORAGE_KEY]: state }, () => {
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

  async function enqueueEnquiry(text) {
    const message = cleanMessage(text)
    if (!message) throw new Error("Shortened enquiry is empty.")

    const current = await readState()
    const id = uid()
    const now = new Date().toISOString()
    const enquiries = Array.isArray(current.enquiries) ? current.enquiries : []
    const hiddenEnquiryIds =
      current.hiddenEnquiryIds && typeof current.hiddenEnquiryIds === "object"
        ? current.hiddenEnquiryIds
        : {}
    const selectedEnquiries =
      current.selectedEnquiries && typeof current.selectedEnquiries === "object"
        ? current.selectedEnquiries
        : {}

    const nextState = {
      ...current,
      enquiries: [
        {
          id,
          body: message,
          title: message.split("\n").find(Boolean) || "ENQUIRY",
          createdAt: now,
          createdByDisplayName: "ENQUIRY WORKSHEET",
          source: "enquiryworksheet",
        },
        ...enquiries,
      ].slice(0, 120),
      hiddenEnquiryIds: {
        ...hiddenEnquiryIds,
        [id]: false,
      },
      selectedEnquiries: {
        ...selectedEnquiries,
        [id]: true,
      },
      lastNotifiedEnquiryAt: now,
    }

    const ok = await writeState(nextState)
    if (!ok) throw new Error("Could not write to FCUNO WhatsApp Speed Board storage.")
    notifyNewEnquiry()
    return { id, createdAt: now }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return
    const payload = event.data && typeof event.data === "object" ? event.data : null
    if (!payload || payload.type !== REQUEST_TYPE) return

    enqueueEnquiry(payload.text)
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
