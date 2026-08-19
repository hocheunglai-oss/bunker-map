"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage } from "@/lib/spcPages"
import { SPC_SPEED_BOARD_VERSION } from "@/lib/spcSpeedBoardNotice"
import {
  updateSpcDispatcherDirectory,
  type SpcDispatcherDirectoryHandle,
  type SpcGroupDispatcherBundle,
} from "@/lib/spcGroupDispatcherPackage"
import { SPC_GROUP_DISPATCHER_VERSION } from "@/lib/spcGroupDispatcherVersion"
import { useSpcAuth } from "@/lib/useSpcAuth"

const PAGE_TITLE = "WHATSAPP EXTENSION"

type Step = {
  title: string
  details: readonly string[]
  action?: {
    href: string
    label: string
  }
}

const STEPS: readonly Step[] = [
  {
    title: "Download",
    details: [
      `Download extension version ${SPC_SPEED_BOARD_VERSION}.`,
      "Extract the ZIP and save to a folder such as Documents.",
    ],
    action: {
      href: "/api/spc/chrome-extension/download",
      label: "WHATSAPP EXTENSION",
    },
  },
  {
    title: "Install",
    details: [
      "Open Google Chrome and paste chrome://extensions to the browser.",
      "Switch on Developer mode at the top right.",
      "Click Load unpacked and select the extracted fcuno-spc-whatsapp-board folder (Select the folder and press the select button, do not open it).",
    ],
  },
  {
    title: "Open",
    details: [
      "Ensure your WhatsApp Web is in English, click refresh.",
      "Keep both SPC and WhatsApp Web open while using the board.",
    ],
  },
  {
    title: "Update",
    details: [
      "The board checks its installed version automatically. A red UPDATE REQUIRED bar means that computer is still running an old copy.",
      "Download and extract the new ZIP, then replace the files inside the same fcuno-spc-whatsapp-board folder that Chrome already uses.",
      "Go to chrome://extensions, click Reload on FCUNO SPC WhatsApp Board, confirm the new version is shown, then refresh WhatsApp Web.",
    ],
  },
]

const DISPATCHER_STEPS: readonly Step[] = [
  {
    title: `Download dispatcher ${SPC_GROUP_DISPATCHER_VERSION}`,
    details: [
      "Use only the approved SPC WhatsApp Business desktop. Do not install this dispatcher on trader computers.",
      "Keep WhatsApp Web and this Chrome profile open during trading hours; offline enquiries remain queued.",
      `Download and extract the versioned ZIP. The selected folder must be fcuno-spc-group-dispatcher-v${SPC_GROUP_DISPATCHER_VERSION} and must contain manifest.json.`,
    ],
    action: {
      href: "/api/spc/group-dispatcher/download",
      label: `GROUP DISPATCHER ${SPC_GROUP_DISPATCHER_VERSION}`,
    },
  },
  {
    title: "Update the installed folder",
    details: [
      "Choose UPDATE INSTALLED FOLDER above and select the dispatcher folder Chrome is currently using. The page verifies manifest.json and replaces that folder directly.",
      `Open chrome://extensions and click Reload on FCUNO SPC Group Dispatcher. Confirm the card shows version ${SPC_GROUP_DISPATCHER_VERSION}.`,
      "Keep spc.fcuno.com signed in in the same Chrome profile. WhatsApp Web refreshes automatically after the extension reloads.",
      "The dispatcher connects automatically. Exact WhatsApp groups are managed centrally in User Management.",
      "Use the ZIP download only for a first installation or if the installed folder is no longer available.",
    ],
  },
]

type DispatcherStatus = {
  id: string
  deviceLabel: string
  groupName: string
  extensionVersion: string
  lastSeenAt: string | null
  lastError: string | null
}

type DispatcherHealth = {
  activeRouteCount: number
  queuedCount: number
  manualReviewCount: number
  failedCount: number
}

type ApiGroupResult = {
  id: string
  subject: string
  createdAt: string | null
  inviteLink: string
  reused: boolean
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<SpcDispatcherDirectoryHandle>
}

export default function SpcChromeExtensionPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [noticeSending, setNoticeSending] = useState(false)
  const [noticeMessage, setNoticeMessage] = useState("")
  const [noticeIsError, setNoticeIsError] = useState(false)
  const [dispatcher, setDispatcher] = useState<DispatcherStatus | null>(null)
  const [dispatcherHealth, setDispatcherHealth] = useState<DispatcherHealth | null>(null)
  const [dispatcherLoading, setDispatcherLoading] = useState(true)
  const [dispatcherFolderUpdating, setDispatcherFolderUpdating] = useState(false)
  const [apiGroupSubject, setApiGroupSubject] = useState("OTTO LAI (SPC)")
  const [apiGroupArmed, setApiGroupArmed] = useState(false)
  const [apiGroupCreating, setApiGroupCreating] = useState(false)
  const [apiGroupResult, setApiGroupResult] = useState<ApiGroupResult | null>(null)
  const canView = authenticated && canAccessSpcPage(permissions, "spc-chrome-extension", "view")
  const canEdit = authenticated && canAccessSpcPage(permissions, "spc-chrome-extension", "edit")
  const dispatcherNeedsUpdate = Boolean(
    dispatcher && dispatcher.extensionVersion !== SPC_GROUP_DISPATCHER_VERSION,
  )
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(
    permissions,
    "spc-chrome-extension",
  )

  useEffect(() => {
    document.title = PAGE_TITLE
  }, [])

  useEffect(() => {
    if (!authLoading && !authenticated) router.replace("/spc")
    if (!authLoading && authenticated && hasPermissionSnapshot && !canView) router.replace("/spc")
  }, [authLoading, authenticated, canView, hasPermissionSnapshot, router])

  useEffect(() => {
    if (!canView) return
    let cancelled = false
    fetch("/api/spc/group-dispatcher", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.message || "Failed to load dispatcher status.")
        if (!cancelled) {
          setDispatcher(data.dispatcher || null)
          setDispatcherHealth(data.health || null)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setNoticeMessage(error instanceof Error ? error.message : "Failed to load dispatcher status.")
          setNoticeIsError(true)
        }
      })
      .finally(() => {
        if (!cancelled) setDispatcherLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [canView])

  async function sendUpdateNotice() {
    if (
      !window.confirm(
        `Send SPC Speed Board ${SPC_SPEED_BOARD_VERSION} update instructions to all active supplier traders?`,
      )
    ) {
      return
    }

    setNoticeSending(true)
    setNoticeMessage("")
    setNoticeIsError(false)
    try {
      const response = await fetch("/api/spc/chrome-extension/notify", { method: "POST" })
      const data = (await response.json()) as {
        message?: string
        skipped?: number
        warning?: string
      }
      if (!response.ok) throw new Error(data.message || "Failed to send the update notice.")

      const skippedMessage = data.skipped
        ? ` ${data.skipped} account${data.skipped === 1 ? " was" : "s were"} skipped because the username is not a valid email address.`
        : ""
      setNoticeMessage(`${data.message || "Update notice sent."}${skippedMessage}${data.warning ? ` ${data.warning}` : ""}`)
    } catch (error) {
      setNoticeMessage(error instanceof Error ? error.message : "Failed to send the update notice.")
      setNoticeIsError(true)
    } finally {
      setNoticeSending(false)
    }
  }

  async function revokeDispatcher() {
    if (!window.confirm("Revoke the active SPC Group Dispatcher? Queued enquiries will wait until another desktop is paired.")) return
    const response = await fetch("/api/spc/group-dispatcher", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revoke" }),
    })
    const data = await response.json()
    if (!response.ok) {
      setNoticeMessage(data.message || "Failed to revoke dispatcher.")
      setNoticeIsError(true)
      return
    }
    setDispatcher(null)
    setNoticeMessage("The active SPC Group Dispatcher was revoked.")
    setNoticeIsError(false)
  }

  async function updateInstalledDispatcherFolder() {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker
    if (!picker) {
      setNoticeMessage("Installed-folder updates require desktop Google Chrome or Microsoft Edge.")
      setNoticeIsError(true)
      return
    }

    setDispatcherFolderUpdating(true)
    setNoticeMessage("")
    setNoticeIsError(false)
    try {
      const directory = await picker({ mode: "readwrite" })
      const response = await fetch("/api/spc/group-dispatcher/files", {
        cache: "no-store",
      })
      const data = (await response.json()) as SpcGroupDispatcherBundle & { message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to load dispatcher update files.")
      if (data.version !== SPC_GROUP_DISPATCHER_VERSION) {
        throw new Error(`The server returned dispatcher v${data.version || "unknown"}; v${SPC_GROUP_DISPATCHER_VERSION} is required.`)
      }
      const result = await updateSpcDispatcherDirectory(directory, data)
      setNoticeMessage(
        `${result.directoryName} was updated from v${result.previousVersion} to v${result.version}. Open chrome://extensions and click Reload on FCUNO SPC Group Dispatcher.`,
      )
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setNoticeMessage("Dispatcher folder update cancelled.")
        return
      }
      setNoticeMessage(error instanceof Error ? error.message : "Failed to update the installed dispatcher folder.")
      setNoticeIsError(true)
    } finally {
      setDispatcherFolderUpdating(false)
    }
  }

  async function createApiGroup() {
    const subject = apiGroupSubject.replace(/\s+/g, " ").trim()
    if (!subject) {
      setNoticeMessage("Group subject is required.")
      setNoticeIsError(true)
      return
    }
    setApiGroupCreating(true)
    setApiGroupArmed(false)
    setApiGroupResult(null)
    setNoticeMessage("")
    setNoticeIsError(false)
    try {
      const response = await fetch("/api/spc/whatsapp-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject }),
      })
      const data = (await response.json()) as {
        message?: string
        group?: ApiGroupResult
        warning?: string
      }
      if (!response.ok || !data.group) throw new Error(data.message || "Failed to create the WhatsApp API group.")
      setApiGroupResult(data.group)
      const outcome = data.group.reused
        ? "Existing API group found."
        : "Official WhatsApp API test group created."
      setNoticeMessage(`${outcome}${data.warning ? ` ${data.warning}` : ""}`)
    } catch (error) {
      setNoticeMessage(error instanceof Error ? error.message : "Failed to create the WhatsApp API group.")
      setNoticeIsError(true)
    } finally {
      setApiGroupCreating(false)
    }
  }

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title={PAGE_TITLE}>
      {noticeMessage ? (
        <div
          className={`spc-alert spc-chrome-feedback${noticeIsError ? " is-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {noticeMessage}
        </div>
      ) : null}
      <section className="spc-panel spc-chrome-installation-panel">
        <div className="spc-panel-header">
          <h2>INSTALLATION</h2>
          {canEdit ? (
            <button
              type="button"
              className="spc-page-action spc-chrome-notice-button"
              onClick={() => void sendUpdateNotice()}
              disabled={noticeSending}
            >
              {noticeSending ? "Sending..." : "Send Update Notice"}
            </button>
          ) : null}
        </div>
        <div className="spc-guide-list">
          {STEPS.map((step, index) => (
            <article className="spc-guide-step" key={step.title}>
              <span>{String(index + 1)}</span>
              <div>
                <h3>{step.title}</h3>
                <ul>
                  {step.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
                {step.action ? (
                  <a className="spc-page-action spc-chrome-download" href={step.action.href}>
                    {step.action.label}
                  </a>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
      {canEdit ? (
        <section className="spc-panel spc-chrome-installation-panel">
          <div className="spc-panel-header">
            <div>
              <h2>GROUP DISPATCHER</h2>
              <p>Dedicated delivery service for the approved SPC WhatsApp Business desktop.</p>
            </div>
            <div className="spc-chrome-header-actions">
              <button
                type="button"
                className="spc-page-action spc-chrome-notice-button"
                onClick={() => void updateInstalledDispatcherFolder()}
                disabled={dispatcherFolderUpdating}
              >
                {dispatcherFolderUpdating ? "Updating..." : "Update Installed Folder"}
              </button>
              {dispatcher ? (
                <button
                  type="button"
                  className="spc-page-action spc-chrome-notice-button"
                  onClick={() => void revokeDispatcher()}
                >
                  Revoke Dispatcher
                </button>
              ) : null}
            </div>
          </div>
          <div className="spc-guide-list">
            {DISPATCHER_STEPS.map((step, index) => (
              <article className="spc-guide-step" key={step.title}>
                <span>{String(index + 1)}</span>
                <div>
                  <h3>{step.title}</h3>
                  <ul>{step.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
                  {step.action ? (
                    <a className="spc-page-action spc-chrome-download" href={step.action.href}>
                      {step.action.label}
                    </a>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
          <div className="spc-chrome-dispatcher-status">
            <strong>STATUS</strong>
            {dispatcherLoading ? (
              <span>Loading...</span>
            ) : dispatcher ? (
              <span>
                Active: {dispatcher.deviceLabel} / multi-route / installed v{dispatcher.extensionVersion} / required v{SPC_GROUP_DISPATCHER_VERSION}
                {dispatcherNeedsUpdate ? " / UPDATE REQUIRED" : " / Current"}
                {dispatcher.lastSeenAt ? ` / Last seen ${new Date(dispatcher.lastSeenAt).toLocaleString()}` : ""}
                {dispatcher.lastError ? ` / ${dispatcher.lastError}` : ""}
              </span>
            ) : (
              <span>No active dispatcher. New enquiries will remain safely queued.</span>
            )}
            {dispatcherHealth ? (
              <span>
                Routes {dispatcherHealth.activeRouteCount} / queued {dispatcherHealth.queuedCount} / failed {dispatcherHealth.failedCount} / review {dispatcherHealth.manualReviewCount}. Speed Board delivery remains available independently.
              </span>
            ) : null}
          </div>
        </section>
      ) : null}
      {canEdit ? (
        <section className="spc-panel spc-chrome-installation-panel">
          <div className="spc-panel-header">
            <div>
              <h2>OFFICIAL GROUPS API PILOT</h2>
              <p>Create one Meta-managed test group and retrieve its invitation link.</p>
            </div>
          </div>
          <div className="spc-chrome-api-group-pilot">
            <label>
              <span>GROUP SUBJECT</span>
              <input
                value={apiGroupSubject}
                onChange={(event) => {
                  setApiGroupSubject(event.target.value)
                  setApiGroupArmed(false)
                  setApiGroupResult(null)
                }}
                maxLength={128}
                disabled={apiGroupCreating}
              />
            </label>
            <button
              type="button"
              className="spc-page-action"
              onClick={() => {
                if (!apiGroupArmed) {
                  setApiGroupArmed(true)
                  return
                }
                void createApiGroup()
              }}
              disabled={apiGroupCreating || !apiGroupSubject.trim()}
            >
              {apiGroupCreating
                ? "Creating..."
                : apiGroupArmed
                  ? "Confirm Create"
                  : "Create Test Group"}
            </button>
          </div>
          {apiGroupArmed ? (
            <p className="spc-chrome-api-group-confirmation" role="status">
              Confirm to create this external Meta WhatsApp group. This action cannot be undone here.
            </p>
          ) : null}
          {apiGroupResult ? (
            <div className="spc-chrome-api-group-result" role="status">
              <div>
                <strong>{apiGroupResult.subject}</strong>
                <span>Meta group ID: {apiGroupResult.id}</span>
              </div>
              <a
                className="spc-page-action spc-chrome-download"
                href={apiGroupResult.inviteLink}
                target="_blank"
                rel="noreferrer"
              >
                Open Invite Link
              </a>
            </div>
          ) : null}
        </section>
      ) : null}
    </SpcShell>
  )
}
