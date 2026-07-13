(function () {
  const REQUEST_TYPE = "fcuno-wa-enquiry-send"
  const RESPONSE_TYPE = "fcuno-wa-enquiry-send-result"

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim()
  }

  function sendToBackground(text, buyer) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
        reject(new Error("FCUNO WhatsApp Speed Board extension is unavailable."))
        return
      }

      chrome.runtime.sendMessage(
        { type: "enqueue-fcuno-enquiry", text, buyer },
        (response) => {
          const error = chrome.runtime.lastError
          if (error) {
            reject(new Error(error.message || String(error)))
            return
          }
          if (!response?.ok) {
            reject(new Error(response?.message || "Could not send to FCUNO WhatsApp Speed Board."))
            return
          }
          resolve(response)
        },
      )
    })
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return
    const payload = event.data && typeof event.data === "object" ? event.data : null
    if (!payload || payload.type !== REQUEST_TYPE) return

    sendToBackground(payload.text, payload.buyer)
      .then((result) => {
        window.postMessage(
          {
            type: RESPONSE_TYPE,
            ok: true,
            requestId: cleanText(payload.requestId),
            id: result.id,
            createdAt: result.createdAt,
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
