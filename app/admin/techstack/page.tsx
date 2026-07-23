"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import styles from "./techStack.module.css"

type SecretItem = {
  name: string
  configured: boolean | null
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
    functionRegion: string
  }
  databaseInventory: {
    schema: string
    migrationHead: string
    tables: string[]
  }
  secrets: SecretItem[]
  message?: string
}

const SERVICES = [
  ["APPLICATION", "NEXT.JS 16 / REACT 19 / TYPESCRIPT", "VERCEL", "FCUNO.COM"],
  ["PERFORMANCE MONITORING", "SPEED INSIGHTS / WEB ANALYTICS", "VERCEL", "REAL-USER CORE WEB VITALS"],
  ["SOURCE CONTROL", "GIT / GITHUB", "GITHUB", "HOCHEUNGLAI-OSS/BUNKER-MAP"],
  ["PRIMARY DATABASE", "POSTGRESQL 17", "SUPABASE", "PROJECT GGLYUGBRNYVYFKTGWERT"],
  ["DATABASE ARTIFACT BACKUP", "VERIFIED JSON V2 / SHA-256 PREDECESSOR CHAIN", "VERCEL / GOOGLE DRIVE", "BUNKER MAP BACKUPS / DAILY SUPABASE BACKUPS"],
  ["FILE SOURCE", "GOOGLE DRIVE", "GOOGLE WORKSPACE", "WIDER.CUSTOM@GMAIL.COM"],
  ["FILE BACKUP", "GOOGLE CLOUD STORAGE", "GOOGLE CLOUD", "BUNKER-MAP-DRIVE-UPLOADER"],
  ["BACKUP RUNNER", "CLOUD RUN JOB", "GOOGLE CLOUD", "US-CENTRAL1"],
  ["BACKUP SCHEDULER", "CLOUD SCHEDULER", "GOOGLE CLOUD", "DAILY"],
  ["PHONEBOOK SYNC", "CARDDAV / NEXTCLOUD", "THE GOOD CLOUD", "USE22.THEGOOD.CLOUD"],
  ["CALENDAR SYNC", "GOOGLE CALENDAR API", "GOOGLE", "FCB.BUNKER@GMAIL.COM"],
  ["MAIL DIRECTORY", "FCUNO AUTHORITY / EXCHANGE ONLINE PROJECTION", "MICROSOFT 365", "AZURE AUTOMATION"],
  ["EXCHANGE TRUTH EVIDENCE", "TRANSACTIONAL OUTBOX / CANONICAL SNAPSHOTS / SHA-256 LEDGER", "SUPABASE", "FULL EXACT-MATCH CERTIFICATION"],
  ["EXCHANGE WORKER", "POWERSHELL RUNBOOK / CHECKPOINTED NOTICES", "AZURE AUTOMATION", "FCUNO-EXCHANGE-RUNBOOK/2026-07-23.1"],
  ["RELIABILITY MONITORING", "LIVE INVENTORY / BACKUP CHAIN / EXCHANGE VERIFIER", "SYSTEM HEALTH", "/ADMIN/SYSTEMHEALTH"],
  ["SALESFORCE DATA", "EXTERNAL DATA PORTAL", "FCOS", "FCOS.FCUNO.COM"],
  ["SINGAPORE PURCHASING CENTER", "NEXT.JS SUBDOMAIN APP / SPC AUTH", "VERCEL", "SPC.FCUNO.COM"],
  ["SPC SUPPLIER DATABASE", "GOOGLE SHEETS API / SHEET-BACKED EDITS", "GOOGLE WORKSPACE", "SINGAPORE PURCHASE CENTRE DATA"],
  ["ADMIN AI WORKBENCH", "GEMINI / OPENAI STRUCTURED DRAFTS", "GOOGLE AI / OPENAI", "CONFIGURED IN VERCEL"],
  ["PARSER AI FALLBACK", "OPENAI RESPONSES API / GPT-5.4-MINI", "OPENAI", "OPENAI_API_KEY IN VERCEL"],
  ["TRANSACTIONAL EMAIL", "EXCHANGE SMTP", "MICROSOFT 365", "INFO@COSULICH.COM.HK"],
  ["MAPS", "LEAFLET / MAPTILER RASTER TILES", "MAPTILER", "PUBLIC CLIENT KEY"],
] as const

const DATABASE_GROUPS = [
  {
    title: "ADMINISTRATION",
    tables: ["admins", "admin_users", "admin_role_defaults", "audit_logs"],
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
    title: "CONTACT SOURCES",
    tables: [
      "phonebook_contacts",
      "phonebook_companies",
      "shared_addressbook_contacts",
      "shared_addressbook_groups",
      "shared_addressbook_group_members",
    ],
  },
  {
    title: "EXCHANGE EVIDENCE",
    tables: [
      "outlook_exchange_sync_queue",
      "outlook_exchange_sync_certifications",
      "outlook_exchange_truth_snapshots",
      "outlook_exchange_truth_ledger",
      "outlook_exchange_sync_lock (ephemeral)",
    ],
  },
  {
    title: "BACKUP RELIABILITY",
    tables: [
      "bunker_map_backup_lock (ephemeral)",
    ],
  },
  {
    title: "OPERATIONS",
    tables: ["office_calendar_store", "email_templates", "ports", "remarks", "price_history"],
  },
  {
    title: "MESSAGING AND PARSING",
    tables: ["whatsapp_conversations", "whatsapp_messages", "parser_reports"],
  },
  {
    title: "SPC",
    tables: [
      "spc_users",
      "spc_enquiries",
      "spc_fixtures",
      "spc_suppliers",
      "spc_presentation_chunks",
      "office_calendar_store: spc-permission-groups",
    ],
  },
] as const

const RELIABILITY_MODEL = [
  [
    "AUTHORITATIVE STATE",
    "SHARED_ADDRESSBOOK_* TABLES + AUDIT_LOGS",
    "FCUNO WINS. EXCHANGE IS REBUILDABLE AND NEVER WRITES BACK TO FCUNO.",
  ],
  [
    "CHANGE DELIVERY",
    "OUTLOOK_EXCHANGE_SYNC_QUEUE",
    "TRANSACTIONAL OUTBOX WITH VERIFIED COMPLETION, RETRIES, AND DURABLE ERROR HISTORY.",
  ],
  [
    "IMMUTABLE EVIDENCE",
    "OUTLOOK_EXCHANGE_TRUTH_LEDGER + SNAPSHOTS",
    "CONTENT-ADDRESSED CANONICAL JSON AND A PREVIOUS-HASH SHA-256 LEDGER.",
  ],
  [
    "FULL CERTIFICATION",
    "OUTLOOK_EXCHANGE_SYNC_CERTIFICATIONS",
    "ACCEPTED ONLY AFTER EXACT CONTACT, GROUP, MEMBERSHIP, SOURCE-FENCE, AND SETTLED-QUEUE VERIFICATION.",
  ],
  [
    "INDEPENDENT ANCHORS",
    "EXCHANGE NOTICE + VERIFIED GOOGLE DRIVE BACKUP",
    "LEDGER HEAD AND PROJECTION HASHES ARE RECORDED OUTSIDE THE PRODUCTION DATABASE.",
  ],
  [
    "HEALTH GATE",
    "SYSTEM HEALTH + CHECKPOINT / FULL-VERIFIER RPCS",
    "NO GREEN STATE WITH AN INVALID CHAIN, MISSING REFERENCES, MISSING PROJECTION EVIDENCE, OR UNRESOLVED QUEUE.",
  ],
  [
    "RECOVERY",
    "SUPABASE MANAGED BACKUP / PITR OR OWNER-LEVEL PG_DUMP",
    "JSON RESTORE IS REFUSED. RESTORE FCUNO FIRST, THEN REBUILD EXCHANGE FROM FCUNO.",
  ],
  [
    "TRUST BOUNDARY",
    "DATABASE OWNER / CLOUD ADMINISTRATOR",
    "PRIVILEGED ACCESS REMAINS A RISK; INDEPENDENT EMAIL AND DRIVE ANCHORS MAKE DATABASE-ONLY REWRITES DETECTABLE.",
  ],
] as const

const SCHEDULES = [
  ["SUPABASE DATA BACKUP", "DAILY 19:00 UTC", "VERCEL CRON", "GOOGLE DRIVE / VERIFIED V2 / 35-DAY WINDOW"],
  ["EXCHANGE INCREMENTAL DELIVERY", "HOURLY AT :31 HKT + FCUNO WEBHOOK", "AZURE AUTOMATION", "DURABLE QUEUE / RETRY / VERIFIED CHECKPOINT NOTICE"],
  ["EXCHANGE FULL RECONCILIATION", "DAILY 04:10 HKT + ON DEMAND", "AZURE AUTOMATION", "EXACT PROJECTION CERTIFICATION"],
  ["CCINFO FILE BACKUP", "DAILY 00:00 UTC", "GOOGLE CLOUD SCHEDULER", "GCS / VERSIONED"],
  ["SYSTEM HEALTH EMAIL", "DAILY 00:30 UTC", "VERCEL CRON", "WARNING OR ERROR ONLY"],
  ["EVENT REMINDERS", "DAILY 00:00 UTC", "VERCEL CRON", "08:00 HONG KONG"],
  ["TASK REMINDERS", "DAILY 00:00 UTC", "VERCEL CRON", "08:00 HONG KONG"],
] as const

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
            <div><span>FUNCTION REGION</span><strong>{data?.deployment.functionRegion?.toUpperCase() || "BOM1"}</strong></div>
            <div><span>DATABASE MIGRATION</span><strong>{data?.databaseInventory.migrationHead || "-"}</strong></div>
            <div><span>LIVE PUBLIC TABLES</span><strong>{data?.databaseInventory.tables.length ?? "-"}</strong></div>
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
          <div className={styles.sectionTitle}>
            <h2>LIVE PUBLIC DATABASE INVENTORY</h2>
            <span>MIGRATION {data?.databaseInventory.migrationHead || "LOADING"}</span>
          </div>
          <div className={styles.inventoryList}>
            {(data?.databaseInventory.tables || []).map((table) => <code key={table}>{table}</code>)}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2>SOURCE OF TRUTH AND RECOVERY</h2>
            <span>FCUNO IS AUTHORITATIVE</span>
          </div>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>CONTROL</th><th>IMPLEMENTATION</th><th>RELIABILITY CONTRACT</th></tr></thead>
              <tbody>{RELIABILITY_MODEL.map((row) => <tr key={row[0]}>{row.map((cell) => <td key={cell}>{cell}</td>)}</tr>)}</tbody>
            </table>
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
            <p>DATABASE BACKUPS: COMPLETE VERIFIED V2 ARTIFACTS ARE CREATED DAILY. VERIFIED FILES LESS THAN 35 DAYS OLD ARE RETAINED; OLDER VERIFIED FILES ARE MOVED TO DRIVE TRASH.</p>
            <p>EACH V2 ARTIFACT VERIFIES THE LIVE TABLE INVENTORY, PER-SECTION HASHES, EXACT UPLOADED BYTES, EXCHANGE TRUTH EVIDENCE, AND ITS IMMEDIATE VERIFIED PREDECESSOR.</p>
            <p>MANAGED SUPABASE BACKUP / PITR AVAILABILITY IS PLAN-DEPENDENT AND MUST BE CONFIRMED IN THE SUPABASE DASHBOARD BEFORE AN INCIDENT.</p>
            <p>BACKUPS CONTAIN BUSINESS AND PERSONAL DATA. ACCESS MUST REMAIN RESTRICTED; ADMIN AND SPC PASSWORD HASHES ARE EXCLUDED FROM THE JSON ARTIFACT.</p>
            <p>DETAILED RESTORE AND REHEARSAL PROCEDURE: DOCS/BACKUP-RESTORE-RUNBOOK.MD IN THE SOURCE REPOSITORY.</p>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2>KEY AND SECRET REGISTER</h2>
            <span>VALUES ARE NEVER EXPOSED</span>
          </div>
          <div className={styles.secretGrid}>
            {(data?.secrets || []).map((secret) => (
              <article key={`${secret.storage}:${secret.name}`}>
                <div>
                  <h3>{secret.name}</h3>
                  <p>{secret.storage}</p>
                </div>
                <span
                  className={
                    secret.configured === null
                      ? styles.unverified
                      : secret.configured
                        ? styles.configured
                        : styles.missing
                  }
                >
                  {secret.configured === null
                    ? "VERIFY IN AZURE"
                    : secret.configured
                      ? "CONFIGURED"
                      : "NOT CONFIGURED"}
                </span>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.securityNotice}>
          <h2>SECRET HANDLING</h2>
          <p>
            PASSWORDS, PRIVATE KEYS, OAUTH REFRESH TOKENS, CERTIFICATES, AND API KEY VALUES ARE STORED ONLY IN
            VERCEL ENVIRONMENT VARIABLES, AZURE AUTOMATION SECRET VARIABLES / CERTIFICATE ASSETS, OR GOOGLE SECRET
            MANAGER. AZURE WORKER ASSETS ARE NOT INTROSPECTED BY THIS PAGE. SECRET VALUES ARE INTENTIONALLY NOT
            DISPLAYED OR SAVED IN THIS APPLICATION, GITHUB, OR THE LOCAL WORKSPACE.
          </p>
        </section>
      </main>
    </div>
  )
}
