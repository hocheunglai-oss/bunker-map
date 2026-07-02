const SPC_ENQUIRIES_URL = "https://spc.fcuno.com/api/spc/enquiries?limit=160"

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
