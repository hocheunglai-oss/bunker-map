const SPC_ENQUIRIES_URL = "https://spc.fcuno.com/api/spc/enquiries?status=sent&limit=120"

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

  if (message.type !== "load-spc-enquiries") return false

  fetch(SPC_ENQUIRIES_URL, {
    cache: "no-store",
    credentials: "include",
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.message || `SPC enquiries failed: ${response.status}`)
      }
      sendResponse({ ok: true, enquiries: Array.isArray(data.enquiries) ? data.enquiries : [] })
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "Unable to load SPC enquiries.",
      })
    })

  return true
})
