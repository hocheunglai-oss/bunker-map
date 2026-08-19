(() => {
  const REQUEST_SOURCE = "fcuno-spc-dispatcher-updater"
  const RESPONSE_SOURCE = "fcuno-spc-dispatcher-extension"

  function runtimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError
          if (error) resolve({ ok: false, message: error.message || String(error) })
          else resolve(response || { ok: false, message: "The extension did not respond." })
        })
      } catch (error) {
        resolve({ ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return
    const data = event.data
    if (data?.source !== REQUEST_SOURCE || data?.action !== "apply-update" || !data.requestId) return

    const response = await runtimeMessage({ type: "extension-apply-update" })
    window.postMessage({
      source: RESPONSE_SOURCE,
      action: "apply-update-result",
      requestId: data.requestId,
      ok: Boolean(response?.ok),
      message: response?.message || "",
    }, window.location.origin)
  })

  void runtimeMessage({ type: "extension-update-page-ready" })
})()
