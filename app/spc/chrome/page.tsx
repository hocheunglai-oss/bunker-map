"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage } from "@/lib/spcPages"
import { useSpcAuth } from "@/lib/useSpcAuth"

const PAGE_TITLE = "whatsappex"

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
      "Refresh WhatsApp Web.",
      "Ensure both SPC and WhatsApp Web open while using the board.",
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

const CHECKS = [
  "The extension appears as FCUNO SPC WhatsApp Board in chrome://extensions.",
  "WhatsApp Web shows the SPC board after the page finishes loading.",
  "The enquiry panel loads recent SPC enquiries after SPC login.",
  "If the panel asks you to log in, open SPC again, refresh WhatsApp Web, then retry.",
] as const

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
      <div className="spc-page-heading">
        <div>
          <h1>{PAGE_TITLE}</h1>
        </div>
      </div>

      <section className="spc-panel">
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

      <section className="spc-panel">
        <div className="spc-panel-header">
          <h2>Required Addresses</h2>
        </div>
        <div className="spc-chrome-addresses">
          <div>
            <span>Install page</span>
            <strong>chrome://extensions</strong>
          </div>
          <div>
            <span>SPC login</span>
            <strong>https://spc.fcuno.com</strong>
          </div>
          <div>
            <span>Run extension</span>
            <strong>https://web.whatsapp.com</strong>
          </div>
        </div>
      </section>

      <section className="spc-panel">
        <div className="spc-panel-header">
          <h2>Verification</h2>
        </div>
        <ul className="spc-chrome-checks">
          {CHECKS.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
      </section>
    </SpcShell>
  )
}
