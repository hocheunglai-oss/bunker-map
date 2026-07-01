"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage } from "@/lib/spcPages"
import { useSpcAuth } from "@/lib/useSpcAuth"

const STEPS = [
  {
    title: "Download the extension",
    details: [
      "Click Download extension ZIP.",
      "Save the ZIP to a normal folder such as Downloads.",
      "Extract the ZIP before loading it into Chrome.",
    ],
  },
  {
    title: "Open Chrome extensions",
    details: [
      "Open Chrome in the profile used for SPC and WhatsApp Web.",
      "Go to chrome://extensions.",
      "Switch on Developer mode at the top right.",
    ],
  },
  {
    title: "Install the unpacked folder",
    details: [
      "Click Load unpacked.",
      "Select the extracted fcuno-spc-whatsapp-board folder.",
      "If Chrome says the manifest is missing, select the folder that directly contains manifest.json.",
    ],
  },
  {
    title: "Sign in and run",
    details: [
      "Open https://spc.fcuno.com and sign in with your SPC account.",
      "Open https://web.whatsapp.com in the same Chrome profile.",
      "Keep both SPC and WhatsApp Web open while using the board.",
    ],
  },
  {
    title: "Update later",
    details: [
      "Download the latest ZIP from this page.",
      "Extract it over the old folder or into a new folder.",
      "Return to chrome://extensions and click Reload on FCUNO SPC WhatsApp Board.",
    ],
  },
] as const

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
    document.title = "SPC Chrome Extension"
  }, [])

  useEffect(() => {
    if (!authLoading && !authenticated) router.replace("/spc")
    if (!authLoading && authenticated && hasPermissionSnapshot && !canView) router.replace("/spc")
  }, [authLoading, authenticated, canView, hasPermissionSnapshot, router])

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC Chrome Extension">
      <div className="spc-page-heading">
        <div>
          <h1>Chrome Extension</h1>
          <p>Download, install, and run the FCUNO SPC WhatsApp Board.</p>
        </div>
        <a className="spc-page-action spc-chrome-download" href="/api/spc/chrome-extension/download">
          Download extension ZIP
        </a>
      </div>

      <section className="spc-panel">
        <div className="spc-panel-header">
          <h2>Installation Steps</h2>
        </div>
        <div className="spc-guide-list">
          {STEPS.map((step, index) => (
            <article className="spc-guide-step" key={step.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{step.title}</h3>
                <ul>
                  {step.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
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
