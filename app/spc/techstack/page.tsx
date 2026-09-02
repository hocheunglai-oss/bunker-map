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
  ["AUTHENTICATION", "ACTIVE FCUNO SESSION AUTO-RESUME / USERNAME-FIRST FCUNO OR EXTERNAL ROUTING / FCUNO-LINKED STAFF HANDOFF / EXTERNAL SPC CREDENTIALS / FORCED FIRST-LOGIN CHANGE / AUDITED SPC PASSWORD CHANGES / OPAQUE 400-DAY SLIDING SERVER SESSIONS / DAILY ACTIVITY RENEWAL / SHA-256 TOKEN HASH / FCUNO LOGOUT REVOKES LINKED SPC SESSIONS / ACTIVE-TAB REVALIDATION / ACCOUNT-CHANGE INVALIDATION", "SPC APP / FCUNO / SUPABASE", "SPC USERS"],
  ["LOGIN SECURITY", "SEPARATE PERSISTENT PASSWORD AND IDENTITY-ROUTING LIMITS / HASHED USERNAME + TRUSTED IP / COALESCED BLOCK MONITORING / GENERIC FAILURES / 30-DAY RETENTION", "SPC APP / SUPABASE / VERCEL", "/API/SPC/LOGIN / /API/SPC/LOGIN-METHOD"],
  ["WHATSAPP LOGIN MFA", "FEATURE-FLAGGED ENFORCEMENT FOR EVERY ACTIVE ENROLLED SPC ACCOUNT / REGISTERED FRATELLI COSULICH HK SENDER / APPROVED SPC_LOGIN_MFA_CODE AUTHENTICATION TEMPLATE / PASSWORD THEN SIX-DIGIT WHATSAPP CODE / KEYED-HASH OTP / 5-MINUTE EXPIRY / SINGLE USE / 5 ATTEMPTS / 60-SECOND, 10-HOURLY AND 20-DAILY PER-USER LIMITS / SOURCE-IP + GLOBAL SEND CEILINGS / FAIL-CLOSED DELIVERY AND ENROLLMENT", "SPC APP / WHATSAPP CLOUD API / SUPABASE", "/API/SPC/LOGIN/MFA"],
  ["BACKUP MODE", "PERSONAL 24-HOUR OPT-IN / NORMAL GROUP DELIVERY CONTINUES / DIRECT TWO-PART ENQUIRY + BUYER COPY TO THAT TRADER ONLY / ADMIN EARLY DEACTIVATION / ONE RECEIVE PER WHATSAPP SERVICE WINDOW / ATOMIC SINGLE-WORKER CLAIM / PER-MESSAGE CHECKPOINT / FAIL-CLOSED MANUAL REVIEW / WEBHOOK STATUS / AUDITED ACTIVATION", "SPC APP / WHATSAPP CLOUD API / SUPABASE / VERCEL CRON", "/API/SPC/MOBILE-MODE / /API/WHATSAPP/WEBHOOK"],
  ["USER AUTHORITY", "ADMIN-ONLY SERVER ENFORCEMENT / ROLE-BOUND PERMISSIONS / FINAL ACTIVE ADMIN GUARD", "SPC APP / SHARED CONFIG STORE", "SPC GROUPS"],
  ["DATABASE", "POSTGRESQL", "SUPABASE", "SPC_USERS / SPC_ENQUIRIES / SPC_ENQUIRY_REVISIONS / SPC_GROUP_DELIVERY_JOBS / SPC_FIXTURES / SPC_LOST_REASON_OPTIONS"],
  ["ENQUIRY OUTCOME TRACKING", "USER-SCOPED SENT ENQUIRIES ACROSS COMPUTERS / OWNER-ONLY OUTCOME, AMENDMENT + REOFFER / IMMUTABLE REVISION HISTORY / PERMISSION-AWARE IMO-FIRST PREVIOUS FIXED + LOST LOOKUP / FIXTURE IMO SNAPSHOT / SHARED SUPPLIER-TRADER SPEED BOARD FEED / FIXTURES / BUYER + SUPPLIER LOST REVIEW / SPC COMMENTS", "SPC APP / SUPABASE", "SPC_ENQUIRIES / SPC_ENQUIRY_REVISIONS / SPC_FIXTURES / SPC_LOST_REASON_OPTIONS / API/SPC/ENQUIRY-HISTORY"],
  ["DAILY BRIEFING", "HONG KONG DAY VIEW / CHRONOLOGICAL BUYER FEED / PREVIOUS FIXTURE + LOST MATCHES / MULTI-SELECT BULK COPY", "SPC APP / SUPABASE", "/SPC/TODAY-ENQUIRIES"],
  ["PARSER REVIEW QUEUE", "MANUAL REVIEW / OPTIONAL AI FIX / AUDITED CORRECTIONS", "SPC APP / SUPABASE", "PARSER_REPORTS"],
  ["USER FEEDBACK", "AUTHENTICATED SUBMISSIONS / USER HISTORY / ADMIN REVIEW + RESPONSE / AUDITED STATUS CHANGES", "SPC APP / SUPABASE", "/SPC/FEEDBACK"],
  ["TRADING STATISTICS", "60-SECOND CACHED FIXTURE AND ENQUIRY AGGREGATION", "SPC APP", "/SPC/STATISTICS"],
  ["SUPPLIER DATABASE", "5-MINUTE CACHED GOOGLE SHEETS / COMPACT OPTIONS API", "GOOGLE WORKSPACE", "SINGAPORE PURCHASE CENTRE DATA"],
  ["AUDIT EVIDENCE", "ACTOR / SOURCE IP / ACTION + TARGET / OUTCOME / CORRELATION + PLATFORM REQUEST ID / REDACTED CREDENTIALS", "SUPABASE / VERCEL", "APPEND-ONLY SPC USER-MANAGEMENT RECORDS"],
  ["WEB SECURITY", "ENFORCED CSP BASELINE / STAGED FULL CSP / HSTS / NOSNIFF / REFERRER + PERMISSIONS POLICY / SECURITY.TXT", "NEXT.JS / VERCEL", "ALL SPC RESPONSES"],
  ["OBSERVABILITY", "SERVER-TIMING / STRUCTURED REQUEST LOGS", "VERCEL", "SPC API ROUTES"],
  ["WHATSAPP ENQUIRY BOARD", "CHROME EXTENSION / SHARED SPC DELTA FEED / VERIFIED USER PHONE ROUTING / ADD-TIME WHATSAPP CONTACT CAPTURE / ORIGINAL-NAME ROUTING FOR GROUPS / PER-BROWSER LOCAL HIDES", "TRADER BROWSER / SUPABASE", "TOOLS/WHATSAPP-SPC-SPEED-BOARD"],
  ["WHATSAPP GROUP REDELIVERY", "SEPARATE WINDOWS-ONLY CHROME EXTENSION / ONE ACTIVE DEVICE / EXACT GROUP MATCH / LEASED IDEMPOTENT QUEUE / OFFLINE RETENTION / ATOMIC REOFFER + GROUP QUEUE / NATIVE WHATSAPP SEND-BUTTON SUBMISSION / MINIMIZABLE LIVE STATUS / 24-HOUR CONFIRMED DELIVERY JOURNAL / ALL-TRADER FAILURE ALERTS / MANUAL REVIEW ON UNCERTAIN SEND", "DEDICATED WHATSAPP BUSINESS WEB / SPC APP / SUPABASE", "TOOLS/WHATSAPP-SPC-GROUP-DISPATCHER"],
  ["WHATSAPP GROUPS API PILOT", "OFFICIAL META GROUP CREATION / ACTIVE-GROUP LOOKUP / GROUP-ID ROUTING / INVITE-LINK RETRIEVAL / EDIT-PERMISSION CONTROL / AUDIT LOG", "META WHATSAPP CLOUD API / SPC APP", "API/SPC/WHATSAPP-GROUPS"],
  ["SPEED BOARD UPDATE NOTICE", "ACTIVE SUPPLIER-TRADER TO RECIPIENTS / FIXED OTTO CC / UPDATE INSTRUCTIONS / AUDIT RECORD", "EXCHANGE SMTP / SUPABASE", "/SPC/CHROME"],
  ["BRENT MARKET DATA", "OFFICIAL FRONT-MONTH FUTURES / CONTRACT, FRESHNESS, RANGE, AND CHART VALIDATION / FAIL-CLOSED", "INTERCONTINENTAL EXCHANGE (ICE)", "/API/MARKET/BRENT / MINIMUM 15-MINUTE DELAY"],
  ["CHROME EXTENSION GUIDE", "NEXT.JS PAGE / AUTH-GATED ZIP DOWNLOAD", "SPC APP", "/SPC/CHROME"],
  ["PRESENTATION", "CHAPTER TABS / EMBEDDED VIDEO / SCRIPT REFERENCE", "SPC APP / SUPABASE STORAGE", "/SPC/PRESENTATION"],
] as const

const DATABASE_GROUPS = [
  { title: "SPC AUTH", tables: ["spc_users", "spc_sessions", "spc_identity_links", "private.spc_login_attempts", "private.spc_login_discovery_attempts", "private.spc_whatsapp_login_mfa_enrollment", "private.spc_whatsapp_login_mfa_challenges", "office_calendar_store: spc-permission-groups"] },
  { title: "SPC OPERATIONS", tables: ["spc_enquiries", "spc_enquiry_revisions", "spc_delivery_routes", "spc_group_dispatchers", "spc_group_delivery_jobs", "spc_fixtures", "spc_lost_reason_options", "spc_mobile_modes", "spc_mobile_enquiry_deliveries"] },
  { title: "SPC PARSER REVIEW", tables: ["parser_reports"] },
  { title: "SPC FEEDBACK", tables: ["spc_feedback"] },
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
