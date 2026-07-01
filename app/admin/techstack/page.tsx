"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import styles from "./techStack.module.css"

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
  ["APPLICATION", "NEXT.JS 15 / REACT 18 / TYPESCRIPT", "VERCEL", "FCUNO.COM"],
  ["SOURCE CONTROL", "GIT / GITHUB", "GITHUB", "HOCHEUNGLAI-OSS/BUNKER-MAP"],
  ["PRIMARY DATABASE", "POSTGRESQL", "SUPABASE", "PROJECT GGLYUGBRNYVYFKTGWERT"],
  ["FILE SOURCE", "GOOGLE DRIVE", "GOOGLE WORKSPACE", "WIDER.CUSTOM@GMAIL.COM"],
  ["FILE BACKUP", "GOOGLE CLOUD STORAGE", "GOOGLE CLOUD", "BUNKER-MAP-DRIVE-UPLOADER"],
  ["BACKUP RUNNER", "CLOUD RUN JOB", "GOOGLE CLOUD", "US-CENTRAL1"],
  ["BACKUP SCHEDULER", "CLOUD SCHEDULER", "GOOGLE CLOUD", "DAILY"],
  ["PHONEBOOK SYNC", "CARDDAV / NEXTCLOUD", "THE GOOD CLOUD", "USE22.THEGOOD.CLOUD"],
  ["CALENDAR SYNC", "GOOGLE CALENDAR API", "GOOGLE", "FCB.BUNKER@GMAIL.COM"],
  ["MAIL DIRECTORY", "EXCHANGE ONLINE / GRAPH", "MICROSOFT 365", "AZURE AUTOMATION"],
  ["SINGAPORE PURCHASING CENTER", "NEXT.JS SUBDOMAIN APP / SPC AUTH", "VERCEL", "SPC.FCUNO.COM"],
  ["SPC SUPPLIER DATABASE", "GOOGLE SHEETS API / SHEET-BACKED EDITS", "GOOGLE WORKSPACE", "SINGAPORE PURCHASE CENTRE DATA"],
  ["ADMIN AI WORKBENCH", "GEMINI INTERACTIONS API", "GOOGLE AI", "CONFIGURED IN VERCEL"],
  ["TRANSACTIONAL EMAIL", "EXCHANGE SMTP", "MICROSOFT 365", "INFO@COSULICH.COM.HK"],
  ["MAPS", "MAPTILER SDK / LEAFLET", "MAPTILER", "PUBLIC CLIENT KEY"],
] as const

const DATABASE_GROUPS = [
  {
    title: "ADMINISTRATION",
    tables: ["admin_users", "admin_role_defaults", "audit_logs"],
  },
  {
    title: "CCINFO",
    tables: [
      "cc_companies",
      "cc_countries",
      "cc_ports",
      "cc_documents",
      "cc_company_files",
      "cc_entry_files",
      "cc_entry_folders",
    ],
  },
  {
    title: "CONTACTS",
    tables: [
      "phonebook_contacts",
      "phonebook_companies",
      "shared_addressbook_contacts",
      "shared_addressbook_groups",
      "shared_addressbook_group_members",
      "outlook_exchange_sync_queue",
    ],
  },
  {
    title: "OPERATIONS",
    tables: ["office_calendar_store", "email_templates", "ports", "remarks", "price_history"],
  },
  {
    title: "SPC",
    tables: ["spc_users", "spc_enquiries", "office_calendar_store: spc-permission-groups"],
  },
] as const

const SCHEDULES = [
  ["SUPABASE DATA BACKUP", "SATURDAY 19:00 UTC", "VERCEL CRON", "GOOGLE DRIVE / LATEST 12"],
  ["CCINFO FILE BACKUP", "DAILY 00:00 UTC", "GOOGLE CLOUD SCHEDULER", "GCS / VERSIONED"],
  ["SYSTEM HEALTH EMAIL", "DAILY 00:30 UTC", "VERCEL CRON", "WARNING OR ERROR ONLY"],
  ["EVENT REMINDERS", "DAILY 00:00 UTC", "VERCEL CRON", "08:00 HONG KONG"],
  ["TASK REMINDERS", "DAILY 00:00 UTC", "VERCEL CRON", "08:00 HONG KONG"],
] as const

function displayDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}

export default function TechStackPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role } = useSimpleAdminAuth()
  const [data, setData] = useState<TechStackResponse | null>(null)
  const [message, setMessage] = useState("")
  const canView = isAdminRole(role) || canAccessAdminPage(permissions, "tech-stack", "view")

  const loadData = useCallback(async () => {
    if (!authenticated || !canView) return
    const response = await fetch("/api/admin/tech-stack", { cache: "no-store" })
    const result = (await response.json()) as TechStackResponse
    if (!response.ok) {
      setMessage(result.message || "COULD NOT LOAD TECH STACK.")
      return
    }
    setData(result)
  }, [authenticated, canView])

  useEffect(() => {
    document.title = "TECH STACK - FC Uno"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.push("/admin")
  }, [authLoading, authenticated, canView, router])

  useEffect(() => {
    loadData()
  }, [loadData])

  if (authLoading || !authenticated || !canView) {
    return <div className={styles.page}>LOADING...</div>
  }

  return (
    <div className={styles.page}>
      <main className={styles.shell}>
        {message ? <div className={styles.error}>{message}</div> : null}

        <section className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2>PRODUCTION</h2>
          </div>
          <div className={styles.factGrid}>
            <div><span>PLATFORM</span><strong>{data?.deployment.platform || "VERCEL"}</strong></div>
            <div><span>PROJECT</span><strong>{data?.deployment.project || "BUNKER-MAP-C2KS"}</strong></div>
            <div><span>DOMAIN</span><strong>FCUNO.COM</strong></div>
            <div><span>GITHUB</span><strong>{data?.deployment.gitRepository || "HOCHEUNGLAI-OSS/BUNKER-MAP"}</strong></div>
            <div><span>BRANCH</span><strong>{data?.deployment.branch || "MAIN"}</strong></div>
            <div><span>COMMIT</span><strong>{data?.deployment.commit?.slice(0, 7) || "-"}</strong></div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionTitle}><h2>SERVICES AND ACCOUNTS</h2></div>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>FUNCTION</th><th>TECHNOLOGY</th><th>PROVIDER</th><th>ACCOUNT / PROJECT</th></tr></thead>
              <tbody>{SERVICES.map((row) => <tr key={row[0]}>{row.map((cell) => <td key={cell}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionTitle}><h2>DATABASE</h2></div>
          <div className={styles.databaseGrid}>
            {DATABASE_GROUPS.map((group) => (
              <article key={group.title}>
                <h3>{group.title}</h3>
                <ul>{group.tables.map((table) => <li key={table}>{table}</li>)}</ul>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionTitle}><h2>BACKUP AND AUTOMATION</h2></div>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>JOB</th><th>SCHEDULE</th><th>RUNNER</th><th>DESTINATION / POLICY</th></tr></thead>
              <tbody>{SCHEDULES.map((row) => <tr key={row[0]}>{row.map((cell) => <td key={cell}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className={styles.notes}>
            <p>CCINFO FILES: FULL DRIVE TREE BACKED UP; ACTIVE DATABASE REFERENCES VERIFIED BY SYSTEM HEALTH.</p>
            <p>GCS REGION: US-CENTRAL1. VERSIONING ENABLED. NON-CURRENT VERSIONS DELETE AFTER 30 DAYS. SOFT DELETE: 7 DAYS.</p>
            <p>DATABASE BACKUPS: GOOGLE DRIVE, LATEST 12 SNAPSHOTS RETAINED.</p>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2>KEY AND SECRET REGISTER</h2>
            <span>VALUES ARE NEVER EXPOSED</span>
          </div>
          <div className={styles.secretGrid}>
            {(data?.secrets || []).map((secret) => (
              <article key={secret.name}>
                <div>
                  <h3>{secret.name}</h3>
                  <p>{secret.storage}</p>
                </div>
                <span className={secret.configured ? styles.configured : styles.missing}>
                  {secret.configured ? "CONFIGURED" : "NOT CONFIGURED"}
                </span>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.securityNotice}>
          <h2>SECRET HANDLING</h2>
          <p>
            PASSWORDS, PRIVATE KEYS, OAUTH REFRESH TOKENS, CERTIFICATES, AND API KEY VALUES ARE STORED ONLY IN
            VERCEL ENVIRONMENT VARIABLES OR GOOGLE SECRET MANAGER. THEY ARE INTENTIONALLY NOT DISPLAYED OR SAVED
            IN THIS APPLICATION, GITHUB, OR THE LOCAL WORKSPACE.
          </p>
        </section>
      </main>
    </div>
  )
}
