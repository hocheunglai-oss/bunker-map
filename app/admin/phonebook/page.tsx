"use client"

import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useIsMobile } from "@/lib/useIsMobile"

type Contact = {
  id: string
  full_name: string
  company: string | null
  company_source_id: string | null
  title: string | null
  name_remark: string | null
  position: string | null
  department: string | null
  tel_ext: string | null
  direct_line: string | null
  mobile_area: string | null
  mobile_1: string | null
  mobile_2: string | null
  personal_email: string | null
  general_email: string | null
  private_email: string | null
  instant_messaging: string | null
  others: string | null
  area_of_responsibility: string | null
  mobile_phone: string | null
  pager: string | null
  business_phone: string | null
  business_phone_2: string | null
  other_phone: string | null
  email_1: string | null
  email_2: string | null
  notes: string | null
  favorite: boolean
  search_text: string | null
}

type Company = {
  id: string
  name: string
  other_name: string | null
  phone: string | null
  address: string | null
  country: string | null
  tel_country: string | null
  tel_area: string | null
  tel_no_1: string | null
  tel_no_2: string | null
  tel_speed_dial: string | null
  fax_no_1: string | null
  website: string | null
  email: string | null
  contact_type: string | null
  stem_management: string | null
  company_status: string | null
  company_info: string | null
  seller_term: string | null
  seller_credit_limit: string | null
  seller_credit_limit_flexibility: string | null
  seller_classification: string | null
  seller_remark_1: string | null
  seller_remark_2: string | null
  seller_remark_3: string | null
  seller_remark_4: string | null
  buyer_term: string | null
  buyer_credit_limit: string | null
  buyer_credit_limit_flexibility: string | null
  buyer_classification: string | null
  buyer_remark_1: string | null
  buyer_remark_2: string | null
  buyer_remark_3: string | null
  buyer_remark_4: string | null
  notes: string | null
  source_key: string
}

type CompanyDraft = Company | null
type ChangeLogEntry = {
  id: string
  entityType: "contact" | "company"
  action: "create" | "update" | "delete"
  label: string
  timestamp: string
  before: Contact | Company | null
  after: Contact | Company | null
}

const LAST_CONTACT_SYNC_FAILED_KEY = "phonebook_last_carddav_sync_failed"
const CONTACT_ORDER_STORAGE_KEY = "phonebook_contact_order_by_company"
const PHONEBOOK_CHANGE_LOG_KEY = "phonebook_change_log"
const PHONEBOOK_CACHE_DB_NAME = "phonebook-cache"
const PHONEBOOK_CACHE_STORE = "entries"
const PHONEBOOK_COMPANIES_CACHE_KEY = "companies"
const PHONEBOOK_CONTACTS_CACHE_KEY = "contacts"
const PHONEBOOK_CONTACTS_REFRESH_MS = 30 * 60 * 1000
const INITIAL_RENDERED_COMPANIES = 120
const COMPANY_RENDER_STEP = 120
const MAX_SEARCH_RENDERED_COMPANIES = 300
const MAX_RENDERED_CONTACTS = 400

type ContactSyncFailure = {
  id: string
  label: string
  error?: string
}

type ContactSyncResponse = {
  message?: string
  failed?: ContactSyncFailure[]
  total?: number
  done?: boolean
  nextCursor?: number | null
  syncedCount?: number
  verifiedCount?: number
  phase?: "delete" | "upload"
}

type PerfStats = {
  sessionMs: number | null
  companiesFetchMs: number | null
  contactsFetchMs: number | null
  normalizeCompaniesMs: number | null
  normalizeContactsMs: number | null
  localOrderLoadMs: number | null
  localOrderBytes: number | null
  changeLogLoadMs: number | null
  changeLogBytes: number | null
  companyCount: number
  contactCount: number
  userAgent: string
}

type ContactSearchEntry = {
  companyKey: string
  haystack: string
}

type PhonebookCacheRecord<T> = {
  key: string
  savedAt: number
  items: T[]
}

const TITLE_OPTIONS = ["MR", "MS", "CP"] as const

const COUNTRY_OPTIONS = [
  { name: "ALGERIA", code: "213" },
  { name: "ARGENTINA", code: "54" },
  { name: "AUSTRALIA", code: "61" },
  { name: "BAHRAIN", code: "973" },
  { name: "BANGLADESH", code: "880" },
  { name: "BELGIUM", code: "32" },
  { name: "BRAZIL", code: "55" },
  { name: "CANADA", code: "1" },
  { name: "CHILE", code: "56" },
  { name: "CHINA", code: "86" },
  { name: "CYPRUS", code: "357" },
  { name: "DENMARK", code: "45" },
  { name: "EGYPT", code: "20" },
  { name: "FRANCE", code: "33" },
  { name: "GERMANY", code: "49" },
  { name: "GREECE", code: "30" },
  { name: "HONG KONG", code: "852" },
  { name: "INDIA", code: "91" },
  { name: "INDONESIA", code: "62" },
  { name: "IRELAND", code: "353" },
  { name: "ITALY", code: "39" },
  { name: "JAPAN", code: "81" },
  { name: "KOREA", code: "82" },
  { name: "KUWAIT", code: "965" },
  { name: "MALAYSIA", code: "60" },
  { name: "MEXICO", code: "52" },
  { name: "MONACO", code: "377" },
  { name: "NETHERLANDS", code: "31" },
  { name: "NEW ZEALAND", code: "64" },
  { name: "NORWAY", code: "47" },
  { name: "OMAN", code: "968" },
  { name: "PAKISTAN", code: "92" },
  { name: "PANAMA", code: "507" },
  { name: "PHILIPPINES", code: "63" },
  { name: "PORTUGAL", code: "351" },
  { name: "QATAR", code: "974" },
  { name: "SAUDI ARABIA", code: "966" },
  { name: "SINGAPORE", code: "65" },
  { name: "SOUTH AFRICA", code: "27" },
  { name: "SPAIN", code: "34" },
  { name: "SRI LANKA", code: "94" },
  { name: "SWEDEN", code: "46" },
  { name: "SWITZERLAND", code: "41" },
  { name: "TAIWAN", code: "886" },
  { name: "THAILAND", code: "66" },
  { name: "TURKEY", code: "90" },
  { name: "UAE", code: "971" },
  { name: "UK", code: "44" },
  { name: "UNITED ARAB EMIRATES", code: "971" },
  { name: "UNITED KINGDOM", code: "44" },
  { name: "UNITED STATES", code: "1" },
  { name: "USA", code: "1" },
  { name: "VIETNAM", code: "84" },
]

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  fontFamily: "var(--fc-admin-font)",
  color: "var(--fc-admin-panel-text)",
  padding: "18px",
}

const panelStyle: React.CSSProperties = {
  background: "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "18px",
  boxShadow: "0 12px 28px #00000010",
}

const lightBluePanelStyle: React.CSSProperties = {
  background: "var(--fc-admin-panel-soft-bg)",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "18px",
  boxShadow: "0 12px 28px #0000000f",
}

const buttonStyle: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: "999px",
  border: "1px solid var(--fc-admin-button-border)",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  textDecoration: "none",
  fontSize: "12px",
  fontWeight: 700,
  boxShadow: "none",
  cursor: "pointer",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: "14px",
  border: "1px solid var(--fc-input-border)",
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-tool-input-text)",
  fontSize: "14px",
  outline: "none",
  boxSizing: "border-box",
}

const detailInputStyle: React.CSSProperties = {
  ...inputStyle,
  fontSize: "13px",
  padding: "10px 12px",
}

const selectStyle: React.CSSProperties = {
  ...detailInputStyle,
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-admin-panel-text)",
}

const iconButtonStyle: React.CSSProperties = {
  width: "26px",
  height: "26px",
  borderRadius: "999px",
  border: "1px solid var(--fc-admin-border)",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "12px",
  fontWeight: 800,
  cursor: "pointer",
  padding: 0,
  lineHeight: 1,
  boxShadow: "none",
}

function CopyIcon({ copied = false }: { copied?: boolean }) {
  return copied ? (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14" fill="none">
      <path d="m4.5 10.5 3.3 3.3 7.7-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14" fill="none">
      <rect x="7" y="7" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-7A1.5 1.5 0 0 0 3 5.5v7A1.5 1.5 0 0 0 4.5 14H7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "#1d1d1f",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  zIndex: 80,
}

const modalCardStyle: React.CSSProperties = {
  ...panelStyle,
  width: "min(860px, 100%)",
  maxHeight: "86vh",
  overflowY: "auto",
  padding: "18px",
}

const sectionLabelStyle: React.CSSProperties = {
  color: "var(--fc-admin-link)",
  fontSize: "11px",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  marginBottom: "6px",
}

const modalSectionStyle: React.CSSProperties = {
  ...panelStyle,
  padding: "14px",
  borderRadius: "16px",
  boxShadow: "none",
}

const menuPanelStyle: React.CSSProperties = {
  ...lightBluePanelStyle,
  position: "fixed",
  top: "84px",
  right: "18px",
  padding: "12px",
  display: "grid",
  gap: "12px",
  zIndex: 40,
  width: "min(360px, calc(100vw - 36px))",
  maxHeight: "70vh",
  overflowY: "auto",
}

const sidebarPanelStyle: React.CSSProperties = {
  ...panelStyle,
  padding: "0",
  display: "grid",
  background: "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "20px",
  overflow: "hidden",
}

const listRowStyle: React.CSSProperties = {
  width: "100%",
  border: "none",
  background: "#ffffff",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  textAlign: "left",
  padding: "11px 14px",
  color: "var(--fc-admin-panel-text)",
  cursor: "pointer",
}

function normalizeCompanyName(value: string | null | undefined) {
  return value?.trim() || "No Company"
}

function normalizeCompanyKey(value: string | null | undefined) {
  return normalizeCompanyName(value).toLowerCase()
}

function toCaps(value: string | null | undefined) {
  return (value || "").toUpperCase()
}

function normalizeCountryName(value: string | null | undefined) {
  const upper = (value || "").trim().toUpperCase()
  if (!upper) return ""
  if (upper === "U.S.A." || upper === "U.S.A" || upper === "US") return "USA"
  if (upper === "UNITED STATES OF AMERICA") return "USA"
  if (upper === "U.A.E." || upper === "U.A.E") return "UAE"
  return upper
}

function getCountryCode(countryName: string | null | undefined) {
  const normalized = normalizeCountryName(countryName)
  return COUNTRY_OPTIONS.find((country) => country.name === normalized)?.code || ""
}

function normalizeTitleValue(value: string | null | undefined) {
  const upper = (value || "").trim().toUpperCase()
  return TITLE_OPTIONS.includes(upper as (typeof TITLE_OPTIONS)[number]) ? upper : ""
}

function formatCompanyPhoneLine(company: Company) {
  const countryCode = (company.tel_country || "").trim()
  const areaCode = (company.tel_area || "").trim()
  const tel1 = (company.tel_no_1 || "").trim()
  if (!tel1) return ""
  if (countryCode && areaCode) return `+${countryCode}-${areaCode}-${tel1}`
  if (countryCode) return `+${countryCode}-${tel1}`
  if (areaCode) return `${areaCode}-${tel1}`
  return tel1
}

function buildSearchTokens(value: string) {
  return value.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

function buildContactSearchText(contact: Partial<Contact>) {
  return [
    contact.full_name,
    contact.company,
    contact.title,
    contact.name_remark,
    contact.position,
    contact.department,
    contact.tel_ext,
    contact.direct_line,
    contact.mobile_area,
    contact.mobile_1,
    contact.mobile_2,
    contact.personal_email,
    contact.general_email,
    contact.private_email,
    contact.instant_messaging,
    contact.others,
    contact.area_of_responsibility,
    contact.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function getCompanySearchText(company: Partial<Company>) {
  return [company.name, company.other_name, formatCompanyPhoneLine(company as Company)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function buildContactClipboardText(contact: Partial<Contact>) {
  const displayName = [contact.title, contact.full_name].filter(Boolean).join(" ").trim()
  const lines = [
    displayName ? `NAME: ${displayName}` : "",
    contact.company ? `COMPANY: ${contact.company}` : "",
    contact.mobile_1 ? `MOBILE: ${contact.mobile_1}` : "",
    contact.mobile_2 ? `MOBILE: ${contact.mobile_2}` : "",
    contact.personal_email ? `PERSONAL EMAIL: ${contact.personal_email}` : "",
    contact.general_email ? `GENERAL EMAIL: ${contact.general_email}` : "",
    contact.private_email ? `PRIVATE EMAIL: ${contact.private_email}` : "",
  ].filter(Boolean)

  return lines.join("\n")
}

function copyToClipboard(value: string, onDone: (message: string) => void) {
  navigator.clipboard
    .writeText(value)
    .then(() => onDone("Copied"))
    .catch(() => onDone("Unable to copy."))
}

function openPhonebookCacheDb() {
  return new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null)
      return
    }

    const request = indexedDB.open(PHONEBOOK_CACHE_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PHONEBOOK_CACHE_STORE)) {
        db.createObjectStore(PHONEBOOK_CACHE_STORE, { keyPath: "key" })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

async function readPhonebookCache<T>(key: string) {
  const db = await openPhonebookCacheDb()
  if (!db) return null

  return new Promise<PhonebookCacheRecord<T> | null>((resolve) => {
    const transaction = db.transaction(PHONEBOOK_CACHE_STORE, "readonly")
    const request = transaction.objectStore(PHONEBOOK_CACHE_STORE).get(key)

    request.onsuccess = () => {
      const record = request.result as PhonebookCacheRecord<T> | undefined
      resolve(Array.isArray(record?.items) ? record : null)
    }
    request.onerror = () => resolve(null)
    transaction.oncomplete = () => db.close()
    transaction.onerror = () => db.close()
  })
}

async function writePhonebookCache<T>(key: string, items: T[]) {
  const db = await openPhonebookCacheDb()
  if (!db) return

  await new Promise<void>((resolve) => {
    const transaction = db.transaction(PHONEBOOK_CACHE_STORE, "readwrite")
    transaction.objectStore(PHONEBOOK_CACHE_STORE).put({
      key,
      savedAt: Date.now(),
      items,
    } satisfies PhonebookCacheRecord<T>)
    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      resolve()
    }
  })
}

function normalizeDialablePhone(value: string | null | undefined) {
  const trimmed = (value || "").trim()
  if (!trimmed) return null
  if (trimmed.startsWith("+")) return trimmed

  const digits = trimmed.replace(/[^\d]/g, "")
  if (digits.length === 8) return digits
  if (trimmed.startsWith("00") && digits.length > 8) return `+${trimmed.slice(2)}`
  if (digits.length > 8) return /^\d+$/.test(trimmed) ? `+${digits}` : `+${trimmed}`
  return trimmed
}

export default function PhonebookPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const isMobile = useIsMobile()
  const searchRef = useRef<HTMLInputElement | null>(null)
  const companyRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const contactRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const editButtonRef = useRef<HTMLButtonElement | null>(null)

  const [contacts, setContacts] = useState<Contact[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [companyRenderLimit, setCompanyRenderLimit] = useState(INITIAL_RENDERED_COMPANIES)
  const [selectedCompany, setSelectedCompany] = useState("")
  const [selectedId, setSelectedId] = useState("")
  const [current, setCurrent] = useState<Contact | null>(null)
  const [draft, setDraft] = useState<Contact | null>(null)
  const [message, setMessage] = useState("")
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [creatingContact, setCreatingContact] = useState(false)
  const [contactModalOpen, setContactModalOpen] = useState(false)
  const [companyModalOpen, setCompanyModalOpen] = useState(false)
  const [companyDraft, setCompanyDraft] = useState<CompanyDraft>(null)
  const [companySaving, setCompanySaving] = useState(false)
  const [contactSyncing, setContactSyncing] = useState(false)
  const [contactSyncLabel, setContactSyncLabel] = useState("")
  const [contactsLoading, setContactsLoading] = useState(false)
  const [searchResultsLimited, setSearchResultsLimited] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [creatingCompany, setCreatingCompany] = useState(false)
  const [copiedKey, setCopiedKey] = useState("")

  useEffect(() => {
    document.title = "Phonebook - FC Uno"
  }, [])
  const [companySuggestOpen, setCompanySuggestOpen] = useState(false)
  const [draggingContactId, setDraggingContactId] = useState("")
  const [dragOverContactId, setDragOverContactId] = useState("")
  const [dragInsertPosition, setDragInsertPosition] = useState<"before" | "after">("before")
  const [contactOrderByCompany, setContactOrderByCompany] = useState<Record<string, string[]>>({})
  const [changeLog, setChangeLog] = useState<ChangeLogEntry[]>([])
  const [undoingLogId, setUndoingLogId] = useState("")
  const [showPerfDebug, setShowPerfDebug] = useState(false)
  const [perfStats, setPerfStats] = useState<PerfStats>({
    sessionMs: null,
    companiesFetchMs: null,
    contactsFetchMs: null,
    normalizeCompaniesMs: null,
    normalizeContactsMs: null,
    localOrderLoadMs: null,
    localOrderBytes: null,
    changeLogLoadMs: null,
    changeLogBytes: null,
    companyCount: 0,
    contactCount: 0,
    userAgent: "",
  })
  const menuHideTimerRef = useRef<number | null>(null)
  const contactsRequestIdRef = useRef(0)
  const contactsWarmPromiseRef = useRef<Promise<Contact[]> | null>(null)
  const contactsWarmQueuedRef = useRef(false)
  const allContactsRef = useRef<Contact[]>([])
  const companyContactsCacheRef = useRef(new Map<string, Contact[]>())
  const searchContactsCacheRef = useRef(new Map<string, { contacts: Contact[]; limited: boolean }>())
  const deferredQuery = useDeferredValue(query)
  const [contactSearchEntries, setContactSearchEntries] = useState<ContactSearchEntry[]>([])

  function normalizeLoadedContacts(contactData: Contact[]) {
    return contactData.map((contact) => ({
      ...contact,
      full_name: contact.full_name?.toUpperCase?.() || contact.full_name,
      company: contact.company?.toUpperCase?.() || contact.company,
      title: normalizeTitleValue(contact.title) || null,
      name_remark: contact.name_remark?.toUpperCase?.() || contact.name_remark,
      position: contact.position?.toUpperCase?.() || contact.position,
      department: contact.department?.toUpperCase?.() || contact.department,
      tel_ext: contact.tel_ext?.toUpperCase?.() || contact.tel_ext,
      mobile_area: contact.mobile_area?.toUpperCase?.() || contact.mobile_area,
      instant_messaging: contact.instant_messaging?.toUpperCase?.() || contact.instant_messaging,
      others: contact.others?.toUpperCase?.() || contact.others,
      area_of_responsibility: contact.area_of_responsibility?.toUpperCase?.() || contact.area_of_responsibility,
      notes: contact.notes?.toUpperCase?.() || contact.notes,
    }))
  }

  function normalizeLoadedCompanies(companyData: Partial<Company>[]) {
    return companyData.map((company) => ({
      id: company.id || "",
      name: company.name?.toUpperCase?.() || company.name || "",
      other_name: company.other_name?.toUpperCase?.() || company.other_name || null,
      phone: company.phone?.toUpperCase?.() || company.phone || null,
      address: company.address?.toUpperCase?.() || company.address || null,
      country: normalizeCountryName(company.country) || null,
      tel_country: company.tel_country || getCountryCode(company.country) || null,
      tel_area: company.tel_area?.toUpperCase?.() || company.tel_area || null,
      tel_no_1: company.tel_no_1?.toUpperCase?.() || company.tel_no_1 || null,
      tel_no_2: company.tel_no_2?.toUpperCase?.() || company.tel_no_2 || null,
      tel_speed_dial: company.tel_speed_dial?.toUpperCase?.() || company.tel_speed_dial || null,
      fax_no_1: company.fax_no_1?.toUpperCase?.() || company.fax_no_1 || null,
      website: company.website?.toUpperCase?.() || company.website || null,
      email: company.email || null,
      contact_type: company.contact_type?.toUpperCase?.() || company.contact_type || null,
      stem_management: company.stem_management?.toUpperCase?.() || company.stem_management || null,
      company_status: company.company_status?.toUpperCase?.() || company.company_status || null,
      company_info: company.company_info?.toUpperCase?.() || company.company_info || null,
      seller_term: company.seller_term?.toUpperCase?.() || company.seller_term || null,
      seller_credit_limit: company.seller_credit_limit?.toUpperCase?.() || company.seller_credit_limit || null,
      seller_credit_limit_flexibility: company.seller_credit_limit_flexibility?.toUpperCase?.() || company.seller_credit_limit_flexibility || null,
      seller_classification: company.seller_classification?.toUpperCase?.() || company.seller_classification || null,
      seller_remark_1: company.seller_remark_1?.toUpperCase?.() || company.seller_remark_1 || null,
      seller_remark_2: company.seller_remark_2?.toUpperCase?.() || company.seller_remark_2 || null,
      seller_remark_3: company.seller_remark_3?.toUpperCase?.() || company.seller_remark_3 || null,
      seller_remark_4: company.seller_remark_4?.toUpperCase?.() || company.seller_remark_4 || null,
      buyer_term: company.buyer_term?.toUpperCase?.() || company.buyer_term || null,
      buyer_credit_limit: company.buyer_credit_limit?.toUpperCase?.() || company.buyer_credit_limit || null,
      buyer_credit_limit_flexibility: company.buyer_credit_limit_flexibility?.toUpperCase?.() || company.buyer_credit_limit_flexibility || null,
      buyer_classification: company.buyer_classification?.toUpperCase?.() || company.buyer_classification || null,
      buyer_remark_1: company.buyer_remark_1?.toUpperCase?.() || company.buyer_remark_1 || null,
      buyer_remark_2: company.buyer_remark_2?.toUpperCase?.() || company.buyer_remark_2 || null,
      buyer_remark_3: company.buyer_remark_3?.toUpperCase?.() || company.buyer_remark_3 || null,
      buyer_remark_4: company.buyer_remark_4?.toUpperCase?.() || company.buyer_remark_4 || null,
      notes: company.notes?.toUpperCase?.() || company.notes || null,
      source_key: company.source_key || "",
    }))
  }

  async function loadCompanies() {
    const startedAt = performance.now()
    const response = await fetch("/api/phonebook/bootstrap", { cache: "no-store" })
    const payload = (await response.json().catch(() => ({}))) as {
      companies?: Partial<Company>[]
      contactCount?: number
      message?: string
    }
    if (!response.ok) {
      throw new Error(payload.message || "Unable to load phonebook companies.")
    }
    const allCompanies = payload.companies || []

    setPerfStats((prev) => ({
      ...prev,
      companiesFetchMs: Math.round(performance.now() - startedAt),
      companyCount: allCompanies.length,
      contactCount: payload.contactCount || prev.contactCount,
    }))
    return {
      companies: allCompanies,
      contactCount: payload.contactCount || 0,
    }
  }

  function searchCachedContacts(queryValue: string) {
    const tokens = buildSearchTokens(queryValue)
    if (tokens.length === 0 || allContactsRef.current.length === 0) return null

    const matchingCompanyKeys = new Set(
      companies
        .filter((company) => tokens.every((token) => getCompanySearchText(company).includes(token)))
        .map((company) => normalizeCompanyKey(company.name)),
    )
    const results = new Map<string, Contact>()

    for (const contact of allContactsRef.current) {
      const contactHaystack = contact.search_text || buildContactSearchText(contact)
      const matchesContact = tokens.every((token) => contactHaystack.includes(token))
      const matchesCompany = matchingCompanyKeys.has(normalizeCompanyKey(contact.company))
      if (matchesContact || matchesCompany) {
        results.set(contact.id, contact)
      }
    }

    const sortedContacts = Array.from(results.values()).sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""))
    return {
      contacts: sortedContacts.slice(0, MAX_RENDERED_CONTACTS),
      limited: sortedContacts.length > MAX_RENDERED_CONTACTS,
    }
  }

  async function loadVisibleContacts(params: { company?: string; query?: string; signal?: AbortSignal }) {
    if (params.company) {
      const cached = companyContactsCacheRef.current.get(params.company)
      if (cached) {
        return {
          contacts: cached,
          limited: false,
        }
      }
      const contacts = await loadCompanyContactsFromSupabase(params.company, params.signal)
      companyContactsCacheRef.current.set(params.company, contacts)
      return {
        contacts,
        limited: false,
      }
    }

    const queryKey = (params.query || "").trim()
    if (queryKey) {
      const cached = searchContactsCacheRef.current.get(queryKey)
      if (cached) return cached
      const localResult = searchCachedContacts(queryKey)
      if (localResult) {
        searchContactsCacheRef.current.set(queryKey, localResult)
        return localResult
      }
    }

    const startedAt = performance.now()
    const search = new URLSearchParams()
    if (params.query) search.set("query", params.query)

    const response = await fetch(`/api/phonebook/contacts?${search.toString()}`, {
      cache: "no-store",
      signal: params.signal,
    })
    const payload = (await response.json().catch(() => ({}))) as {
      contacts?: Contact[]
      limited?: boolean
      message?: string
    }

    if (!response.ok) {
      throw new Error(payload.message || "Unable to load phonebook contacts.")
    }

    const normalizeStartedAt = performance.now()
    const normalizedContacts = normalizeLoadedContacts(payload.contacts || [])
    setPerfStats((prev) => ({
      ...prev,
      normalizeContactsMs: Math.round(performance.now() - normalizeStartedAt),
      contactsFetchMs: Math.round(normalizeStartedAt - startedAt),
    }))

    const result = {
      contacts: normalizedContacts,
      limited: Boolean(payload.limited),
    }
    if (queryKey) {
      searchContactsCacheRef.current.set(queryKey, result)
    }
    return result
  }

  function rebuildContactCaches(normalizedContacts: Contact[], timings?: { fetchMs: number; normalizeMs: number }) {
    allContactsRef.current = normalizedContacts

    const nextCompanyMap = new Map<string, Contact[]>()
    const nextSearchEntries: ContactSearchEntry[] = []

    for (const contact of normalizedContacts) {
      const companyName = normalizeCompanyName(contact.company)
      const existing = nextCompanyMap.get(companyName)
      if (existing) {
        existing.push(contact)
      } else {
        nextCompanyMap.set(companyName, [contact])
      }

      nextSearchEntries.push({
        companyKey: normalizeCompanyKey(contact.company),
        haystack: contact.search_text || "",
      })
    }

    companyContactsCacheRef.current = nextCompanyMap
    searchContactsCacheRef.current.clear()
    setContactSearchEntries(nextSearchEntries)

    if (timings) {
      setPerfStats((prev) => ({
        ...prev,
        contactCount: normalizedContacts.length,
        contactsFetchMs: timings.fetchMs,
        normalizeContactsMs: timings.normalizeMs,
      }))
    }
  }

  async function loadCompanyContactsFromSupabase(companyName: string, signal?: AbortSignal) {
    const response = await fetch(
      `/api/phonebook/contacts?company=${encodeURIComponent(companyName)}`,
      { cache: "no-store", signal },
    )
    const payload = (await response.json().catch(() => ({}))) as {
      contacts?: Contact[]
      message?: string
    }
    if (!response.ok) {
      throw new Error(payload.message || "Unable to load company contacts.")
    }
    return normalizeLoadedContacts(payload.contacts || [])
  }

  async function loadAllContactsForCache() {
    const startedAt = performance.now()
    const response = await fetch("/api/phonebook/contacts?all=1", { cache: "no-store" })
    const payload = (await response.json().catch(() => ({}))) as {
      contacts?: Contact[]
      message?: string
    }
    if (!response.ok) {
      throw new Error(payload.message || "Unable to load phonebook contacts.")
    }

    const normalizeStartedAt = performance.now()
    const allContacts = normalizeLoadedContacts(payload.contacts || [])
    rebuildContactCaches(allContacts, {
      fetchMs: Math.round(normalizeStartedAt - startedAt),
      normalizeMs: Math.round(performance.now() - normalizeStartedAt),
    })
    void writePhonebookCache(PHONEBOOK_CONTACTS_CACHE_KEY, allContacts)
    return allContacts
  }

  function clearContactCaches() {
    allContactsRef.current = []
    companyContactsCacheRef.current.clear()
    searchContactsCacheRef.current.clear()
    setContactSearchEntries([])
  }

  function refreshContactCachesInBackground() {
    if (contactsWarmPromiseRef.current) {
      contactsWarmQueuedRef.current = true
      return contactsWarmPromiseRef.current
    }

    contactsWarmPromiseRef.current = loadAllContactsForCache()
      .catch(() => [])
      .finally(() => {
        contactsWarmPromiseRef.current = null
        if (contactsWarmQueuedRef.current) {
          contactsWarmQueuedRef.current = false
          refreshContactCachesInBackground()
        }
      })
    return contactsWarmPromiseRef.current
  }

  async function refreshCompaniesFromSupabase() {
    const { companies: companyData, contactCount } = await loadCompanies()
    const normalizeCompaniesStartedAt = performance.now()
    const normalizedCompanies = normalizeLoadedCompanies(companyData)
    setPerfStats((prev) => ({
      ...prev,
      normalizeCompaniesMs: Math.round(performance.now() - normalizeCompaniesStartedAt),
      contactCount,
    }))
    setCompanies(normalizedCompanies)
    void writePhonebookCache(PHONEBOOK_COMPANIES_CACHE_KEY, normalizedCompanies)
    return normalizedCompanies
  }

  async function hydrateCachedContacts() {
    const cachedRecord = await readPhonebookCache<Contact>(PHONEBOOK_CONTACTS_CACHE_KEY)
    if (!cachedRecord?.items.length) return { hydrated: false, fresh: false }

    const normalizeContactsStartedAt = performance.now()
    const normalizedContacts = normalizeLoadedContacts(cachedRecord.items)
    rebuildContactCaches(normalizedContacts, {
      fetchMs: 0,
      normalizeMs: Math.round(performance.now() - normalizeContactsStartedAt),
    })
    return {
      hydrated: true,
      fresh: Date.now() - cachedRecord.savedAt < PHONEBOOK_CONTACTS_REFRESH_MS,
    }
  }

  function schedulePhonebookWarmup() {
    const hydrate = () => {
      void hydrateCachedContacts().then((result) => {
        if (!result.hydrated || result.fresh) return
        window.setTimeout(() => refreshContactCachesInBackground(), 4000)
      })
    }
    const requestIdle = (
      window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
      }
    ).requestIdleCallback

    if (requestIdle) {
      requestIdle(hydrate, { timeout: 1200 })
    } else {
      globalThis.setTimeout(hydrate, 50)
    }
  }

  async function loadAll() {
    setLoading(true)
    let renderedFromCache = false
    try {
      const cachedCompanyRecord = await readPhonebookCache<Company>(PHONEBOOK_COMPANIES_CACHE_KEY)
      const cachedCompanies = cachedCompanyRecord?.items

      if (cachedCompanies?.length) {
        const normalizeCompaniesStartedAt = performance.now()
        const normalizedCompanies = normalizeLoadedCompanies(cachedCompanies)
        setCompanies(normalizedCompanies)
        setPerfStats((prev) => ({
          ...prev,
          companyCount: normalizedCompanies.length,
          normalizeCompaniesMs: Math.round(performance.now() - normalizeCompaniesStartedAt),
        }))
        setLoading(false)
        renderedFromCache = true
      }

      setContacts([])
      if (renderedFromCache) {
        schedulePhonebookWarmup()
        window.setTimeout(() => void refreshCompaniesFromSupabase().catch(() => {}), 4000)
        return
      }

      await refreshCompaniesFromSupabase()
      schedulePhonebookWarmup()
    } catch {
      setMessage("Unable to load phonebook.")
    } finally {
      if (!renderedFromCache) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (adminLoading || !authenticated) return
    void loadAll()
  }, [adminLoading, authenticated])

  useEffect(() => {
    if (adminLoading || !authenticated) return

    const activeQuery = deferredQuery.trim()
    const requestId = ++contactsRequestIdRef.current
    const controller = new AbortController()
    let cancelled = false

    if (!selectedCompany && !activeQuery) {
      setContacts([])
      setSearchResultsLimited(false)
      setContactsLoading(false)
      return
    }

    if (selectedCompany) {
      const cachedCompanyContacts = companyContactsCacheRef.current.get(selectedCompany)
      if (cachedCompanyContacts) {
        setContacts(cachedCompanyContacts)
        setSearchResultsLimited(false)
        setContactsLoading(false)
        return
      }
      setContactsLoading(true)
    } else {
      setContactsLoading(true)
    }

    void (async () => {
      if (activeQuery) {
        await new Promise((resolve) => window.setTimeout(resolve, 180))
        if (cancelled || contactsRequestIdRef.current !== requestId) return
      }

      try {
        const payload = selectedCompany
          ? await loadVisibleContacts({ company: selectedCompany, signal: controller.signal })
          : await loadVisibleContacts({ query: activeQuery, signal: controller.signal })

        if (contactsRequestIdRef.current !== requestId) return
        setContacts(payload.contacts)
        setSearchResultsLimited(payload.limited)
      } catch (error) {
        if (controller.signal.aborted) return
        if (contactsRequestIdRef.current !== requestId) return
        setContacts([])
        setSearchResultsLimited(false)
        setMessage(error instanceof Error ? error.message : "Unable to load phonebook contacts.")
      } finally {
        if (contactsRequestIdRef.current === requestId) {
          setContactsLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [adminLoading, authenticated, deferredQuery, selectedCompany])

  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    setShowPerfDebug(params.get("perf") === "1")
    setPerfStats((prev) => ({
      ...prev,
      userAgent: window.navigator.userAgent,
    }))
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setCurrent(null)
      setDraft(null)
      setEditing(false)
      return
    }
    const next = contacts.find((item) => item.id === selectedId) || null
    setCurrent(next ? { ...next } : null)
    setDraft(next ? { ...next } : null)
    setEditing(false)
  }, [contacts, selectedId])

  useEffect(() => {
    if (!copiedKey) return
    const timer = window.setTimeout(() => setCopiedKey(""), 1200)
    return () => window.clearTimeout(timer)
  }, [copiedKey])

  useEffect(() => {
    const startedAt = performance.now()
    try {
      const raw = localStorage.getItem(CONTACT_ORDER_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, string[]>
      setContactOrderByCompany(parsed)
      setPerfStats((prev) => ({
        ...prev,
        localOrderLoadMs: Math.round(performance.now() - startedAt),
        localOrderBytes: raw.length,
      }))
    } catch {
      setContactOrderByCompany({})
      setPerfStats((prev) => ({
        ...prev,
        localOrderLoadMs: Math.round(performance.now() - startedAt),
        localOrderBytes: 0,
      }))
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(CONTACT_ORDER_STORAGE_KEY, JSON.stringify(contactOrderByCompany))
  }, [contactOrderByCompany])

  useEffect(() => {
    const startedAt = performance.now()
    try {
      const raw = localStorage.getItem(PHONEBOOK_CHANGE_LOG_KEY)
      if (!raw) return
      setChangeLog(JSON.parse(raw) as ChangeLogEntry[])
      setPerfStats((prev) => ({
        ...prev,
        changeLogLoadMs: Math.round(performance.now() - startedAt),
        changeLogBytes: raw.length,
      }))
    } catch {
      setChangeLog([])
      setPerfStats((prev) => ({
        ...prev,
        changeLogLoadMs: Math.round(performance.now() - startedAt),
        changeLogBytes: 0,
      }))
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(PHONEBOOK_CHANGE_LOG_KEY, JSON.stringify(changeLog))
  }, [changeLog])

  useEffect(() => {
    if (companies.length === 0) return
    searchContactsCacheRef.current.clear()
    void writePhonebookCache(PHONEBOOK_COMPANIES_CACHE_KEY, companies)
  }, [companies])

  useEffect(() => {
    setSelectedId("")
  }, [selectedCompany])

  useEffect(() => {
    return () => {
      if (menuHideTimerRef.current) window.clearTimeout(menuHideTimerRef.current)
    }
  }, [])

  const queryTokens = useMemo(() => buildSearchTokens(deferredQuery), [deferredQuery])
  const selectedCompanyKey = useMemo(() => normalizeCompanyKey(selectedCompany), [selectedCompany])
  const companyById = useMemo(() => {
    return new Map(companies.map((company) => [company.id, company]))
  }, [companies])

  const companiesWithMatchingContacts = useMemo(() => {
    if (queryTokens.length === 0) return new Set<string>()

    return new Set(
      contactSearchEntries
        .filter((contact) => queryTokens.every((token) => contact.haystack.includes(token)))
        .map((contact) => contact.companyKey)
    )
  }, [contactSearchEntries, queryTokens])

  const filteredCompanies = useMemo(() => {
    if (queryTokens.length === 0) return companies
    return companies.filter((company) => {
      const haystack = getCompanySearchText(company)
      const matchesCompanyName = queryTokens.every((token) => haystack.includes(token))
      return matchesCompanyName || companiesWithMatchingContacts.has(normalizeCompanyKey(company.name))
    })
  }, [companies, companiesWithMatchingContacts, queryTokens])
  const visibleCompanies = useMemo(
    () => filteredCompanies.slice(
      0,
      queryTokens.length === 0 ? companyRenderLimit : MAX_SEARCH_RENDERED_COMPANIES,
    ),
    [companyRenderLimit, filteredCompanies, queryTokens.length],
  )

  const companyNameSuggestions = useMemo(
    () =>
      companies
        .map((company) => company.name)
        .filter((name): name is string => Boolean(name && name.trim()))
        .sort((a, b) => a.localeCompare(b)),
    [companies],
  )
  const companyInputSuggestions = useMemo(() => {
    const needle = (draft?.company || "").trim().toLowerCase()
    if (!needle) return companyNameSuggestions.slice(0, 10)
    return companies
      .filter((company) =>
        [company.name, company.other_name]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(needle)),
      )
      .map((company) => company.name)
      .slice(0, 10)
  }, [companies, companyNameSuggestions, draft?.company])

  const contactOrderIndex = useMemo(() => {
    const order = selectedCompany ? contactOrderByCompany[selectedCompanyKey] || [] : []
    return new Map(order.map((contactId, index) => [contactId, index]))
  }, [contactOrderByCompany, selectedCompany, selectedCompanyKey])

  const filteredContacts = useMemo(() => {
    const next = [...contacts].sort((a, b) => {
      if (selectedCompany) {
        const aIndex = contactOrderIndex.get(a.id)
        const bIndex = contactOrderIndex.get(b.id)
        const aOrdered = aIndex !== undefined
        const bOrdered = bIndex !== undefined
        if (aOrdered && bOrdered && aIndex !== bIndex) return aIndex - bIndex
        if (aOrdered && !bOrdered) return -1
        if (!aOrdered && bOrdered) return 1
        if (a.name_remark && !b.name_remark) return -1
        if (!a.name_remark && b.name_remark) return 1
        if (a.name_remark && b.name_remark && a.name_remark !== b.name_remark) {
          return a.name_remark.localeCompare(b.name_remark)
        }
      }
      return (a.full_name || "").localeCompare(b.full_name || "")
    })
    return next
  }, [contactOrderIndex, contacts, selectedCompany])
  const visibleContacts = filteredContacts

  async function saveCurrent() {
    if (!draft) return
    const selectedContactCompany = companies.find(
      (company) => normalizeCompanyKey(company.name) === normalizeCompanyKey(draft.company),
    )
    if (!selectedContactCompany) {
      setMessage("Select an existing company from the company list before saving.")
      setCompanySuggestOpen(true)
      return
    }

    setSaving(true)
    setMessage("")
    const payload = {
      full_name: draft.full_name.trim().toUpperCase(),
      company: selectedContactCompany.name,
      company_source_id: selectedContactCompany.source_key || draft.company_source_id?.trim() || null,
      title: normalizeTitleValue(draft.title) || null,
      name_remark: draft.name_remark?.trim().toUpperCase() || null,
      position: draft.position?.trim().toUpperCase() || null,
      department: draft.department?.trim().toUpperCase() || null,
      tel_ext: draft.tel_ext?.trim().toUpperCase() || null,
      direct_line: normalizeDialablePhone(draft.direct_line),
      mobile_area: draft.mobile_area?.trim().toUpperCase() || null,
      mobile_1: normalizeDialablePhone(draft.mobile_1),
      mobile_2: normalizeDialablePhone(draft.mobile_2),
      personal_email: draft.personal_email?.trim() || null,
      general_email: draft.general_email?.trim() || null,
      private_email: draft.private_email?.trim() || null,
      instant_messaging: draft.instant_messaging?.trim().toUpperCase() || null,
      others: draft.others?.trim().toUpperCase() || null,
      area_of_responsibility: draft.area_of_responsibility?.trim().toUpperCase() || null,
      mobile_phone: normalizeDialablePhone(draft.mobile_1),
      pager: normalizeDialablePhone(draft.mobile_2),
      business_phone: normalizeDialablePhone(draft.direct_line),
      business_phone_2: draft.tel_ext?.trim().toUpperCase() || null,
      other_phone: draft.others?.trim().toUpperCase() || null,
      email_1: draft.personal_email?.trim() || null,
      email_2: draft.general_email?.trim() || null,
      notes: draft.notes?.trim().toUpperCase() || null,
      favorite: false,
      search_text: buildContactSearchText(draft),
    }

    if (creatingContact) {
      const insertPayload = {
        ...payload,
        source_key: `manual-${crypto.randomUUID()}`,
      }
      const { data, error } = await supabase.from("phonebook_contacts").insert(insertPayload).select("*").single()
      if (error || !data) {
        setMessage("Unable to save contact.")
        setSaving(false)
        return
      }

      const nextContact = data as Contact
      refreshContactCachesInBackground()
      recordChange({
        entityType: "contact",
        action: "create",
        label: nextContact.full_name || "NEW CONTACT",
        before: null,
        after: nextContact,
      })
      setContacts((prev) => [nextContact, ...prev])
      setSelectedId(nextContact.id)
      setCurrent(nextContact)
      setDraft(nextContact)
      setEditing(false)
      setCreatingContact(false)
      setContactModalOpen(false)
      const synced = await syncPhoneContacts(false, [nextContact.id], {
        successMessage: "Saved and verified on CardDAV.",
        failureMessage: "Saved locally, but CardDAV sync failed.",
      })
      if (synced) setMessage("Saved and verified on CardDAV.")
      setSaving(false)
      return
    }

    const beforeContact = current ? { ...current } : { ...draft }
    const { error } = await supabase.from("phonebook_contacts").update(payload).eq("id", draft.id)
    if (error) {
      setMessage("Unable to save contact.")
      setSaving(false)
      return
    }

    const updatedContact = { ...beforeContact, ...payload } as Contact
    refreshContactCachesInBackground()
    recordChange({
      entityType: "contact",
      action: "update",
      label: updatedContact.full_name || "CONTACT",
      before: beforeContact as Contact,
      after: updatedContact,
    })
    setContacts((prev) => prev.map((item) => (item.id === draft.id ? updatedContact : item)))
    setCurrent((prev) => (prev ? updatedContact : prev))
    setEditing(false)
    const synced = await syncPhoneContacts(false, [draft.id], {
      successMessage: "Saved and verified on CardDAV.",
      failureMessage: "Saved locally, but CardDAV sync failed.",
    })
    if (synced) setMessage("Saved and verified on CardDAV.")
    setSaving(false)
  }

  async function deleteCurrent() {
    if (!current) return
    if (!confirm(`Delete ${current.full_name}?`)) return
    const companyName = current.company || ""
    const companyContacts = companyName ? await loadCompanyContactsFromSupabase(companyName) : []
    const isLastCompanyContact = Boolean(companyName) && companyContacts.length === 1
    const matchingCompany = companies.find(
      (item) => normalizeCompanyKey(item.name) === normalizeCompanyKey(companyName),
    )
    const deleteCompanyToo =
      isLastCompanyContact && matchingCompany
        ? confirm(`This is the last contact under ${companyName}. Delete the company too?`)
        : false

    const deletingId = current.id
    const { error } = await supabase.from("phonebook_contacts").delete().eq("id", current.id)
    if (error) {
      setMessage("Unable to delete contact.")
      return
    }
    refreshContactCachesInBackground()
    recordChange({
      entityType: "contact",
      action: "delete",
      label: current.full_name || "CONTACT",
      before: current,
      after: null,
    })
    setContacts((prev) => prev.filter((item) => item.id !== current.id))
    setSelectedId("")
    if (deleteCompanyToo && matchingCompany) {
      const { error: companyDeleteError } = await supabase
        .from("phonebook_companies")
        .delete()
        .eq("id", matchingCompany.id)
      if (companyDeleteError) {
        setMessage("Contact deleted, but company could not be deleted.")
        return
      }

      recordChange({
        entityType: "company",
        action: "delete",
        label: matchingCompany.name || "COMPANY",
        before: matchingCompany,
        after: null,
      })
      setCompanies((prev) => prev.filter((item) => item.id !== matchingCompany.id))
      if (selectedCompany === matchingCompany.name) {
        setSelectedCompany("")
      }
      if (companyDraft?.id === matchingCompany.id) {
        setCompanyDraft(null)
        setCompanyModalOpen(false)
      }
    }
    await syncPhoneContacts(false, null, {
      deleteContactIds: [deletingId],
      successMessage: deleteCompanyToo ? "Deleted contact and company, then synced." : "Deleted and synced.",
    })
  }

  function addCompany() {
    setCreatingCompany(true)
    setCompanyDraft({
      id: `new-company-${Date.now()}`,
      name: "",
      other_name: null,
      phone: null,
      address: null,
      country: null,
      tel_country: null,
      tel_area: null,
      tel_no_1: null,
      tel_no_2: null,
      tel_speed_dial: null,
      fax_no_1: null,
      website: null,
      email: null,
      contact_type: null,
      stem_management: null,
      company_status: null,
      company_info: null,
      seller_term: null,
      seller_credit_limit: null,
      seller_credit_limit_flexibility: null,
      seller_classification: null,
      seller_remark_1: null,
      seller_remark_2: null,
      seller_remark_3: null,
      seller_remark_4: null,
      buyer_term: null,
      buyer_credit_limit: null,
      buyer_credit_limit_flexibility: null,
      buyer_classification: null,
      buyer_remark_1: null,
      buyer_remark_2: null,
      buyer_remark_3: null,
      buyer_remark_4: null,
      notes: null,
      source_key: `manual-company-${crypto.randomUUID()}`,
    })
    setCompanyModalOpen(true)
    setMessage("")
  }

  async function openCompanyModal(company: Company) {
    setCompanyDraft({
      ...company,
      country: normalizeCountryName(company.country) || null,
      tel_country: company.tel_country || getCountryCode(company.country) || null,
    })
    setCompanyModalOpen(true)
    setMessage("")

    const { data, error } = await supabase
      .from("phonebook_companies")
      .select("*")
      .eq("id", company.id)
      .single()

    if (error || !data) {
      setMessage("Unable to load company details.")
      return
    }

    const [fullCompany] = normalizeLoadedCompanies([data as Company])
    setCompanies((prev) => prev.map((item) => (item.id === fullCompany.id ? { ...item, ...fullCompany } : item)))
    setCompanyDraft((prev) => {
      if (!prev || prev.id !== fullCompany.id) return prev
      return {
        ...fullCompany,
        country: normalizeCountryName(fullCompany.country) || null,
        tel_country: fullCompany.tel_country || getCountryCode(fullCompany.country) || null,
      }
    })
  }

  function closeCompanyModal() {
    setCompanyModalOpen(false)
    setCompanyDraft(null)
    setCompanySaving(false)
    setCreatingCompany(false)
  }

  function closeContactModal() {
    setContactModalOpen(false)
    setCompanySuggestOpen(false)
    setCreatingContact(false)
    setSaving(false)
    setDraft(current ? { ...current } : null)
  }

  async function saveCompany() {
    if (!companyDraft) return
    setCompanySaving(true)
    setMessage("")
    const originalCompany = creatingCompany ? null : companyById.get(companyDraft.id) || null
    const previousCompanyName = (originalCompany?.name || companyDraft.name).trim().toUpperCase()
    const payload = {
      name: companyDraft.name.trim().toUpperCase(),
      source_key: companyDraft.source_key,
      other_name: companyDraft.other_name?.trim().toUpperCase() || null,
      phone: companyDraft.phone?.trim().toUpperCase() || null,
      address: companyDraft.address?.trim().toUpperCase() || null,
      country: normalizeCountryName(companyDraft.country) || null,
      tel_country: getCountryCode(companyDraft.country) || null,
      tel_area: companyDraft.tel_area?.trim().toUpperCase() || null,
      tel_no_1: companyDraft.tel_no_1?.trim().toUpperCase() || null,
      tel_no_2: companyDraft.tel_no_2?.trim().toUpperCase() || null,
      tel_speed_dial: companyDraft.tel_speed_dial?.trim().toUpperCase() || null,
      fax_no_1: companyDraft.fax_no_1?.trim().toUpperCase() || null,
      website: companyDraft.website?.trim().toUpperCase() || null,
      email: companyDraft.email?.trim() || null,
      contact_type: companyDraft.contact_type?.trim().toUpperCase() || null,
      stem_management: companyDraft.stem_management?.trim().toUpperCase() || null,
      company_status: companyDraft.company_status?.trim().toUpperCase() || null,
      company_info: companyDraft.company_info?.trim().toUpperCase() || null,
      seller_term: companyDraft.seller_term?.trim().toUpperCase() || null,
      seller_credit_limit: companyDraft.seller_credit_limit?.trim().toUpperCase() || null,
      seller_credit_limit_flexibility: companyDraft.seller_credit_limit_flexibility?.trim().toUpperCase() || null,
      seller_classification: companyDraft.seller_classification?.trim().toUpperCase() || null,
      seller_remark_1: companyDraft.seller_remark_1?.trim().toUpperCase() || null,
      seller_remark_2: companyDraft.seller_remark_2?.trim().toUpperCase() || null,
      seller_remark_3: companyDraft.seller_remark_3?.trim().toUpperCase() || null,
      seller_remark_4: companyDraft.seller_remark_4?.trim().toUpperCase() || null,
      buyer_term: companyDraft.buyer_term?.trim().toUpperCase() || null,
      buyer_credit_limit: companyDraft.buyer_credit_limit?.trim().toUpperCase() || null,
      buyer_credit_limit_flexibility: companyDraft.buyer_credit_limit_flexibility?.trim().toUpperCase() || null,
      buyer_classification: companyDraft.buyer_classification?.trim().toUpperCase() || null,
      buyer_remark_1: companyDraft.buyer_remark_1?.trim().toUpperCase() || null,
      buyer_remark_2: companyDraft.buyer_remark_2?.trim().toUpperCase() || null,
      buyer_remark_3: companyDraft.buyer_remark_3?.trim().toUpperCase() || null,
      buyer_remark_4: companyDraft.buyer_remark_4?.trim().toUpperCase() || null,
      notes: companyDraft.notes?.trim().toUpperCase() || null,
    }

    const query = creatingCompany
      ? supabase.from("phonebook_companies").insert(payload).select("*").single()
      : supabase
          .from("phonebook_companies")
          .update(payload)
          .eq("id", companyDraft.id)
          .select("*")
          .single()

    const { data, error } = await query

    if (error || !data) {
      setMessage("Unable to save company.")
      setCompanySaving(false)
      return
    }

    recordChange({
      entityType: "company",
      action: creatingCompany ? "create" : "update",
      label: payload.name || "COMPANY",
      before: originalCompany,
      after: data as Company,
    })

    setCompanies((prev) => {
      refreshContactCachesInBackground()
      const next = creatingCompany
        ? [...prev, data as Company]
        : prev.map((item) => (item.id === companyDraft.id ? (data as Company) : item))
      return next.sort((a, b) => a.name.localeCompare(b.name))
    })

    const affectedContacts = !creatingCompany && previousCompanyName
      ? await loadCompanyContactsFromSupabase(previousCompanyName)
      : []
    let syncedContactIds = affectedContacts.map((contact) => contact.id)

    if (!creatingCompany && previousCompanyName !== payload.name && affectedContacts.length > 0) {
      const contactIds = affectedContacts.map((contact) => contact.id)
      const nextContacts = affectedContacts.map((contact) => {
        const nextContact = { ...contact, company: payload.name }
        return { ...nextContact, search_text: buildContactSearchText(nextContact) }
      })

      const updates = nextContacts.map((contact) =>
        supabase
          .from("phonebook_contacts")
          .update({ company: payload.name, search_text: contact.search_text })
          .eq("id", contact.id),
      )
      const results = await Promise.all(updates)
      if (results.some((result) => result.error)) {
        setMessage("Company saved, but linked contacts could not be renamed.")
        setCompanySaving(false)
        return
      }

      setContacts((prev) => {
        if (selectedCompany && normalizeCompanyKey(selectedCompany) !== normalizeCompanyKey(previousCompanyName)) {
          return prev
        }
        return prev.map((contact) => {
          const updated = nextContacts.find((item) => item.id === contact.id)
          return updated ? updated : contact
        })
      })
      if (current && contactIds.includes(current.id)) {
        const updatedCurrent = nextContacts.find((contact) => contact.id === current.id) || null
        setCurrent(updatedCurrent)
        setDraft(updatedCurrent ? { ...updatedCurrent } : null)
      }
    }

    if (creatingCompany) {
      setSelectedCompany(payload.name)
      setMessage("Saved.")
    } else {
      if (selectedCompany === previousCompanyName && payload.name !== previousCompanyName) {
        setSelectedCompany(payload.name)
      }
      setMessage("Saved.")
    }

    setCompanyDraft(data as Company)
    setCompanySaving(false)
    setCompanyModalOpen(false)
    setCreatingCompany(false)

    if (!creatingCompany && previousCompanyName === payload.name) {
      syncedContactIds = affectedContacts.map((contact) => contact.id)
    }

    if (syncedContactIds.length > 0) {
      const synced = await syncPhoneContacts(false, syncedContactIds, {
        successMessage: "Saved and verified on CardDAV.",
        failureMessage: "Saved locally, but CardDAV sync failed.",
      })
      if (synced) setMessage("Saved and verified on CardDAV.")
    }
  }

  async function deleteCompany() {
    if (!companyDraft || creatingCompany) return
    if (!confirm(`Delete ${companyDraft.name || "this company"}?`)) return
    const companyNameToDelete = companyDraft.name
    const companyContacts = await loadCompanyContactsFromSupabase(companyNameToDelete)
    const companyContactIds = companyContacts.map((contact) => contact.id)

    if (
      companyContacts.length > 0 &&
      !confirm(`Delete ${companyContacts.length} contact${companyContacts.length === 1 ? "" : "s"} inside this company as well?`)
    ) {
      return
    }

    if (companyContactIds.length > 0) {
      const { error: contactDeleteError } = await supabase
        .from("phonebook_contacts")
        .delete()
        .in("id", companyContactIds)
      if (contactDeleteError) {
        setMessage("Unable to delete company contacts.")
        return
      }
    }

    const { error } = await supabase.from("phonebook_companies").delete().eq("id", companyDraft.id)
    if (error) {
      setMessage("Unable to delete company.")
      return
    }
    refreshContactCachesInBackground()
    recordChange({
      entityType: "company",
      action: "delete",
      label: companyDraft.name || "COMPANY",
      before: companyDraft,
      after: null,
    })

    setCompanies((prev) => prev.filter((item) => item.id !== companyDraft.id))
    if (companyContactIds.length > 0) {
      setContacts((prev) => prev.filter((item) => !companyContactIds.includes(item.id)))
      if (current && companyContactIds.includes(current.id)) {
        setCurrent(null)
        setDraft(null)
        setSelectedId("")
        setEditing(false)
      }
    }
    if (selectedCompany === companyDraft.name) {
      setSelectedCompany("")
    }
    setCompanyModalOpen(false)
    setCompanyDraft(null)
    setCreatingCompany(false)
    if (companyContactIds.length > 0) {
      await syncPhoneContacts(false, null, {
        deleteContactIds: companyContactIds,
        successMessage: "Company deleted and CardDAV contacts updated.",
        failureMessage: "Company deleted locally, but CardDAV sync failed.",
      })
    } else {
      setMessage("Company deleted.")
    }
  }

  async function addContact() {
    const payload = {
      id: `new-contact-${Date.now()}`,
      full_name: "",
      company: selectedCompany.toUpperCase(),
      company_source_id: "",
      title: "",
      name_remark: "",
      position: "",
      department: "",
      tel_ext: "",
      direct_line: "",
      mobile_area: "",
      mobile_1: "",
      mobile_2: "",
      personal_email: "",
      general_email: "",
      private_email: "",
      instant_messaging: "",
      others: "",
      area_of_responsibility: "",
      mobile_phone: "",
      pager: "",
      business_phone: "",
      business_phone_2: "",
      other_phone: "",
      email_1: "",
      email_2: "",
      notes: "",
      favorite: false,
      search_text: selectedCompany.toLowerCase(),
      created_at: "",
      updated_at: "",
    }
    setDraft(payload as Contact)
    setCompanySuggestOpen(false)
    setCreatingContact(true)
    setContactModalOpen(true)
    setEditing(true)
    setMessage("")
  }

  function reorderCompanyContacts(companyKey: string, draggedId: string, targetId: string, position: "before" | "after") {
    const companyContacts = contacts
      .filter((contact) => normalizeCompanyKey(contact.company) === companyKey)
      .map((contact) => contact.id)

    const currentOrder = contactOrderByCompany[companyKey] || []
    const merged = [...currentOrder.filter((id) => companyContacts.includes(id))]
    for (const id of companyContacts) {
      if (!merged.includes(id)) merged.push(id)
    }

    const fromIndex = merged.indexOf(draggedId)
    const toIndex = merged.indexOf(targetId)
    if (fromIndex === -1 || toIndex === -1) return

    const nextOrder = [...merged]
    const [moved] = nextOrder.splice(fromIndex, 1)
    const adjustedTargetIndex = nextOrder.indexOf(targetId)
    if (adjustedTargetIndex === -1) return
    const insertIndex = position === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex
    nextOrder.splice(insertIndex, 0, moved)
    setContactOrderByCompany((prev) => ({ ...prev, [companyKey]: nextOrder }))
  }

  function recordChange(entry: Omit<ChangeLogEntry, "id" | "timestamp">) {
    const nextEntry: ChangeLogEntry = {
      ...entry,
      id: `log-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
    }
    setChangeLog((prev) => [nextEntry, ...prev].slice(0, 10))
  }

  async function undoLogEntry(entry: ChangeLogEntry) {
    setUndoingLogId(entry.id)
    setMessage("")
    try {
      if (entry.entityType === "contact") {
        if (entry.action === "create" && entry.after) {
          const { error } = await supabase.from("phonebook_contacts").delete().eq("id", entry.after.id)
          if (error) throw error
          refreshContactCachesInBackground()
          setContacts((prev) => prev.filter((item) => item.id !== entry.after!.id))
          if (selectedId === entry.after.id) setSelectedId("")
          await syncPhoneContacts(false, null, { deleteContactIds: [entry.after.id], successMessage: "Undone and synced." })
        } else if (entry.action === "delete" && entry.before) {
          const { data, error } = await supabase.from("phonebook_contacts").insert(entry.before as Contact).select("*").single()
          if (error || !data) throw error || new Error("Unable to restore contact.")
          refreshContactCachesInBackground()
          setContacts((prev) => [data as Contact, ...prev])
          await syncPhoneContacts(false, [data.id], { successMessage: "Undone and synced.", failureMessage: "Undone locally, but CardDAV sync failed." })
        } else if (entry.action === "update" && entry.before && entry.after) {
          const { error } = await supabase.from("phonebook_contacts").update(entry.before as Contact).eq("id", entry.after.id)
          if (error) throw error
          refreshContactCachesInBackground()
          setContacts((prev) => prev.map((item) => (item.id === entry.after!.id ? (entry.before as Contact) : item)))
          if (current?.id === entry.after.id) {
            setCurrent(entry.before as Contact)
            setDraft(entry.before as Contact)
          }
          await syncPhoneContacts(false, [entry.after.id], { successMessage: "Undone and synced.", failureMessage: "Undone locally, but CardDAV sync failed." })
        }
      } else {
        if (entry.action === "create" && entry.after) {
          const { error } = await supabase.from("phonebook_companies").delete().eq("id", entry.after.id)
          if (error) throw error
          refreshContactCachesInBackground()
          setCompanies((prev) => prev.filter((item) => item.id !== entry.after!.id))
          if (selectedCompany === (entry.after as Company).name) setSelectedCompany("")
        } else if (entry.action === "delete" && entry.before) {
          const { data, error } = await supabase.from("phonebook_companies").insert(entry.before as Company).select("*").single()
          if (error || !data) throw error || new Error("Unable to restore company.")
          refreshContactCachesInBackground()
          setCompanies((prev) => [...prev, data as Company].sort((a, b) => a.name.localeCompare(b.name)))
        } else if (entry.action === "update" && entry.before && entry.after) {
          const beforeCompany = entry.before as Company
          const afterCompany = entry.after as Company
          const { error } = await supabase.from("phonebook_companies").update(beforeCompany).eq("id", afterCompany.id)
          if (error) throw error
          refreshContactCachesInBackground()
          setCompanies((prev) =>
            prev.map((item) => (item.id === afterCompany.id ? beforeCompany : item)).sort((a, b) => a.name.localeCompare(b.name)),
          )
          if (beforeCompany.name !== afterCompany.name) {
            const affected = await loadCompanyContactsFromSupabase(afterCompany.name)
            for (const contact of affected) {
              const reverted = { ...contact, company: beforeCompany.name, search_text: buildContactSearchText({ ...contact, company: beforeCompany.name }) }
              const { error: contactError } = await supabase
                .from("phonebook_contacts")
                .update({ company: reverted.company, search_text: reverted.search_text })
                .eq("id", contact.id)
              if (contactError) throw contactError
            }
            setContacts((prev) => {
              if (selectedCompany && normalizeCompanyKey(selectedCompany) !== normalizeCompanyKey(afterCompany.name)) {
                return prev
              }
              return prev.map((contact) =>
                normalizeCompanyKey(contact.company) === normalizeCompanyKey(afterCompany.name)
                  ? { ...contact, company: beforeCompany.name, search_text: buildContactSearchText({ ...contact, company: beforeCompany.name }) }
                  : contact,
              )
            })
            await syncPhoneContacts(false, affected.map((contact) => contact.id), {
              successMessage: "Undone and synced.",
              failureMessage: "Undone locally, but CardDAV sync failed.",
            })
          }
        }
      }

      setChangeLog((prev) => prev.filter((item) => item.id !== entry.id))
      setMessage("Undo complete.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to undo change.")
    } finally {
      setUndoingLogId("")
    }
  }

  async function archiveCurrentContact() {
    if (!draft) return
    if (!confirm(`Archive ${draft.full_name || "this contact"} as past contact?`)) return

    const payload = {
      tel_ext: null,
      direct_line: null,
      personal_email: null,
      general_email: null,
      business_phone: null,
      business_phone_2: null,
      email_1: null,
      email_2: null,
      name_remark: "PAST CONTACT",
      favorite: false,
      search_text: buildContactSearchText({
        ...draft,
        tel_ext: null,
        direct_line: null,
        personal_email: null,
        general_email: null,
        business_phone: null,
        business_phone_2: null,
        email_1: null,
        email_2: null,
        name_remark: "PAST CONTACT",
      }),
    }

    setSaving(true)
    setMessage("")
    const { error } = await supabase.from("phonebook_contacts").update(payload).eq("id", draft.id)
    if (error) {
      setMessage("Unable to archive contact.")
      setSaving(false)
      return
    }
    refreshContactCachesInBackground()

    const nextDraft = { ...draft, ...payload }
    setContacts((prev) => prev.map((item) => (item.id === draft.id ? { ...item, ...payload } : item)))
    setCurrent((prev) => (prev ? { ...prev, ...payload } : prev))
    setDraft(nextDraft)
    setEditing(false)
    const synced = await syncPhoneContacts(false, [draft.id], {
      successMessage: "Archived and synced.",
      failureMessage: "Archived locally, but CardDAV sync failed.",
    })
    if (synced) setMessage("Archived and synced.")
    setSaving(false)
  }

  function updateField<K extends keyof Contact>(field: K, value: Contact[K]) {
    if (!draft) return
    setDraft({ ...draft, [field]: value })
  }

  function updateCapsField<K extends keyof Contact>(field: K, value: string) {
    if (!draft) return
    setDraft({ ...draft, [field]: toCaps(value) as Contact[K] })
  }

  function updateCompanyDraftField<K extends keyof Company>(field: K, value: string) {
    if (!companyDraft) return
    setCompanyDraft({ ...companyDraft, [field]: toCaps(value) as Company[K] })
  }

  function clearSearchAndSelection() {
    setQuery("")
    setCompanyRenderLimit(INITIAL_RENDERED_COMPANIES)
    setSelectedCompany("")
    setSelectedId("")
    setEditing(false)
  }

  function scheduleMenuHide() {
    if (menuHideTimerRef.current) window.clearTimeout(menuHideTimerRef.current)
    menuHideTimerRef.current = window.setTimeout(() => setMenuOpen(false), 950)
  }

  function cancelMenuHide() {
    if (menuHideTimerRef.current) {
      window.clearTimeout(menuHideTimerRef.current)
      menuHideTimerRef.current = null
    }
  }

  async function confirmAndRunFullRebuild() {
    if (!confirm("Run Full Rebuild for CardDAV? This will replace Bunker Map contacts in the CardDAV address book.")) {
      return
    }
    await syncPhoneContacts(true)
  }

  async function syncPhoneContacts(
    fullRebuild = false,
    contactIds: string[] | null = null,
    options?: {
      deleteContactIds?: string[]
      successMessage?: string
      failureMessage?: string
      silentFailure?: boolean
    },
  ) {
    setContactSyncing(true)
    setContactSyncLabel(fullRebuild ? "Starting rebuild..." : "Syncing")
    if (!options?.silentFailure) setMessage("")
    try {
      if (!fullRebuild && !contactIds?.length && !options?.deleteContactIds?.length && !selectedCompany) {
        setMessage("Select a company first, or use Full Rebuild from the menu.")
        return false
      }

      const accumulatedFailed: ContactSyncFailure[] = []
      let cursor = 0
      let lastPayload: ContactSyncResponse = {}
      let phase: "delete" | "upload" = fullRebuild ? "delete" : "upload"

      while (true) {
        const response = await fetch("/api/phonebook/carddav-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selectedCompany:
              fullRebuild || contactIds?.length || options?.deleteContactIds?.length
                ? null
                : selectedCompany || null,
            fullRebuild,
            contactIds: contactIds?.length ? contactIds : null,
            deleteContactIds: options?.deleteContactIds?.length ? options.deleteContactIds : null,
            cursor: fullRebuild ? cursor : null,
            phase: fullRebuild ? phase : null,
          }),
        })

        const payload = (await response.json().catch(() => ({}))) as ContactSyncResponse
        lastPayload = payload
        if (!response.ok) {
          if (options?.failureMessage) {
            setMessage(payload.message ? `${options.failureMessage} ${payload.message}` : options.failureMessage)
          } else if (!options?.silentFailure) {
            setMessage(payload.message || "Unable to sync CardDAV.")
          }
          return false
        }

        if (payload.failed?.length) {
          accumulatedFailed.push(...payload.failed)
        }

        if (!fullRebuild) {
          break
        }

        const total = payload.total ?? contacts.length
        const completed = Math.min(payload.nextCursor ?? total, total)
        if (payload.phase === "delete") {
          setContactSyncLabel(`Deleting ${completed}/${total}`)
          setMessage(payload.message || `Deleting existing CardDAV contacts ${completed}/${total}...`)
        } else {
          setContactSyncLabel(`Syncing ${completed}/${total}`)
          setMessage(payload.message || `Syncing CardDAV ${completed}/${total}...`)
        }

        if (payload.done || payload.nextCursor == null) {
          break
        }

        cursor = payload.nextCursor
        phase = payload.phase === "upload" ? "upload" : "delete"
      }

      const uniqueFailed = Array.from(
        new Map(accumulatedFailed.map((failure) => [failure.id, failure])).values(),
      )
      localStorage.setItem(LAST_CONTACT_SYNC_FAILED_KEY, JSON.stringify(uniqueFailed.slice(0, 50)))
      if (uniqueFailed.length > 0) {
        const firstFailure = uniqueFailed[0]
        const failurePrefix = options?.failureMessage || "CardDAV sync verification failed."
        const failureDetail = firstFailure.error || firstFailure.label
        setMessage(`${failurePrefix} ${failureDetail}`)
        return false
      }

      setMessage(options?.successMessage || lastPayload.message || "CardDAV synced.")
      return true
    } catch (error) {
      if (options?.failureMessage) {
        const fallback = error instanceof Error ? error.message : ""
        setMessage(fallback ? `${options.failureMessage} ${fallback}` : options.failureMessage)
      } else if (!options?.silentFailure) {
        setMessage("Unable to sync CardDAV.")
      }
      return false
    } finally {
      setContactSyncing(false)
      setContactSyncLabel("")
      setMenuOpen(false)
    }
  }

  async function retryFailedPhoneContacts() {
    const raw = localStorage.getItem(LAST_CONTACT_SYNC_FAILED_KEY)
    const failedEntries = raw ? (JSON.parse(raw) as ContactSyncFailure[]) : []
    if (failedEntries.length > 0) {
      const ids = failedEntries.map((entry) => entry.id).filter(Boolean)

      if (ids.length === 0) {
        setMessage("Unable to find the failed contacts in phonebook.")
        setMenuOpen(false)
        return
      }

      await syncPhoneContacts(false, ids, { successMessage: "Retried failed CardDAV contacts." })
      return
    }

    setMessage("No failed CardDAV contacts to retry.")
    setMenuOpen(false)
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      const firstCompany = visibleCompanies[0]
      if (firstCompany) companyRefs.current[firstCompany.id]?.focus()
    }
  }

  function onCompanyKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, companyId: string) {
    const index = visibleCompanies.findIndex((company) => company.id === companyId)
    if (event.key === "ArrowDown") {
      event.preventDefault()
      const next = visibleCompanies[index + 1] || visibleCompanies[0]
      if (next) companyRefs.current[next.id]?.focus()
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      const previous = visibleCompanies[index - 1] || visibleCompanies[visibleCompanies.length - 1]
      if (previous) companyRefs.current[previous.id]?.focus()
    } else if (event.key === "Enter") {
      event.preventDefault()
      setSelectedCompany(visibleCompanies[index].name)
    } else if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      const firstContact = visibleContacts[0]
      if (firstContact) contactRefs.current[firstContact.id]?.focus()
    }
  }

  function onContactKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, contactId: string) {
    const index = visibleContacts.findIndex((contact) => contact.id === contactId)
    if (event.key === "ArrowDown") {
      event.preventDefault()
      const next = visibleContacts[index + 1] || visibleContacts[0]
      if (next) contactRefs.current[next.id]?.focus()
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      const previous = visibleContacts[index - 1] || visibleContacts[visibleContacts.length - 1]
      if (previous) contactRefs.current[previous.id]?.focus()
    } else if (event.key === "Enter") {
      event.preventDefault()
      setSelectedId(visibleContacts[index].id)
    } else if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      editButtonRef.current?.focus()
    }
  }

  if (!adminLoading && !authenticated) return <p style={{ padding: 40 }}>Access Denied</p>
  if (adminLoading || loading) return <p style={{ padding: 40 }}>Loading...</p>

  const displayed = editing ? draft : current

  return (
    <div style={pageStyle}>
      <div style={{ maxWidth: "1560px", margin: "0 auto", display: "grid", gap: "14px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "12px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center", position: "relative" }}>
            <button
              onClick={() => void syncPhoneContacts(false)}
              disabled={contactSyncing}
              style={{
                ...buttonStyle,
                minWidth: "190px",
                background: "var(--fc-admin-primary-button-bg)",
                color: "var(--fc-admin-primary-button-text)",
                border: "1px solid var(--fc-admin-selected-border)",
              }}
            >
              {contactSyncing ? contactSyncLabel || "Syncing" : `Synced ${perfStats.contactCount} Contacts`}
            </button>
            <button
              type="button"
              onClick={() => {
                cancelMenuHide()
                setMenuOpen((prev) => !prev)
              }}
              onMouseEnter={cancelMenuHide}
              className="fc-admin-menu-button"
              style={buttonStyle}
            >
              ☰
            </button>
            {menuOpen ? (
              <div style={menuPanelStyle} onMouseEnter={cancelMenuHide} onMouseLeave={scheduleMenuHide}>
                <button
                  type="button"
                  onClick={() => void retryFailedPhoneContacts()}
                  disabled={contactSyncing}
                  style={buttonStyle}
                >
                  Retry Failed
                </button>
                <button
                  type="button"
                  onClick={() => void confirmAndRunFullRebuild()}
                  disabled={contactSyncing}
                  style={buttonStyle}
                >
                  Full Rebuild
                </button>
                <div style={{ display: "grid", gap: "8px" }}>
                  <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 800 }}>Log</div>
                  {changeLog.length === 0 ? (
                    <div style={{ color: "var(--fc-admin-muted)", fontSize: "12px", lineHeight: 1.5 }}>No recent changes yet.</div>
                  ) : (
                    <div style={{ display: "grid", gap: "8px" }}>
                      {changeLog.map((entry) => (
                        <div key={entry.id} style={{ ...panelStyle, padding: "10px 12px", borderRadius: "14px", boxShadow: "none" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "start" }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: "12px", fontWeight: 800, color: "var(--fc-admin-panel-text)", textTransform: "uppercase" }}>{entry.label}</div>
                              <div style={{ fontSize: "11px", color: "var(--fc-admin-muted)", marginTop: "3px", textTransform: "uppercase" }}>
                                {entry.entityType} {entry.action}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void undoLogEntry(entry)}
                              disabled={undoingLogId === entry.id}
                              style={{ ...buttonStyle, padding: "5px 9px", fontSize: "11px", background: "var(--fc-admin-primary-button-bg)", color: "var(--fc-admin-primary-button-text)" }}
                            >
                              {undoingLogId === entry.id ? "Undoing..." : "Undo"}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div style={{ ...lightBluePanelStyle, padding: "12px 14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0,1fr) auto auto", gap: "10px", alignItems: "center" }}>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => {
                const nextValue = event.target.value
                setQuery(nextValue)
                if (!nextValue.trim()) setCompanyRenderLimit(INITIAL_RENDERED_COMPANIES)
                if (selectedCompany) {
                  startTransition(() => {
                    setSelectedCompany("")
                  })
                }
              }}
              onFocus={() => {
                setQuery("")
                setCompanyRenderLimit(INITIAL_RENDERED_COMPANIES)
                setSelectedCompany("")
                setSelectedId("")
                setEditing(false)
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Search name, company, phone, or email..."
              style={inputStyle}
            />
            <button type="button" onClick={() => setQuery((value) => value.trim())} style={buttonStyle}>
              Search
            </button>
            <button type="button" onClick={clearSearchAndSelection} style={buttonStyle}>
              Clear
            </button>
          </div>
        </div>

        {showPerfDebug ? (
          <div style={{ ...panelStyle, padding: "14px 16px", display: "grid", gap: "8px" }}>
            <div style={{ fontSize: "12px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 800 }}>
              Phonebook Perf Debug
            </div>
            <div style={{ fontSize: "13px", color: "var(--fc-admin-muted)", lineHeight: 1.6 }}>
              {`companies=${perfStats.companyCount} contacts=${perfStats.contactCount} companiesFetchMs=${perfStats.companiesFetchMs ?? "-"} contactsFetchMs=${perfStats.contactsFetchMs ?? "-"} normalizeCompaniesMs=${perfStats.normalizeCompaniesMs ?? "-"} normalizeContactsMs=${perfStats.normalizeContactsMs ?? "-"} localOrderLoadMs=${perfStats.localOrderLoadMs ?? "-"} localOrderBytes=${perfStats.localOrderBytes ?? "-"} changeLogLoadMs=${perfStats.changeLogLoadMs ?? "-"} changeLogBytes=${perfStats.changeLogBytes ?? "-"}`}
            </div>
            <div style={{ fontSize: "11px", color: "var(--fc-admin-muted)", lineHeight: 1.5, wordBreak: "break-word" }}>
              {perfStats.userAgent}
            </div>
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr",
            gap: "14px",
            alignItems: "start",
          }}
        >
          <aside style={{ ...sidebarPanelStyle, maxHeight: isMobile ? "unset" : "72vh" }}>
            <div
              style={{
                position: isMobile ? "static" : "sticky",
                top: 0,
                zIndex: 2,
                display: "grid",
                gap: "8px",
                background: "var(--fc-admin-panel-soft-bg)",
                padding: "12px",
                borderBottom: "1px solid var(--fc-admin-border-soft)",
              }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "8px" }}>
                <button
                  type="button"
                  onClick={clearSearchAndSelection}
                  data-admin-button-style="preserve"
                  style={{
                    ...buttonStyle,
                    width: "100%",
                    textAlign: "left",
                    background: !selectedCompany ? "var(--fc-admin-primary-button-bg)" : buttonStyle.background,
                    color: !selectedCompany ? "var(--fc-admin-primary-button-text)" : buttonStyle.color,
                  }}
                >
                  All Companies
                </button>
                <button
                  onClick={() => void addCompany()}
                  data-admin-button-style="preserve"
                  style={{
                    ...buttonStyle,
                    background: "var(--fc-admin-primary-button-bg)",
                    color: "var(--fc-admin-primary-button-text)",
                    border: "1px solid var(--fc-admin-selected-border)",
                    whiteSpace: "nowrap",
                  }}
                >
                  New Company
                </button>
              </div>
            </div>
            {filteredCompanies.length > visibleCompanies.length ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "10px 14px", fontSize: "12px", color: "var(--fc-admin-muted)", borderBottom: "1px solid var(--fc-admin-border-soft)" }}>
                <span>
                  Showing first {visibleCompanies.length} of {filteredCompanies.length} companies. {queryTokens.length > 0 ? "Refine search for a faster exact match." : "Search to jump directly to any company."}
                </span>
                {queryTokens.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => setCompanyRenderLimit((current) => current + COMPANY_RENDER_STEP)}
                    style={{ ...buttonStyle, padding: "5px 9px", fontSize: "10px", whiteSpace: "nowrap" }}
                  >
                    Show more
                  </button>
                ) : null}
              </div>
            ) : null}
            <div style={{ maxHeight: isMobile ? "unset" : "calc(72vh - 74px)", overflowY: "auto", background: "var(--fc-admin-panel-bg)" }}>
              {visibleCompanies.map((company) => (
                <button
                  key={company.id}
                  ref={(node) => {
                    companyRefs.current[company.id] = node
                  }}
                  type="button"
                  data-admin-button-style="preserve"
                  onClick={() => setSelectedCompany(company.name)}
                  onDoubleClick={() => void openCompanyModal(company)}
                  onKeyDown={(event) => onCompanyKeyDown(event, company.id)}
                  style={{
                    ...listRowStyle,
                    background:
                      selectedCompany === company.name
                        ? "var(--fc-admin-selected-bg)"
                        : "#ffffff",
                  }}
                >
                  <span style={{ whiteSpace: "normal", lineHeight: 1.2, textAlign: "left", display: "block" }}>
                    <div style={{ textTransform: "uppercase", fontWeight: 800, fontSize: "14px" }}>{company.name || "No Company"}</div>
                    {company.other_name ? (
                      <div style={{ color: "var(--fc-admin-link)", fontSize: "12px", fontWeight: 500, marginTop: "4px" }}>
                        {company.other_name}
                      </div>
                    ) : null}
                    {formatCompanyPhoneLine(company) ? (
                      <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px", marginTop: "4px" }}>
                        {formatCompanyPhoneLine(company)}
                      </div>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section style={{ ...sidebarPanelStyle }}>
            <div
              style={{
                position: isMobile ? "static" : "sticky",
                top: 0,
                zIndex: 2,
                display: "grid",
                gap: "8px",
                background: "var(--fc-admin-panel-soft-bg)",
                padding: "12px",
                borderBottom: "1px solid var(--fc-admin-border-soft)",
              }}
            >
              <button
                onClick={() => void addContact()}
                style={{
                  ...buttonStyle,
                  width: "100%",
                  background: "var(--fc-admin-primary-button-bg)",
                  color: "var(--fc-admin-primary-button-text)",
                  border: "1px solid var(--fc-admin-selected-border)",
                }}
              >
                New Contact
              </button>
            </div>
            {contactsLoading ? (
              <div style={{ padding: "10px 14px", fontSize: "12px", color: "var(--fc-admin-muted)", borderBottom: "1px solid var(--fc-admin-border-soft)" }}>
                Loading contacts...
              </div>
            ) : null}
            {!selectedCompany && queryTokens.length === 0 ? (
              <div style={{ padding: "10px 14px", fontSize: "12px", color: "var(--fc-admin-muted)", borderBottom: "1px solid var(--fc-admin-border-soft)" }}>
                Select a company or search to load contacts.
              </div>
            ) : null}
            {!selectedCompany && queryTokens.length > 0 && searchResultsLimited ? (
              <div style={{ padding: "10px 14px", fontSize: "12px", color: "var(--fc-admin-muted)", borderBottom: "1px solid var(--fc-admin-border-soft)" }}>
                Showing the first matching contacts. Refine search for a narrower result.
              </div>
            ) : null}
            <div style={{ maxHeight: isMobile ? "unset" : "calc(72vh - 74px)", overflowY: "auto", background: "var(--fc-admin-panel-bg)" }}>
              {visibleContacts.map((contact) => (
                <button
                  key={contact.id}
                  type="button"
                  data-admin-button-style="preserve"
                  ref={(node) => {
                    contactRefs.current[contact.id] = node
                  }}
                  draggable={Boolean(selectedCompany)}
                  onClick={() => setSelectedId(contact.id)}
                  onKeyDown={(event) => onContactKeyDown(event, contact.id)}
                  onDragStart={() => {
                    setDraggingContactId(contact.id)
                    setDragOverContactId("")
                  }}
                  onDragEnd={() => {
                    setDraggingContactId("")
                    setDragOverContactId("")
                  }}
                  onDragOver={(event) => {
                    if (!selectedCompany || !draggingContactId || draggingContactId === contact.id) return
                    event.preventDefault()
                    const bounds = event.currentTarget.getBoundingClientRect()
                    const midpoint = bounds.top + bounds.height / 2
                    setDragOverContactId(contact.id)
                    setDragInsertPosition(event.clientY >= midpoint ? "after" : "before")
                  }}
                  onDragLeave={() => {
                    setDragOverContactId((prev) => (prev === contact.id ? "" : prev))
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    if (!selectedCompany || !draggingContactId || draggingContactId === contact.id) return
                    reorderCompanyContacts(selectedCompanyKey, draggingContactId, contact.id, dragInsertPosition)
                    setDraggingContactId("")
                    setDragOverContactId("")
                  }}
                  style={{
                    ...listRowStyle,
                    background: selectedId === contact.id ? "var(--fc-admin-selected-bg)" : "#ffffff",
                    minHeight: "58px",
                    opacity: draggingContactId === contact.id ? 0.72 : 1,
                    borderTop:
                      dragOverContactId === contact.id && dragInsertPosition === "before"
                        ? "2px solid var(--fc-admin-selected-border)"
                        : listRowStyle.borderTop,
                    borderBottom:
                      dragOverContactId === contact.id && dragInsertPosition === "after"
                        ? "2px solid var(--fc-admin-selected-border)"
                        : listRowStyle.borderBottom,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: "3px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: "14px", minWidth: 0, textTransform: "uppercase" }}>{contact.full_name || "(No Name)"}</div>
                      {contact.name_remark ? (
                        <span style={{ color: "var(--fc-admin-warning-text)", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 800, whiteSpace: "nowrap" }}>
                          {contact.name_remark}
                        </span>
                      ) : null}
                      {contact.tel_ext ? (
                        <span style={{ color: "var(--fc-admin-success-text)", fontSize: "11px", fontWeight: 700, whiteSpace: "nowrap" }}>
                          EXT {contact.tel_ext}
                        </span>
                      ) : null}
                    </div>
                    <div style={{ width: "58px", display: "flex", justifyContent: "flex-end", flex: "0 0 58px" }}>
                      {selectedCompany ? <span style={{ color: "var(--fc-admin-link)", fontSize: "14px", fontWeight: 700, letterSpacing: "0.08em" }}>↕</span> : null}
                    </div>
                  </div>
                  <div style={{ color: "var(--fc-admin-link)", fontSize: "12px", textTransform: "uppercase" }}>{normalizeCompanyName(contact.company)}</div>
                </button>
              ))}
            </div>
          </section>

          <section style={{ ...lightBluePanelStyle, padding: "16px", display: "grid", gap: "12px" }}>
            {displayed ? (
              <>
                <div style={{ display: "grid", gap: "10px" }}>
                  {editing ? (
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                      <button onClick={() => void saveCurrent()} disabled={saving} style={{ ...buttonStyle, padding: "6px 10px", fontSize: "11px", background: "var(--fc-admin-success-bg)", color: "var(--fc-admin-success-text)", border: "1px solid var(--fc-admin-success-border)" }}>
                        {saving ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={() => void archiveCurrentContact()}
                        disabled={saving}
                        style={{ ...buttonStyle, padding: "6px 10px", fontSize: "11px", background: "var(--fc-admin-warning-bg)", color: "var(--fc-admin-warning-text)", border: "1px solid var(--fc-admin-warning-border)" }}
                      >
                        Archive
                      </button>
                      <button onClick={() => void deleteCurrent()} style={{ ...buttonStyle, padding: "6px 10px", fontSize: "11px", background: "var(--fc-admin-danger-bg)", color: "var(--fc-admin-danger-text)", border: "1px solid var(--fc-admin-danger-border)" }}>
                        Delete
                      </button>
                      <button onClick={() => setEditing(false)} style={{ ...buttonStyle, padding: "6px 10px", fontSize: "11px" }}>Cancel</button>
                    </div>
                  ) : null}
                  {!editing ? (
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(buildContactClipboardText(current || displayed), (status) => {
                            if (status === "Copied") setCopiedKey("contact-all")
                          })
                        }
                        style={{
                          ...buttonStyle,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "7px 11px",
                          background: "var(--fc-admin-primary-button-bg)",
                          color: "var(--fc-admin-primary-button-text)",
                          border: "1px solid var(--fc-admin-selected-border)",
                        }}
                      >
                        <CopyIcon copied={copiedKey === "contact-all"} />
                        {copiedKey === "contact-all" ? "Copied" : "Copy Contact"}
                      </button>
                      <button
                        ref={editButtonRef}
                        onClick={() => {
                          setDraft(current ? { ...current } : null)
                          setEditing(true)
                        }}
                        disabled={!current}
                        style={{
                          ...buttonStyle,
                          padding: "7px 11px",
                          background: "var(--fc-admin-warning-bg)",
                          color: "var(--fc-admin-warning-text)",
                          border: "1px solid var(--fc-admin-warning-border)",
                        }}
                      >
                        Edit
                      </button>
                    </div>
                  ) : null}
                  <div>
                    <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "6px" }}>Name</div>
                    {editing ? (
                      <input value={draft?.full_name || ""} onChange={(event) => updateCapsField("full_name", event.target.value)} style={detailInputStyle} />
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "2px 0" }}>
                        <span style={{ fontSize: "15px", fontWeight: 800, lineHeight: 1.5, textTransform: "uppercase" }}>{current?.full_name || "(No Name)"}</span>
                        <button
                          type="button"
                          onClick={() =>
                            copyToClipboard(current?.full_name || "", (status) => {
                              if (status === "Copied") setCopiedKey("name")
                            })
                          }
                          style={iconButtonStyle}
                          title="Copy name"
                          aria-label="Copy name"
                        >
                          <CopyIcon copied={copiedKey === "name"} />
                        </button>
                        {copiedKey === "name" ? <span style={{ color: "var(--fc-admin-success-text)", fontSize: "12px", fontWeight: 700 }}>Copied</span> : null}
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "6px" }}>Company</div>
                  {editing ? (
                    <div style={{ position: "relative" }}>
                      <input
                        value={draft?.company || ""}
                        onChange={(event) => {
                          updateCapsField("company", event.target.value)
                          setCompanySuggestOpen(true)
                        }}
                        onFocus={() => setCompanySuggestOpen(true)}
                        onBlur={() => {
                          window.setTimeout(() => setCompanySuggestOpen(false), 120)
                        }}
                        style={detailInputStyle}
                      />
                      {companySuggestOpen && companyInputSuggestions.length > 0 ? (
                        <div
                          style={{
                            position: "absolute",
                            zIndex: 20,
                            left: 0,
                            right: 0,
                            top: "calc(100% + 4px)",
                            maxHeight: "180px",
                            overflowY: "auto",
                            borderRadius: "10px",
                            border: "1px solid var(--fc-admin-border-soft)",
                            background: "var(--fc-admin-panel-bg)",
                            padding: "4px",
                            display: "grid",
                            gap: "3px",
                          }}
                        >
                          {companyInputSuggestions.map((name) => (
                            <button
                              key={name}
                              type="button"
                              onMouseDown={(event) => {
                                event.preventDefault()
                                updateCapsField("company", name)
                                setCompanySuggestOpen(false)
                              }}
                              style={{
                                textAlign: "left",
                                padding: "6px 8px",
                                borderRadius: "8px",
                                border: "1px solid var(--fc-admin-border-soft)",
                                background: "var(--fc-admin-panel-soft-bg)",
                                color: "var(--fc-admin-panel-text)",
                                fontSize: "12px",
                                cursor: "pointer",
                              }}
                            >
                              {name}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : current?.company ? (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "2px 0" }}>
                      <span style={{ fontSize: "15px", lineHeight: 1.5, textTransform: "uppercase" }}>{current.company}</span>
                      <button
                        onClick={() =>
                          copyToClipboard(current.company || "", (status) => {
                            if (status === "Copied") setCopiedKey("company")
                          })
                        }
                        style={iconButtonStyle}
                        title="Copy"
                        aria-label="Copy company"
                      >
                        <CopyIcon copied={copiedKey === "company"} />
                      </button>
                      {copiedKey === "company" ? <span style={{ color: "var(--fc-admin-success-text)", fontSize: "12px", fontWeight: 700 }}>Copied</span> : null}
                    </div>
                  ) : null}
                </div>

                <div style={{ display: "grid", gap: "12px" }}>
                  <div style={modalSectionStyle}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "10px" }}>
                      {editing ? (
                        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "10px" }}>
                          <div>
                            <div style={sectionLabelStyle}>Title</div>
                            <select
                              value={(draft?.title as string) || ""}
                              onChange={(event) => updateField("title", event.target.value as never)}
                              style={selectStyle}
                            >
                              <option value="">Select title</option>
                              {TITLE_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <div style={sectionLabelStyle}>Label</div>
                            <input value={draft?.name_remark || ""} onChange={(event) => updateCapsField("name_remark", event.target.value)} style={detailInputStyle} />
                          </div>
                        </div>
                      ) : (
                        <>
                          {displayed.title ? (
                            <div>
                              <div style={sectionLabelStyle}>Title</div>
                              <div style={{ fontSize: "15px", lineHeight: 1.5, padding: "2px 0" }}>{displayed.title}</div>
                            </div>
                          ) : null}
                          {displayed.name_remark ? (
                            <div>
                              <div style={sectionLabelStyle}>Label</div>
                              <div style={{ fontSize: "15px", lineHeight: 1.5, padding: "2px 0", color: "var(--fc-admin-warning-text)", textTransform: "uppercase", fontWeight: 700 }}>{displayed.name_remark}</div>
                            </div>
                          ) : null}
                        </>
                      )}
                      {[
                        ["Ext", "tel_ext"],
                        ["Direct line", "direct_line"],
                        ["Mobile 1", "mobile_1"],
                        ["Mobile 2", "mobile_2"],
                        ["Personal Email", "personal_email"],
                        ["General Email", "general_email"],
                        ["Private Email", "private_email"],
                      ].map(([label, field]) => {
                        const key = field as keyof Contact
                        const value = displayed[key] as string | null
                        if (!editing && !value) return null
                        return (
                          <div key={field}>
                            <div style={sectionLabelStyle}>{label}</div>
                            {editing ? (
                              <input
                                value={(draft?.[key] as string) || ""}
                                onChange={(event) =>
                                  key === "personal_email" || key === "general_email" || key === "private_email"
                                    ? updateField(key, event.target.value as never)
                                    : updateCapsField(key, event.target.value)
                                }
                                style={detailInputStyle}
                              />
                            ) : (
                              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "2px 0" }}>
                                <span style={{ fontSize: "15px", lineHeight: 1.5 }}>{value}</span>
                                <button
                                  onClick={() =>
                                    copyToClipboard(value || "", (status) => {
                                      if (status === "Copied") setCopiedKey(field)
                                    })
                                  }
                                  style={iconButtonStyle}
                                  title="Copy"
                                  aria-label={`Copy ${label}`}
                                >
                                  <CopyIcon copied={copiedKey === field} />
                                </button>
                                {copiedKey === field ? <span style={{ color: "var(--fc-admin-success-text)", fontSize: "12px", fontWeight: 700 }}>Copied</span> : null}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                </div>
              </>
            ) : (
              <div style={{ color: "var(--fc-admin-muted)", fontSize: "14px", lineHeight: 1.6 }}>Select a contact to view details.</div>
            )}
          </section>
        </div>

        {message && (
          <div style={{ color: message.startsWith("Unable") ? "var(--fc-admin-danger-text)" : "var(--fc-admin-success-text)", fontWeight: 700 }}>
            {message}
          </div>
        )}
      </div>

      {companyModalOpen && companyDraft ? (
        <div style={modalOverlayStyle}>
          <div
            style={modalCardStyle}
            role="dialog"
            aria-modal="true"
            aria-label={creatingCompany ? "New company" : "Company details"}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "16px" }}>
              <div>
                <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "6px" }}>Company</div>
                <div style={{ fontSize: "24px", fontWeight: 800, lineHeight: 1.15 }}>{companyDraft.name || "(No Name)"}</div>
              </div>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                <button
                  onClick={() => void saveCompany()}
                  disabled={companySaving}
                  style={{
                    ...buttonStyle,
                    background: "var(--fc-admin-success-bg)",
                    color: "var(--fc-admin-success-text)",
                    border: "1px solid var(--fc-admin-success-border)",
                    minWidth: "84px",
                  }}
                >
                  {companySaving ? "Saving..." : "Save"}
                </button>
                {!creatingCompany ? (
                  <button
                    onClick={() => void deleteCompany()}
                    style={{
                      ...buttonStyle,
                      background: "var(--fc-admin-danger-bg)",
                      color: "var(--fc-admin-danger-text)",
                      border: "1px solid var(--fc-admin-danger-border)",
                      minWidth: "84px",
                    }}
                  >
                    Delete
                  </button>
                ) : null}
                <button onClick={closeCompanyModal} style={{ ...buttonStyle, minWidth: "84px" }}>
                  Close
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gap: "12px" }}>
              <div style={modalSectionStyle}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "12px" }}>
                      <div>
                        <div style={sectionLabelStyle}>Company Name</div>
                        <input value={companyDraft.name || ""} onChange={(event) => updateCompanyDraftField("name", event.target.value)} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Other Name</div>
                    <input value={companyDraft.other_name || ""} onChange={(event) => updateCompanyDraftField("other_name", event.target.value)} style={detailInputStyle} />
                  </div>
                  <div style={{ gridColumn: isMobile ? "auto" : "1 / -1" }}>
                    <div style={sectionLabelStyle}>Address</div>
                    <textarea
                      value={companyDraft.address || ""}
                      onChange={(event) => updateCompanyDraftField("address", event.target.value)}
                      style={{ ...detailInputStyle, minHeight: "90px", resize: "vertical", fontFamily: "var(--fc-admin-font)", lineHeight: 1.5 }}
                    />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Country</div>
                    <select
                      value={companyDraft.country || ""}
                      onChange={(event) =>
                        setCompanyDraft({
                          ...companyDraft,
                          country: event.target.value || null,
                          tel_country: getCountryCode(event.target.value) || null,
                        })
                      }
                      style={selectStyle}
                    >
                      <option value="">Select country</option>
                      {COUNTRY_OPTIONS.map((country) => (
                        <option key={country.name} value={country.name}>
                          {country.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Country Code</div>
                    <input value={companyDraft.tel_country || ""} readOnly style={{ ...detailInputStyle, opacity: 0.88 }} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Area Code</div>
                    <input value={companyDraft.tel_area || ""} onChange={(event) => updateCompanyDraftField("tel_area", event.target.value)} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Telephone</div>
                    <input
                      value={companyDraft.tel_no_1 || ""}
                      onChange={(event) => setCompanyDraft({ ...companyDraft, tel_no_1: toCaps(event.target.value), phone: toCaps(event.target.value) })}
                      style={detailInputStyle}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {contactModalOpen && draft ? (
        <div style={modalOverlayStyle}>
          <div
            style={modalCardStyle}
            role="dialog"
            aria-modal="true"
            aria-label={creatingContact ? "New contact" : "Contact details"}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "16px" }}>
              <div>
                <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "6px" }}>Contact</div>
                <div style={{ fontSize: "24px", fontWeight: 800, lineHeight: 1.15 }}>{draft.full_name || "(NO NAME)"}</div>
              </div>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                <button
                  onClick={() => void saveCurrent()}
                  disabled={saving}
                  style={{
                    ...buttonStyle,
                    background: "var(--fc-admin-success-bg)",
                    color: "var(--fc-admin-success-text)",
                    border: "1px solid var(--fc-admin-success-border)",
                    minWidth: "84px",
                  }}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                <button onClick={closeContactModal} style={{ ...buttonStyle, minWidth: "84px" }}>
                  Close
                </button>
              </div>
            </div>

              <div style={modalSectionStyle}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "12px" }}>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "12px" }}>
                  <div>
                    <div style={sectionLabelStyle}>Title</div>
                    <select
                      value={(draft.title as string) || ""}
                      onChange={(event) => updateField("title", event.target.value as never)}
                      style={selectStyle}
                    >
                      <option value="">Select title</option>
                      {TITLE_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Label</div>
                    <input value={draft.name_remark || ""} onChange={(event) => updateCapsField("name_remark", event.target.value)} style={detailInputStyle} />
                  </div>
                </div>
                {[
                  ["Name", "full_name"],
                  ["Company", "company"],
                  ["Ext", "tel_ext"],
                  ["Direct line", "direct_line"],
                  ["Mobile 1", "mobile_1"],
                  ["Mobile 2", "mobile_2"],
                  ["Personal Email", "personal_email"],
                  ["General Email", "general_email"],
                  ["Private Email", "private_email"],
                ].map(([label, field]) => {
                  const key = field as keyof Contact
                  if (key === "company") {
                    return (
                      <div key={field}>
                        <div style={sectionLabelStyle}>Company</div>
                        <div style={{ position: "relative" }}>
                          <input
                            value={draft.company || ""}
                            placeholder="Search existing companies"
                            onChange={(event) => {
                              updateCapsField("company", event.target.value)
                              setCompanySuggestOpen(true)
                            }}
                            onFocus={() => setCompanySuggestOpen(true)}
                            onBlur={() => {
                              window.setTimeout(() => setCompanySuggestOpen(false), 120)
                            }}
                            style={detailInputStyle}
                          />
                          {companySuggestOpen && companyInputSuggestions.length > 0 ? (
                            <div
                              style={{
                                position: "absolute",
                                zIndex: 30,
                                left: 0,
                                right: 0,
                                top: "calc(100% + 4px)",
                                maxHeight: "190px",
                                overflowY: "auto",
                                borderRadius: "10px",
                                border: "1px solid var(--fc-admin-border-soft)",
                                background: "var(--fc-admin-panel-bg)",
                                padding: "4px",
                                display: "grid",
                                gap: "3px",
                              }}
                            >
                              {companyInputSuggestions.map((name) => (
                                <button
                                  key={name}
                                  type="button"
                                  onMouseDown={(event) => {
                                    event.preventDefault()
                                    updateCapsField("company", name)
                                    setCompanySuggestOpen(false)
                                  }}
                                  style={{
                                    textAlign: "left",
                                    padding: "7px 9px",
                                    borderRadius: "8px",
                                    border: "1px solid var(--fc-admin-border-soft)",
                                    background: "var(--fc-admin-panel-soft-bg)",
                                    color: "var(--fc-admin-panel-text)",
                                    fontSize: "12px",
                                    cursor: "pointer",
                                  }}
                                >
                                  {name}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )
                  }

                  return (
                    <div key={field}>
                      <div style={sectionLabelStyle}>{label}</div>
                      <input
                        value={(draft[key] as string) || ""}
                        onChange={(event) =>
                          key === "personal_email" || key === "general_email" || key === "private_email"
                            ? updateField(key, event.target.value as never)
                            : updateCapsField(key, event.target.value)
                        }
                        style={detailInputStyle}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
