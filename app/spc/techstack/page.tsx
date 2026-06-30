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
  ["APPLICATION", "NEXT.JS / REACT / TYPESCRIPT", "VERCEL", "SPC.FCUNO.COM"],
  ["AUTHENTICATION", "SPC MANAGED USERS / ROLE GROUPS", "SUPABASE", "SPC USERS"],
  ["USER AUTHORITY", "PAGE PERMISSIONS", "SHARED CONFIG STORE", "SPC GROUPS"],
  ["DATABASE", "POSTGRESQL", "SUPABASE", "SPC_USERS / SPC_ENQUIRIES"],
  ["WHATSAPP ENQUIRY BOARD", "CHROME EXTENSION / SPC ENQUIRY FEED", "TRADER BROWSER", "TOOLS/WHATSAPP-SPC-SPEED-BOARD"],
] as const

const DATABASE_GROUPS = [
  { title: "SPC AUTH", tables: ["spc_users", "office_calendar_store: spc-permission-groups"] },
  { title: "SPC OPERATIONS", tables: ["spc_enquiries"] },
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
      <div className="spc-page-heading">
        <div>
          <h1>Tech Stack</h1>
          <p>Singapore Purchasing Center only</p>
        </div>
      </div>

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
