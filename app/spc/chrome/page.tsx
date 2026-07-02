"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage } from "@/lib/spcPages"
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
      "Download extension.",
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
      "When there is an update, go to chrome://extensions.",
      "Click reload and then refresh WhatsApp Web.",
    ],
  },
]

export default function SpcChromeExtensionPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const canView = authenticated && canAccessSpcPage(permissions, "spc-chrome-extension", "view")
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

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title={PAGE_TITLE}>
      <section className="spc-panel spc-chrome-installation-panel">
        <div className="spc-panel-header">
          <h2>INSTALLATION</h2>
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
    </SpcShell>
  )
}
