"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"

type SecretItem = {
  name: string
  configured: boolean
  storage: string
  value: string
}

type TechStackResponse = {
  generatedAt: string
  deployment: {
    platform: string
    project: string
    productionUrl: string
    gitRepository: string
    branch: string
    commit: string
  }
  secrets: SecretItem[]
  message?: string
}

const SERVICES = [
  ["APPLICATION", "NEXT.JS 16 / REACT 19 / TYPESCRIPT", "VERCEL", "SPC.FCUNO.COM"],
  ["AUTHENTICATION", "SPC MANAGED USERS / ROLE GROUPS", "SUPABASE", "SPC USERS"],
  ["USER AUTHORITY", "PAGE PERMISSIONS", "SHARED CONFIG STORE", "SPC GROUPS"],
  ["DATABASE", "POSTGRESQL", "SUPABASE", "SPC_USERS / SPC_ENQUIRIES / SPC_FIXTURES"],
  ["ENQUIRY OUTCOME TRACKING", "ENQUIRIES / FIXTURES / LOST RECORD", "SPC APP", "SPC_ENQUIRIES / SPC_FIXTURES"],
  ["TRADING STATISTICS", "60-SECOND CACHED FIXTURE AND ENQUIRY AGGREGATION", "SPC APP", "/SPC/STATISTICS"],
  ["SUPPLIER DATABASE", "5-MINUTE CACHED GOOGLE SHEETS / COMPACT OPTIONS API", "GOOGLE WORKSPACE", "SINGAPORE PURCHASE CENTRE DATA"],
  ["OBSERVABILITY", "SERVER-TIMING / STRUCTURED REQUEST LOGS", "VERCEL", "SPC API ROUTES"],
  ["WHATSAPP ENQUIRY BOARD", "CHROME EXTENSION / SHARED SPC DELTA FEED / PER-BROWSER LOCAL HIDES", "TRADER BROWSER", "TOOLS/WHATSAPP-SPC-SPEED-BOARD"],
  ["BRENT MARKET DATA", "OFFICIAL FRONT-MONTH FUTURES / CONTRACT, FRESHNESS, RANGE, AND CHART VALIDATION / FAIL-CLOSED", "INTERCONTINENTAL EXCHANGE (ICE)", "/API/MARKET/BRENT / MINIMUM 15-MINUTE DELAY"],
  ["CHROME EXTENSION GUIDE", "NEXT.JS PAGE / AUTH-GATED ZIP DOWNLOAD", "SPC APP", "/SPC/CHROME"],
  ["README / PRESENTATION", "CHAPTER TABS / SCRIPT EDITOR / CONTINUOUS PLAYBACK / VERIFIED OFFLINE MEDIA", "SPC APP / SUPABASE STORAGE", "/SPC/README"],
] as const

const DATABASE_GROUPS = [
  { title: "SPC AUTH", tables: ["spc_users", "office_calendar_store: spc-permission-groups"] },
  { title: "SPC OPERATIONS", tables: ["spc_enquiries", "spc_fixtures"] },
  { title: "SPC PRESENTATION", tables: ["spc_presentation_chunks", "Supabase Storage: spc-presentation-media"] },
  { title: "SPC SUPPLIERS", tables: ["Google Sheet: INFO", "Google Sheet: COVERAGE", "Google Sheet: SUPPLIER BDN", "Google Sheet: CONTACTS", "Google Sheet: SUPPLIER BARGES", "office_calendar_store: spc-supplier-overrides"] },
  { title: "SPC AUDIT", tables: ["audit_logs"] },
] as const

export default function SpcTechStackPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [data, setData] = useState<TechStackResponse | null>(null)
  const [message, setMessage] = useState("")
  const canView = canAccessSpcPage(permissions, "spc-tech-stack", "view")

  const loadData = useCallback(async () => {
    if (!authenticated || !canView) return
    const response = await fetch("/api/spc/tech-stack", { cache: "no-store" })
    const result = (await response.json()) as TechStackResponse
    if (!response.ok) {
      setMessage(result.message || "Could not load SPC tech stack.")
      return
    }
    setData(result)
  }, [authenticated, canView])

  useEffect(() => {
    document.title = "SPC Tech Stack"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.replace("/spc")
  }, [authLoading, authenticated, canView, router])

  useEffect(() => {
    void loadData()
  }, [loadData])

  if (authLoading || !authenticated || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC Tech Stack">
      {message ? <div className="spc-alert is-error">{message}</div> : null}

      <section className="spc-panel">
        <div className="spc-health-grid">
          <div><span>PLATFORM</span><strong>{data?.deployment.platform || "VERCEL"}</strong></div>
          <div><span>PROJECT</span><strong>{data?.deployment.project || "BUNKER-MAP-C2KS"}</strong></div>
          <div><span>DOMAIN</span><strong>SPC.FCUNO.COM</strong></div>
          <div><span>COMMIT</span><strong>{data?.deployment.commit?.slice(0, 7) || "-"}</strong></div>
        </div>
      </section>

      <section className="spc-panel">
        <div className="spc-panel-header"><h2>Services</h2></div>
        <div className="spc-table-wrap">
          <table className="spc-table">
            <thead><tr><th>Function</th><th>Technology</th><th>Provider</th><th>Account / Project</th></tr></thead>
            <tbody>{SERVICES.map((row) => <tr key={row[0]}>{row.map((cell) => <td key={cell}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="spc-panel">
        <div className="spc-panel-header"><h2>Database</h2></div>
        <div className="spc-tech-database">
          {DATABASE_GROUPS.map((group) => (
            <article key={group.title}>
              <h3>{group.title}</h3>
              <ul>{group.tables.map((table) => <li key={table}>{table}</li>)}</ul>
            </article>
          ))}
        </div>
      </section>

      <section className="spc-panel">
        <div className="spc-panel-header"><h2>Key and Secret Register</h2></div>
        <div className="spc-secret-grid">
          {(data?.secrets || []).map((secret) => (
            <article key={secret.name}>
              <div>
                <h3>{secret.name}</h3>
                <p>{secret.storage}</p>
              </div>
              <span className={secret.configured ? "is-configured" : "is-missing"}>
                {secret.configured ? "CONFIGURED" : "NOT CONFIGURED"}
              </span>
            </article>
          ))}
        </div>
      </section>
    </SpcShell>
  )
}
