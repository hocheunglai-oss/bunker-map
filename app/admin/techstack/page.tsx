"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { DEFAULT_PARSER_AI_MODEL } from "@/lib/parserAiConfig"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"
import { isTechStackResponse, type TechStackResponse } from "@/lib/techStackClient"
import exchangePublicationBaseline from "@/scripts/azure-automation/exchange-publication-baseline.json"
import styles from "./techStack.module.css"

const SERVICES = [
  ["APPLICATION", "NEXT.JS 16 / REACT 19 / TYPESCRIPT", "VERCEL", "FCUNO.COM"],
  ["PERFORMANCE MONITORING", "SPEED INSIGHTS / WEB ANALYTICS", "VERCEL", "REAL-USER CORE WEB VITALS"],
  ["SOURCE CONTROL", "GIT / GITHUB", "GITHUB", fcunoConnectionPolicy.github.repository],
  ["PRIMARY DATABASE", "POSTGRESQL 17 (17.6.1.084 VERIFIED 2026-10-22)", "SUPABASE", `PROJECT ${fcunoConnectionPolicy.supabase.projectRef}`],
  ["DATABASE LOGICAL ARCHIVE", "MUTATION-FENCED PAGED JSON V2 / BROTLI-BOUNDED TEMP STAGING / STREAMED JSON UPLOAD / SHA-256 PREDECESSOR CHAIN", "VERCEL / GOOGLE DRIVE", "LATEST TWO VERIFIED ARTIFACTS; NOT A FULL-DATABASE RESTORE IMAGE"],
  ["PRIVATE DATABASE REHEARSAL", "ONE-TIME FULL LOGICAL POSTGRESQL EXPORT AND ISOLATED RESTORE", "PRIVATE LOCAL RECOVERY HOST", "COMPLETED 2026-10-23; 126 FULL-TABLE FINGERPRINTS / ORIGINAL METADATA / EIGHT SEQUENCE STATES MATCHED; NOT RECURRING OR A STORAGE-FILE RESTORE"],
  ["OFFLINE ARCHIVE VALIDATION", "NODE 24 / STREAMED JSON / PRIVATE SQLITE SPOOL / BOUNDED DIAGNOSTICS", "LOCAL RECOVERY HOST", "FULL 2.535 GB SYNTHETIC ARCHIVE TESTED UNDER 256 MB HEAP; NOT A HOSTED-ARTIFACT OR RESTORE PROOF"],
  ["FILE SOURCE", "GOOGLE DRIVE", "GOOGLE WORKSPACE", "WIDER.CUSTOM@GMAIL.COM"],
  ["DRIVE FILE BACKUP", "GOOGLE CLOUD STORAGE", "GOOGLE CLOUD", "BUNKER-MAP-DRIVE-UPLOADER"],
  ["UPLOADED MEDIA SNAPSHOT", "ONE-TIME SUPABASE STORAGE BYTE COPY", "GOOGLE CLOUD STORAGE", "VERIFIED 2026-10-21; 15 FILES / 224,309,367 BYTES; NOT RECURRING OR MONITORED BY SYSTEM HEALTH"],
  ["BACKUP RUNNER", "CLOUD RUN JOB", "GOOGLE CLOUD", "US-CENTRAL1"],
  ["BACKUP SCHEDULER", "CLOUD SCHEDULER", "GOOGLE CLOUD", "DAILY"],
  ["PHONEBOOK SYNC", "CARDDAV / NEXTCLOUD", "THE GOOD CLOUD", "USE22.THEGOOD.CLOUD"],
  ["CALENDAR SYNC", "GOOGLE CALENDAR API", "GOOGLE", "FCB.BUNKER@GMAIL.COM"],
  ["ADMIN SESSION SECURITY", "RANDOM SERVER SESSION / SHA-256 TOKEN / RENEWABLE 400-DAY BROWSER-MAXIMUM PERSISTENCE / ATOMIC LINKED-SPC REVOCATION ON FCUNO LOGOUT / FORCED PASSWORD ROTATION", "SUPABASE / HTTPONLY COOKIE", "ACTIVE USE RENEWS HOURLY UNTIL LOGOUT; DORMANT SESSIONS EXPIRE; FCUNO LOGOUT ALSO REVOKES EVERY SPC SESSION FOR THE LINKED IDENTITY; PASSWORD CHANGE, ACCOUNT DISABLEMENT, OR REVOCATION FAILS CLOSED; ADMIN_SESSIONS IS EPHEMERAL AND NEVER BACKED UP"],
  ["MAIL DIRECTORY", "FCUNO AUTHORITY / EXCHANGE ONLINE PROJECTION / EXACT CERTIFIED GROUP SMTP", "MICROSOFT 365", "CANONICAL GROUP DOMAIN COSULICH1.ONMICROSOFT.COM; AZURE VARIABLE MUST MATCH"],
  ["EXCHANGE TRUTH EVIDENCE", "TRANSACTIONAL OUTBOX / CANONICAL SNAPSHOTS / SHA-256 LEDGER", "SUPABASE", "FULL EXACT-MATCH CERTIFICATION"],
  ["EXCHANGE WORKER", "POWERSHELL RUNBOOK / BOUNDED REST WAITS AND VERIFICATION BUDGETS / QUIET TRANSIENT RECOVERY / SIMPLE ACTIONABLE EMAILS / ATOMIC CERTIFICATION AND TEMPLATE ACTIVATION", "AZURE AUTOMATION", `${exchangePublicationBaseline.workerVersion.toUpperCase()}; PUBLISHED BYTES VERIFIED ${exchangePublicationBaseline.verifiedAt}; DATED RECORD, NOT A LIVE AZURE QUERY`],
  ["OUTLOOK TEMPLATE SOURCE", "EMAIL_TEMPLATES ONLY / TRANSACTIONAL RPC / OPTIMISTIC REVISION / RESTRICTED FILE:///H:/ LINK COMPATIBILITY", "SUPABASE", "AUDITED CANONICAL LIBRARY; LEGACY STORE ARCHIVED; WEB, MAIL, TEL, AND FCUNO H-DRIVE TEMPLATE LINKS SURVIVE SAFE NORMALISATION"],
  ["OUTLOOK ADD-IN ACCESS", "OFFICE DIALOG API / HTTP-ONLY PARTITIONED 400-DAY SESSION / AUTOMATIC LEGACY-SESSION MIGRATION / NON-CACHEABLE TASKPANE AND AUTH SHELL / MANUAL SIGN-OUT / SUPPORTED READ-MODE NEW-MESSAGE FORM / GUARDED BLANK-COMPOSE INSERT / COALESCED TEMPLATE DETAIL + CERTIFIED DIRECTORY PRELOAD / TWO-PHASE APPEND-ONLY INSERT AUDIT", "NEXT.JS / OFFICE.JS / OUTLOOK WEB", "FROM A BLANK NEW MAIL, THE TEMPLATE FILLS THE CURRENT EDITABLE MESSAGE WITH FULL HTML AND CERTIFIED RECIPIENTS WITHOUT A CONFIRMATION OR DRAFTS DETOUR; FROM READ MODE, OUTLOOK OPENS A SEPARATE NEW MESSAGE; EXISTING USER CONTENT IS NEVER OVERWRITTEN; PARTIAL FAILURES RESTORE THE VERIFIED SNAPSHOT; NO GRAPH DRAFT OR MICROSOFT TOKEN PROMPT; PASSWORD CHANGE, ACCOUNT DISABLEMENT, REVOCATION, OR PERMISSION REMOVAL FAILS CLOSED"],
  ["OUTLOOK RECIPIENT TRUTH", "STABLE FCUNO IDS / CERTIFIED EXACT EXCHANGE ADDRESSES / DEEP DATABASE GUARD", "SUPABASE / EXCHANGE ONLINE", "RECENT INTACT CERTIFICATION REMAINS USABLE DURING NORMAL QUEUED DELIVERY; FAILED, STALE OR INVALID EVIDENCE FAILS CLOSED; SIX SERVER-ONLY RPCS HAVE BOUNDED 20-SECOND DEADLINES"],
  ["RELIABILITY MONITORING", "LIVE INVENTORY / FULL STREAMED BACKUP + PREDECESSOR BYTE VERIFICATION / EXCHANGE VERIFIER", "SYSTEM HEALTH", "/ADMIN/SYSTEMHEALTH"],
  ["SALESFORCE DATA", "EXTERNAL DATA PORTAL", "FCOS", fcunoConnectionPolicy.federation.fcos.productionOrigin],
  ["SINGAPORE PURCHASING CENTER", "NEXT.JS SUBDOMAIN APP / LINKED FCUNO IDENTITY / SEPARATE SPC PERMISSIONS", "VERCEL", fcunoConnectionPolicy.vercel.productionOrigins[1]],
  ["SPC SUPPLIER DATABASE", "GOOGLE SHEETS READ SOURCE / ATOMIC SECTION-VERSIONED SUPABASE OVERRIDES / TRANSACTIONAL AUDIT", "GOOGLE WORKSPACE / SUPABASE", "SPC-SUPPLIER-OVERRIDES; UNRELATED EDITS SURVIVE; STALE DRAFTS ARE PRESERVED; SAVE RECEIPTS RETAINED FOR THE LATEST 256 OPERATIONS"],
  ["IDENTITY FEDERATION", "FCUNO OIDC AUTHORITY / SIGNED IDENTITY OUTBOX / FEATURE-GATED FCOS CONSUMER", "FCUNO / FCOS", "SEPARATE DATABASES; NO PASSWORD OR SESSION COPYING; FLAGS SHOWN AS PRESENCE ONLY"],
  ["BRENT MARKET DATA", "OFFICIAL FRONT-MONTH FUTURES / CONTRACT, FRESHNESS, RANGE, AND CHART VALIDATION / FAIL-CLOSED", "INTERCONTINENTAL EXCHANGE (ICE)", "/API/MARKET/BRENT / MINIMUM 15-MINUTE DELAY"],
  ["ATTENDANCE RECORDS", "IMMUTABLE DINGTALK RAW PUNCHES / 7-DAY ROLLING RECONCILIATION / MANUAL LEAVE LEDGER / AUDITED CORRECTIONS / USER-MANAGEMENT ACCESS", "SUPABASE / DINGTALK / MOREDIAN MCE-M2+", "/ADMIN/ATTENDANCERECORD"],
  ["ADMIN AI WORKBENCH", "GEMINI / OPENAI STRUCTURED DRAFTS", "GOOGLE AI / OPENAI", "CONFIGURED IN VERCEL"],
  ["PARSER AI FALLBACK", `OPENAI RESPONSES API / ${DEFAULT_PARSER_AI_MODEL.toUpperCase()}`, "OPENAI", "OPENAI_API_KEY IN VERCEL"],
  ["PARSER REVIEW QUEUES", "SHARED FCUNO / SPC REVIEW PANEL / SOURCE-SCOPED PERMISSIONS / AUDITED CORRECTIONS", "NEXT.JS / SUPABASE", "/ADMIN/PARSER-REPORTS / /SPC/PARSER-REPORTS"],
  ["OPENAI USAGE ATTRIBUTION", "PER-PAGE REQUEST / TOKEN TELEMETRY", "SUPABASE", "/ADMIN/OPENAIUSAGE"],
  ["TRANSACTIONAL EMAIL", "EXCHANGE SMTP", "MICROSOFT 365", "INFO@COSULICH.COM.HK"],
  ["MAPS", "LEAFLET / MAPTILER RASTER TILES", "MAPTILER", "PUBLIC CLIENT KEY"],
] as const

const DATABASE_GROUPS = [
  {
    title: "ADMINISTRATION",
    tables: ["admins", "admin_users", "admin_sessions (ephemeral)", "admin_role_defaults (optional; office_calendar_store fallback)", "audit_logs"],
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
      "private.bunker_map_backup_mutations (mutation fence)",
      "private.system_health_alert_incidents (release migration; private notification state, excluded from public inventory)",
    ],
  },
  {
    title: "OUTLOOK TEMPLATES",
    tables: ["email_templates (canonical + revision + recipient resolution)"],
  },
  {
    title: "OPERATIONS",
    tables: [
      "office_calendar_store (versioned shared calendar records and settings)",
      "event_calendar_google_sync_jobs (durable meeting-room outbox)",
      "ports",
      "remarks",
      "price_history",
    ],
  },
  {
    title: "ATTENDANCE",
    tables: [
      "attendance_people",
      "attendance_team_assignments (effective-dated User Management groups)",
      "attendance_raw_punches (immutable source)",
      "attendance_leave_entries",
      "attendance_manual_overrides",
      "attendance_work_mode_policies (effective-dated default work location)",
      "attendance_work_mode_overrides (manual per-day work location)",
      "attendance_entitlements",
      "attendance_monthly_adjustments (legacy opening records)",
      "attendance_monthly_confirmations",
      "attendance_reminder_dispatches",
      "attendance_sync_runs",
    ],
  },
  {
    title: "MESSAGING AND PARSING",
    tables: ["whatsapp_conversations", "whatsapp_messages", "parser_reports", "openai_usage_events"],
  },
  {
    title: "IDENTITY FEDERATION",
    tables: [
      "fcuno_identity_audit",
      "fcuno_identity_sync_outbox",
      "spc_identity_links",
      "oidc_authorization_codes (ephemeral)",
      "oidc_token_revocations (ephemeral)",
    ],
  },
  {
    title: "SPC",
    tables: [
      "spc_users",
      "spc_sessions (ephemeral)",
      "spc_enquiries",
      "spc_enquiry_revisions",
      "spc_fixtures",
      "spc_suppliers",
      "spc_feedback",
      "spc_lost_reason_options",
      "spc_mobile_modes",
      "spc_mobile_enquiry_deliveries",
      "spc_group_dispatchers",
      "spc_group_delivery_jobs",
      "spc_delivery_routes",
      "spc_presentation_chunks",
      "office_calendar_store: spc-permission-groups / spc-supplier-overrides",
      "private SPC login / MFA / rate-limit state (outside public inventory)",
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
    "ACCEPTED ONLY AFTER EXACT CONTACT, GROUP PRIMARY SMTP, MEMBERSHIP, SOURCE-FENCE, AND SETTLED-QUEUE VERIFICATION.",
  ],
  [
    "TEMPLATE RECIPIENT TRUTH",
    "EMAIL_TEMPLATES.RECIPIENT_RESOLUTION + CERTIFIED FCUNO_EXCHANGE_PROJECTION",
    "STABLE CONTACT/GROUP IDS AND EXACT CERTIFIED SMTP ADDRESSES ARE RESOLVED AT SAVE AND RECONCILED AFTER EVERY CERTIFICATION. DEEP SHAPE, SOURCE, AND QUEUE GUARDS FAIL CLOSED.",
  ],
  [
    "TEMPLATE WRITE SAFETY",
    "TRANSACTIONAL REPLACEMENT + SERVER REVISION",
    "NO EMPTY-TABLE WINDOW. STALE EDITORS RECEIVE A CONFLICT AND KEEP THEIR DRAFT UNTIL EXPLICIT RELOAD OR CHANGED-FIELD REAPPLICATION; COLLEAGUE EDITS ARE NOT SILENTLY OVERWRITTEN.",
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
    "DATED PRIVATE LOGICAL DATABASE REHEARSAL COMPLETED 2026-10-23; MANAGED RESTORE AND PRODUCTION CUTOVER WERE NOT TESTED. JSON ARTIFACTS ALONE CANNOT RESTORE THE WHOLE DATABASE; JSON RESTORE IS REFUSED. RESTORE FCUNO FIRST, THEN REBUILD EXCHANGE FROM FCUNO.",
  ],
  [
    "TRUST BOUNDARY",
    "DATABASE OWNER / CLOUD ADMINISTRATOR",
    "PRIVILEGED ACCESS REMAINS A RISK; INDEPENDENT EMAIL AND DRIVE ANCHORS MAKE DATABASE-ONLY REWRITES DETECTABLE.",
  ],
] as const

const EXTERNAL_SCHEDULES = [
  ["EXCHANGE INCREMENTAL DELIVERY", "HOURLY AT :31 HKT + FCUNO WEBHOOK", "AZURE AUTOMATION", "VERIFIED 2026-10-14; DATED OBSERVATION, NOT A LIVE SCHEDULE QUERY"],
  ["EXCHANGE FULL RECONCILIATION", "DAILY 06:10 HKT + ON DEMAND", "AZURE AUTOMATION", "VERIFIED 2026-10-14; OLD 04:10 / 17:33 SCHEDULES DISABLED"],
  ["CCINFO FILE BACKUP", "02:00 HKT; RETRIES 03:00 / 04:00 / 05:00; STOP 06:00", "GOOGLE CLOUD SCHEDULER", "LIVE-VERIFIED 2026-09-23; GCS / VERSIONED; SUCCESSFUL RUN SKIPS LATER RETRIES"],
] as const

const CRON_DESCRIPTIONS: Record<string, readonly [string, string]> = {
  "/api/backups/bunker-map-drive": ["DATABASE LOGICAL ARCHIVE", "03:02 HKT PRIMARY; 04:02 / 05:02 RETRIES / LATEST TWO VERIFIED ARTIFACTS"],
  "/api/cron/attendance-sync": ["ATTENDANCE RECONCILIATION", "EVERY 15 MINUTES / ROLLING SEVEN DAYS"],
  "/api/cron/phonebook-carddav-reconcile": ["PHONEBOOK / CARDDAV RECONCILIATION", "EVERY FIVE MINUTES / SERVER CONTACT RECONCILIATION AND SAVED RETRIES; MAY DEFER DURING VERIFIED BACKUP; PHONE REFRESH TIMING DEPENDS ON THE DEVICE"],
  "/api/admin/system-health/notify": ["SYSTEM HEALTH CHECK / EMAIL", "08:30 HKT; RELEASE POLICY: NEW INCIDENT / ESCALATION ONLY, WITH EXISTING MUTES"],
  "/api/event-calendar/daily-reminder": ["EVENT REMINDERS", "08:00 HKT MONDAY–FRIDAY; 08:15 / 08:30 RETRIES USE THE SAME OCCURRENCE RECEIPT"],
  "/api/task-calendar/daily-reminder": ["TASK REMINDERS", "08:00 HKT DAILY; 08:15 / 08:30 RETRIES USE THE SAME OCCURRENCE RECEIPT"],
  "/api/event-calendar/google-sync": ["MEETING-ROOM SYNC OUTBOX", "EVERY MINUTE / DURABLE GOOGLE CALENDAR DELIVERY"],
  "/api/cron/attendance-month-end-reminder": ["ATTENDANCE CONFIRMATION / ANNUAL REMINDER CHECK", "08:00 HKT DAILY CHECK; MONTHLY EMAIL ON FIRST HONG KONG WORKING DAY; NO REPEAT REMINDER"],
  "/api/cron/attendance-auto-confirm": ["ATTENDANCE AUTO-CONFIRM CHECK", "18:10 HKT DAILY CHECK AFTER THE 18:00 DEADLINE; UNCONFIRMED MONTH AUTO-CONFIRMS ON THIRD HONG KONG WORKING DAY; DISPUTES REMAIN POSSIBLE"],
  "/api/spc/security-maintenance": ["SPC SECURITY MAINTENANCE", "02:17 HKT DAILY / EXPIRED SECURITY STATE CLEANUP"],
  "/api/cron/spc-mobile-deliveries": ["SPC MOBILE / GROUP DELIVERY", "EVERY MINUTE / DURABLE DELIVERY QUEUES"],
  "/api/cron/fcos-identity-sync": ["FCOS IDENTITY SYNC", "EVERY FIVE MINUTES / FEATURE-GATED SIGNED OUTBOX"],
}

export default function TechStackPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role } = useSimpleAdminAuth()
  const [data, setData] = useState<TechStackResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState("")
  const requestController = useRef<AbortController | null>(null)
  const lastVerifiedData = useRef<TechStackResponse | null>(null)
  const canView = isAdminRole(role) || canAccessAdminPage(permissions, "tech-stack", "view")

  const loadData = useCallback(async () => {
    if (!authenticated || !canView) return
    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    setLoading(true)
    setMessage("")
    try {
      const response = await fetch("/api/admin/tech-stack", { cache: "no-store", signal: controller.signal })
      const result: unknown = await response.json()
      if (controller.signal.aborted || requestController.current !== controller) return
      if (!response.ok || !isTechStackResponse(result)) throw new Error("Current system details are unavailable.")
      lastVerifiedData.current = result
      setData(result)
    } catch {
      if (controller.signal.aborted || requestController.current !== controller) return
      setMessage(lastVerifiedData.current
        ? "Current system details could not be refreshed. The last loaded values are shown below."
        : "Current system details are unavailable. Please retry.")
    } finally {
      if (requestController.current === controller) {
        requestController.current = null
        setLoading(false)
      }
    }
  }, [authenticated, canView])

  useEffect(() => {
    document.title = "TECH STACK - FC Uno"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.push("/admin")
  }, [authLoading, authenticated, canView, router])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadData(), 0)
    return () => {
      window.clearTimeout(initialLoad)
      requestController.current?.abort()
      requestController.current = null
    }
  }, [loadData])

  if (authLoading || !authenticated || !canView) {
    return <div className={styles.page}>LOADING...</div>
  }
  const unavailable = loading ? "LOADING" : "UNAVAILABLE"

  return (
    <div className={styles.page}>
      <main className={styles.shell}>
        {message ? <div className={styles.error} role="alert">{message}</div> : null}

        <section className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2>CURRENT DEPLOYMENT</h2>
            <button className={styles.refreshButton} type="button" onClick={() => void loadData()} disabled={loading}>
              {loading ? "REFRESHING..." : "REFRESH"}
            </button>
          </div>
          <div className={styles.factGrid}>
            <div><span>PLATFORM</span><strong>{data?.deployment.platform || "VERCEL"}</strong></div>
            <div><span>PROJECT</span><strong>{data?.deployment.project || fcunoConnectionPolicy.vercel.project}</strong></div>
            <div><span>PRODUCTION DOMAIN</span><strong>{fcunoConnectionPolicy.vercel.productionOrigins[0]}</strong></div>
            <div><span>GITHUB</span><strong>{data?.deployment.gitRepository || fcunoConnectionPolicy.github.repository}</strong></div>
            <div><span>ENVIRONMENT / BRANCH</span><strong>{data ? `${data.deployment.environment} / ${data.deployment.branch}` : unavailable}</strong></div>
            <div><span>COMMIT</span><strong>{data?.deployment.commit?.slice(0, 7) || "-"}</strong></div>
            <div><span>OBSERVED FUNCTION REGION</span><strong>{data?.deployment.functionRegion?.toUpperCase() || "UNKNOWN"}</strong></div>
            <div><span>DATABASE MIGRATION</span><strong>{data?.databaseInventory.migrationHead || "-"}</strong></div>
            <div><span>LIVE PUBLIC TABLES</span><strong>{data?.databaseInventory.tables.length ?? "-"}</strong></div>
          </div>
          <div className={styles.notes}>
            <p>RESPONSE GENERATED: {data?.generatedAt || unavailable}. THIS IS NOT AN INFRASTRUCTURE VERIFICATION TIME.</p>
            <p>PUBLIC DATABASE INVENTORY CHECKED: {data?.databaseInventory.checkedAt || unavailable}. CONFIGURED FUNCTION REGIONS: {data?.deployment.configuredRegions.join(", ") || unavailable}.</p>
            <p>DESCRIPTIONS BELOW DOCUMENT THIS RELEASE&apos;S SOURCE CONFIGURATION. EXTERNAL LIVE CHECKS ARE DATED SEPARATELY; UNKNOWN SETTINGS ARE NOT CERTIFIED.</p>
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
          <div className={styles.sectionTitle}><h2>DATABASE ARCHITECTURE</h2><span>SOURCE SUMMARY; NOT THE LIVE INVENTORY</span></div>
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
            <span>MIGRATION {data?.databaseInventory.migrationHead || unavailable}</span>
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
              <tbody>
                {(data?.schedules || []).map(({ path, schedule }) => {
                  const [label, policy] = CRON_DESCRIPTIONS[path] || [path, "SEE ROUTE IMPLEMENTATION"]
                  return <tr key={`${path}:${schedule}`}><td>{label}<br /><code>{path}</code></td><td>{schedule} (UTC CRON)</td><td>VERCEL.JSON — THIS RELEASE</td><td>{policy}</td></tr>
                })}
                {EXTERNAL_SCHEDULES.map((row) => <tr key={row[0]}>{row.map((cell) => <td key={cell}>{cell}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
          <div className={styles.notes}>
            <p>CCINFO FILE-BACKUP SCOPE: THE CONFIGURED DRIVE TREE. SYSTEM HEALTH CHECKS COVERAGE OF ACTIVE DATABASE FILE REFERENCES; UNSUPPORTED EXPORTS ARE NOT COUNTED AS PROTECTED.</p>
            <p>GCS LIVE-VERIFIED 2026-09-23: US-CENTRAL1; VERSIONING ENABLED; DELETE RULE IS AGE 30 DAYS AND NONCURRENT. AGE IS MEASURED FROM OBJECT CREATION, NOT WHEN IT BECAME NONCURRENT; THIS DOES NOT GUARANTEE 30 DAYS OF ROLLBACK HISTORY. SOFT DELETE: SEVEN DAYS.</p>
            <p>DATABASE LOGICAL ARCHIVES: DAILY PRIMARY AND TWO RETRY SLOTS. KEEP THE LATEST TWO VERIFIED V2 ARTIFACTS; OLDER VERIFIED ARTIFACTS ARE PERMANENTLY DELETED AFTER A REPLACEMENT PASSES THE UPLOAD RECEIPT CHECK. FAILED OR ORPHANED UPLOADS MAY BE MOVED TO DRIVE TRASH.</p>
            <p>PRESENTATION MEDIA — VERIFIED 2026-10-21: ONE-TIME PRIVATE GOOGLE CLOUD STORAGE COPY OF ALL 15 FILES (224,309,367 BYTES); TWO READ-BACK CHECKS MATCHED THE COPIED BYTES. TEMPORARY SOURCE ACCESS IS OFF; NO RECURRING MEDIA BACKUP IS SCHEDULED. THE COPY IS MAPPED TO THE TWO DATABASE ARCHIVES RETAINED AT THE TIME. AT THAT DATE, DATABASE-TO-FILE CORRESPONDENCE AND HISTORICAL FILE-VERSION RECOVERY HAD NOT BEEN VERIFIED; SEE THE SEPARATE 2026-10-23 CORRESPONDENCE CHECK BELOW. SYSTEM HEALTH DOES NOT MONITOR THIS MEDIA SNAPSHOT.</p>
            <p>DATABASE-TO-FILE CORRESPONDENCE — VERIFIED 2026-10-23 AT 08:16 UTC: ALL 15 FILE IDENTITIES, VERSIONS AND SIZES (224,309,367 BYTES) RECORDED BY THE V9 LOGICAL DATABASE SNAPSHOT EXACTLY MATCHED THE INVENTORY OF THE IMMUTABLE COPIES BYTE-VERIFIED ON 2026-10-21. THIS WAS AN OFFLINE METADATA COMPARISON, NOT A NEW CLOUD AVAILABILITY CHECK OR STORAGE-BYTE RESTORE. OLDER DATABASE SNAPSHOTS, NEW UPLOADS AFTER V9 AND HISTORICAL FILE-VERSION RECOVERY REMAIN UNPROVED. NO RECURRING MEDIA BACKUP OR SYSTEM HEALTH MONITORING WAS ADDED.</p>
            <p>PRIVATE LOGICAL DATABASE REHEARSAL — COMPLETED 2026-10-23: A ONE-TIME PRIVATE FULL POSTGRESQL EXPORT WAS RESTORED IN AN ISOLATED LOCAL DATABASE. 126 FULL-TABLE FINGERPRINTS, ORIGINAL METADATA AND EIGHT SEQUENCE STATES MATCHED; ALL 2,155 ARCHIVE ENTRIES WERE ACCOUNTED FOR. NATIVE TLS ON BOTH SOURCE CONNECTION HOPS WAS VERIFIED. SOURCE ROLE COPIES REMAINED NOLOGIN; LOCAL POSTGRESQL 17.11 WAS NOT A PRODUCTION UPGRADE. PRODUCTION REMAINS ON 17.6. THIS WAS NOT A RECURRING POSTGRESQL BACKUP, MANAGED PHYSICAL/PITR RESTORE, WHOLE HOSTED SUPABASE RECOVERY OR STORAGE-FILE RECOVERY. IT DOES NOT ESTABLISH A PRODUCTION RECOVERY-TIME GUARANTEE. THIS IS DATED EVIDENCE, NOT A LIVE CHECK; SEE THE RESTORE RUNBOOK FOR THE REDACTED RECEIPT AND LIMITS.</p>
            <p>V2 EXPORT CHECKS THE LIVE TABLE INVENTORY, MUTATION FENCE, SECTION HASHES AND EXCHANGE TRUTH EVIDENCE. A NEW UPLOAD MUST MATCH DRIVE&apos;S MD5 AND SIZE RECEIPTS BEFORE IT IS MARKED VERIFIED. SHA-256 FULL READBACK CHECKS THE PREDECESSOR DURING EXPORT AND THE LATEST ARTIFACT DURING SYSTEM HEALTH; IT IS NOT A NEW-ARTIFACT READBACK BEFORE PRUNING.</p>
            <p>FILE-BACKUP ALERT RELEASE POLICY: NEW FILES HAVE UNTIL THE NEXT OVERNIGHT BACKUP DEADLINE; NOTIFICATION STATE DEDUPLICATES AN ONGOING INCIDENT AND ALLOWS ESCALATION AFTER 48 HOURS WITHOUT VERIFIED SUCCESS. THE PRIVATE INCIDENT MIGRATION AND APPLICATION RELEASE MUST BOTH BE ACTIVE; THIS PAGE DOES NOT CERTIFY ROLLOUT COMPLETION.</p>
            <p>DATABASE-BACKUP ALERT POLICY: NORMAL OVERNIGHT WAITING AND UNVERIFIED CHECKS DO NOT SEND FAILURE EMAILS OR CLEAR AN EXISTING INCIDENT. A MISSING OR OVERDUE VERIFIED BACKUP, OR SYSTEM CHANGES STILL UNCOVERED AFTER THEIR DEADLINE, CAN NOTIFY ONCE; PERSISTENT PROTECTION GAPS ESCALATE AFTER 48 HOURS. REAL INTEGRITY ERRORS REMAIN ACTIONABLE. SYSTEM HEALTH SHOWS THE CURRENT EVIDENCE AND DEADLINE.</p>
            <p>GOOGLE CLOUD COST CONTROL — VERIFIED 2026-09-24: PROJECT MONTHLY ALERT BUDGET HKD77.50 (CONSERVATIVE APPROXIMATION OF USD10). SEPARATE CLOUD RUN MONTHLY SPEND CAP HKD77.50: CONFIGURED, NOT CURRENTLY ENFORCED; NOTIFICATIONS AT 50%, 80% AND 100%. THE CAP USES GROSS ESTIMATED COSTS AND MAY PAUSE NEW BACKUP JOBS UNTIL MANUALLY LIFTED. A CLOUD RUN SPEND CAP DOES NOT CAP STORAGE CHARGES OR GUARANTEE AN EXACT TOTAL BILL; ENFORCEMENT CAN LAG. AN ALERTS-ONLY BUDGET DOES NOT STOP SPENDING.</p>
            <p>GCS FOOTPRINT — VERIFIED 2026-09-24: APPROXIMATELY 8.53 GIB INCLUDING LIVE, NONCURRENT AND SOFT-DELETED OBJECTS. THE SOURCE MANIFEST&apos;S 3.90 GIB ESTIMATE IS NOT TOTAL BILLED STORAGE; NO CLEANUP WAS PERFORMED.</p>
            <p>EXCHANGE DATED LIVE CHECK — {exchangePublicationBaseline.verifiedAt}: ACCOUNT FCUNO-EXCHANGE-SYNC; RUNBOOK SYNC-FCUNO-OUTLOOKADDRESSBOOK; PUBLISHED WORKER {exchangePublicationBaseline.workerVersion.toUpperCase()} WAS EXPORTED AND MATCHED THE REVIEWED REPOSITORY BYTES; POWERSHELL {exchangePublicationBaseline.azure.runtimeVersion} / EXCHANGEONLINEMANAGEMENT {exchangePublicationBaseline.azure.exchangeModuleVersion}. THIS VERIFIES PUBLISHED SOURCE AND RUNTIME, NOT A SUBSEQUENT LIVE FULL EXCHANGE VERIFICATION. THIS PAGE DOES NOT RECHECK AZURE AT LOAD TIME. HOURLY :31 AND DAILY 06:10 HKT SCHEDULES WERE LAST VERIFIED ON 2026-10-14. THE WEBHOOK EXPIRY 2035-05-29 IS AN OLDER JULY RECORD, NOT REVERIFIED.</p>
            <p>EXCHANGE RENEWAL — THIS RELEASE&apos;S SOURCE POLICY: WHEN THE QUEUE IS SETTLED, HOURLY INCREMENTAL RUNS REQUEST GENUINE FULL READ-ONLY VERIFICATION AT 24 HOURS, BEFORE THE UNCHANGED 36-HOUR ACCEPTANCE LIMIT. SETTLED DELIVERIES AND SOURCE/PROOF GAPS ALSO REQUEST FULL VERIFICATION; DERIVED-TEMPLATE-ONLY RECOVERY REUSES VALID EVIDENCE. OTHERWISE A CURRENT, UNCHANGED RUN CAN SKIP THE EXCHANGE FULL READS. THIS IS NOT A TIMESTAMP-ONLY RENEWAL OR A LIVE COMPLETION CHECK.</p>
            <p>EXCHANGE EMAIL POLICY: HEALTHY RUNS, INCLUDING SUCCESSFUL CHANGES, AND VERIFIED RECOVERY ARE SILENT. TEMPORARY DELIVERY OR FULL-VERIFICATION DELAYS, BUDGET LIMITS AND EXPECTED SOURCE RACES MUST PERSIST BEFORE ALERTING. ACCESS/TERMINAL ISSUES AND GENUINE FULL-VERIFICATION FAILURES CAN ALERT IMMEDIATELY. NOTICES ARE DEDUPLICATED WITH DELIVERY RECEIPTS AND SIMPLE SUMMARIES; INTERNAL DIAGNOSTICS REMAIN IN THE SYNC RECORD.</p>
            <p>ON-DEMAND FULL CERTIFICATION STARTS IN AZURE WITH SYNCMODE FULL. THE FCUNO SYNC EXCHANGE BUTTON STARTS INCREMENTAL ONLY. RECHECK AZURE BEFORE RELYING ON THIS DATED RECORD.</p>
            <p>SUPABASE BACKUPS — API VERIFIED 2026-10-14: EIGHT PHYSICAL RESTORE POINTS LISTED FOR OCTOBER 7–14, LATEST OCTOBER 14 AT 10:04:53 HKT. THIS IS AN OBSERVED SEVEN-DAY SPAN, NOT A GUARANTEE OF EIGHT-DAY RETENTION. PITR IS NOT ENABLED IN THAT DATED OBSERVATION. MANAGED DATABASE BACKUPS EXCLUDE STORAGE OBJECT BYTES. NO RESTORE WAS RUN BY THAT CHECK; THE SEPARATE 2026-10-23 PRIVATE LOGICAL REHEARSAL DID NOT TEST MANAGED PHYSICAL/PITR RECOVERY OR PRODUCTION RECOVERY TIME.</p>
            <p>DATABASE MAINTENANCE — ENGINE RECHECKED 2026-10-22; COMPATIBILITY INVENTORY CHECKED 2026-10-16: THE PROJECT REMAINS ON 17.6.1.084. SUPABASE&apos;S 17.11 SECURITY UPDATE IS AVAILABLE. NO AFFECTED LTREE / FLOAT GIST INDEXES, NON-EXTENSION CUSTOM ESTIMATOR OPERATORS, APPLICATION PGP FUNCTION REFERENCES OR APPLICATION BYTEA COLUMNS WERE FOUND IN THAT DATED INVENTORY. THIS DOES NOT CERTIFY EXTERNAL ENCRYPTED DATA OR OLDER CLIENT TLS SUPPORT. NO ENGINE UPGRADE OR RESTORE WAS RUN BY THAT INVENTORY CHECK; ARRANGE A SEPARATE MAINTENANCE WINDOW. <a href="https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes" target="_blank" rel="noreferrer">SUPABASE UPGRADE GUIDANCE</a>.</p>
            <p>DATABASE SSL — DASHBOARD SETTING ENABLED AND PERSISTED 2026-10-22 AT 20:03:56 HKT (12:03:56 UTC). PROJECT RETURNED ACTIVE_HEALTHY; 18 LIVE APPLICATION CHECKS PASSED. NATIVE CLIENT TLS ON BOTH CONNECTION HOPS AND A WHOLE-DATABASE RESTORE ARE NOT CERTIFIED BY THIS SETTING CHECK.</p>
            <p>BACKUPS CONTAIN BUSINESS AND PERSONAL DATA. ACCESS MUST REMAIN RESTRICTED; ADMIN AND SPC PASSWORD HASHES ARE EXCLUDED FROM THE JSON ARTIFACT.</p>
            <p>DETAILED RESTORE AND REHEARSAL PROCEDURE: DOCS/BACKUP-RESTORE-RUNBOOK.MD IN THE SOURCE REPOSITORY.</p>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2>KEY AND SECRET REGISTER</h2>
            <span>VALUES ARE NEVER EXPOSED</span>
          </div>
          <div className={styles.notes}>
            <p>{data?.verification.environmentValues || "PRESENCE ONLY; CREDENTIALS ARE NOT VALIDATED. OPTIONAL SETTINGS MAY BE ABSENT."}</p>
            <p>THIS IS A SOURCE-BASED REGISTER, NOT AN EXHAUSTIVE CLOUD SECRET INVENTORY. OIDC CLIENT SECRET VARIABLE NAMES ARE DEFINED BY FCUNO_OIDC_CLIENTS_JSON; VERIFY THOSE IN VERCEL. AZURE ASSETS REQUIRE A SEPARATE LIVE CHECK.</p>
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
                    secret.configured === null || secret.configured
                      ? styles.unverified
                      : styles.missing
                  }
                >
                  {secret.status}
                </span>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.securityNotice}>
          <h2>SECRET HANDLING</h2>
          <p>
            DEPLOYMENT CREDENTIALS BELONG IN VERCEL ENVIRONMENT VARIABLES, AZURE AUTOMATION SECRET VARIABLES /
            CERTIFICATE ASSETS, OR GOOGLE SECRET MANAGER. THIS PAGE NEVER DISPLAYS SECRET VALUES, VALIDATES
            CREDENTIALS, OR INTROSPECTS AZURE / GOOGLE SECRET ASSETS. APPLICATION PASSWORD HASHES AND SESSION
            STATE HAVE THEIR OWN RESTRICTED DATABASE STORAGE; LOCAL OPERATOR CREDENTIALS MUST NOT BE COMMITTED
            TO GITHUB OR INCLUDED IN UPLOADS.
          </p>
        </section>
      </main>
    </div>
  )
}
