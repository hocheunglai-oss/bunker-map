"use client"

import { useEffect, useMemo, useRef, useState } from "react"
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

type PinHoverState = string | null
type CompanyDraft = Company | null

const LAST_GOOGLE_SYNC_FAILED_KEY = "phonebook_last_google_sync_failed"

type GoogleSyncFailure = {
  id: string
  label: string
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
  background: "linear-gradient(180deg, #0a2c4c 0%, #06213b 32%, #041629 100%)",
  fontFamily: "Arial, Helvetica, sans-serif",
  color: "#edf7ff",
  padding: "18px",
}

const panelStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(14, 43, 70, 0.88) 0%, rgba(7, 26, 44, 0.86) 100%)",
  border: "1px solid rgba(210, 236, 255, 0.14)",
  borderRadius: "18px",
  boxShadow: "0 20px 44px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255,255,255,0.05)",
}

const buttonStyle: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: "999px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  textDecoration: "none",
  fontSize: "12px",
  fontWeight: 700,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 24px rgba(8,24,44,0.16)",
  cursor: "pointer",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: "14px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 100%)",
  color: "#edf7ff",
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
  background: "linear-gradient(180deg, rgba(248, 252, 255, 0.98) 0%, rgba(235, 244, 252, 0.96) 100%)",
  color: "#10243a",
}

const iconButtonStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#bfe3ff",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "13px",
  fontWeight: 800,
  cursor: "pointer",
  padding: 0,
  lineHeight: 1,
}

const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(2, 10, 20, 0.62)",
  backdropFilter: "blur(4px)",
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
  color: "#8fd7ff",
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
  ...panelStyle,
  position: "absolute",
  top: "calc(100% + 8px)",
  right: 0,
  padding: "10px",
  display: "grid",
  gap: "8px",
  zIndex: 20,
  minWidth: "180px",
}

const sidebarPanelStyle: React.CSSProperties = {
  ...panelStyle,
  padding: "0",
  display: "grid",
  background: "linear-gradient(180deg, rgba(20, 66, 112, 0.92) 0%, rgba(10, 39, 74, 0.9) 100%)",
  border: "1px solid rgba(126, 185, 255, 0.16)",
  borderRadius: "20px",
  overflow: "hidden",
}

const listRowStyle: React.CSSProperties = {
  width: "100%",
  border: "none",
  background: "transparent",
  borderBottom: "1px solid rgba(210,236,255,0.08)",
  textAlign: "left",
  padding: "11px 14px",
  color: "#edf7ff",
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

function copyToClipboard(value: string, onDone: (message: string) => void) {
  navigator.clipboard
    .writeText(value)
    .then(() => onDone("Copied."))
    .catch(() => onDone("Unable to copy."))
}

function normalizeDialablePhone(value: string | null | undefined) {
  const trimmed = (value || "").trim()
  if (!trimmed) return null
  if (trimmed.startsWith("+")) return trimmed

  const digits = trimmed.replace(/[^\d]/g, "")
  const looksLikeHongKongLocal =
    digits.length === 8 && !trimmed.includes("-") && !trimmed.includes("(") && !trimmed.includes(")")

  if (looksLikeHongKongLocal) return digits
  if (/^\d{1,4}-/.test(trimmed)) return `+${trimmed}`
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
  const [selectedCompany, setSelectedCompany] = useState("")
  const [selectedId, setSelectedId] = useState("")
  const [current, setCurrent] = useState<Contact | null>(null)
  const [draft, setDraft] = useState<Contact | null>(null)
  const [message, setMessage] = useState("")
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [pinHoverId, setPinHoverId] = useState<PinHoverState>(null)
  const [companyModalOpen, setCompanyModalOpen] = useState(false)
  const [companyDraft, setCompanyDraft] = useState<CompanyDraft>(null)
  const [companySaving, setCompanySaving] = useState(false)
  const [googleSyncing, setGoogleSyncing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [creatingCompany, setCreatingCompany] = useState(false)

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

  function normalizeLoadedCompanies(companyData: Company[]) {
    return companyData.map((company) => ({
      ...company,
      name: company.name?.toUpperCase?.() || company.name,
      other_name: company.other_name?.toUpperCase?.() || company.other_name,
      address: company.address?.toUpperCase?.() || company.address,
      country: normalizeCountryName(company.country) || null,
      tel_country: company.tel_country || getCountryCode(company.country) || null,
      tel_area: company.tel_area?.toUpperCase?.() || company.tel_area,
      tel_no_1: company.tel_no_1?.toUpperCase?.() || company.tel_no_1,
      tel_no_2: company.tel_no_2?.toUpperCase?.() || company.tel_no_2,
    }))
  }

  async function loadContacts() {
    const allContacts: Contact[] = []
    const pageSize = 1000
    let from = 0

    while (true) {
      const result = await supabase
        .from("phonebook_contacts")
        .select("*")
        .order("favorite", { ascending: false })
        .order("full_name", { ascending: true })
        .range(from, from + pageSize - 1)

      if (result.error) {
        throw result.error
      }

      const batch = (result.data as Contact[]) || []
      allContacts.push(...batch)
      if (batch.length < pageSize) break
      from += pageSize
    }

    return allContacts
  }

  async function loadCompanies() {
    const allCompanies: Company[] = []
    const pageSize = 1000
    let from = 0

    while (true) {
      const result = await supabase
        .from("phonebook_companies")
        .select("*")
        .order("name", { ascending: true })
        .range(from, from + pageSize - 1)

      if (result.error) {
        throw result.error
      }

      const batch = (result.data as Company[]) || []
      allCompanies.push(...batch)
      if (batch.length < pageSize) break
      from += pageSize
    }

    return allCompanies
  }

  async function loadAll() {
    setLoading(true)
    try {
      const [companyData, contactData] = await Promise.all([loadCompanies(), loadContacts()])
      setCompanies(normalizeLoadedCompanies(companyData))
      setContacts(normalizeLoadedContacts(contactData))
    } catch {
      setMessage("Unable to load phonebook.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (adminLoading || !authenticated) return
    void loadAll()
  }, [adminLoading, authenticated])

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

  const queryTokens = useMemo(() => buildSearchTokens(query), [query])
  const selectedCompanyKey = useMemo(() => normalizeCompanyKey(selectedCompany), [selectedCompany])

  const companiesWithMatchingContacts = useMemo(() => {
    if (queryTokens.length === 0) return new Set<string>()

    return new Set(
      contacts
        .filter((contact) => {
          const haystack = contact.search_text || ""
          return queryTokens.every((token) => haystack.includes(token))
        })
        .map((contact) => normalizeCompanyKey(contact.company))
    )
  }, [contacts, queryTokens])

  const filteredCompanies = useMemo(() => {
    if (queryTokens.length === 0) return companies
    return companies.filter((company) => {
      const haystack = company.name.toLowerCase()
      const matchesCompanyName = queryTokens.every((token) => haystack.includes(token))
      return matchesCompanyName || companiesWithMatchingContacts.has(normalizeCompanyKey(company.name))
    })
  }, [companies, companiesWithMatchingContacts, queryTokens])

  const filteredContacts = useMemo(() => {
    let next = contacts.filter((contact) => {
      const matchesCompany = !selectedCompany || normalizeCompanyKey(contact.company) === selectedCompanyKey
      const haystack = contact.search_text || ""
      const matchesQuery =
        selectedCompany
          ? true
          : queryTokens.length === 0 || queryTokens.every((token) => haystack.includes(token))
      return matchesCompany && matchesQuery
    })

    next = [...next].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
      return (a.full_name || "").localeCompare(b.full_name || "")
    })
    return next
  }, [contacts, queryTokens, selectedCompany, selectedCompanyKey])

  async function saveCurrent() {
    if (!draft) return
    setSaving(true)
    setMessage("")
    const payload = {
      full_name: draft.full_name.trim().toUpperCase(),
      company: draft.company?.trim().toUpperCase() || null,
      company_source_id: draft.company_source_id?.trim() || null,
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
      favorite: draft.favorite,
      search_text: buildContactSearchText(draft),
    }

    const { error } = await supabase.from("phonebook_contacts").update(payload).eq("id", draft.id)
    if (error) {
      setMessage("Unable to save contact.")
      setSaving(false)
      return
    }

    setContacts((prev) => prev.map((item) => (item.id === draft.id ? { ...item, ...payload } : item)))
    setCurrent((prev) => (prev ? { ...prev, ...payload } : prev))
    setEditing(false)
    await syncGoogleContacts(false, [draft.id], {
      successMessage: "Saved and synced.",
      failureMessage: "Saved locally. Google sync needs to be run from your local setup.",
    })
    setSaving(false)
  }

  async function deleteCurrent() {
    if (!current) return
    if (!confirm(`Delete ${current.full_name}?`)) return
    const deletingId = current.id
    const { error } = await supabase.from("phonebook_contacts").delete().eq("id", current.id)
    if (error) {
      setMessage("Unable to delete contact.")
      return
    }
    setContacts((prev) => prev.filter((item) => item.id !== current.id))
    setSelectedId("")
    await syncGoogleContacts(false, null, {
      deleteContactIds: [deletingId],
      successMessage: "Deleted and synced.",
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
      source_key: `manual-company-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    })
    setCompanyModalOpen(true)
    setMessage("")
  }

  function openCompanyModal(company: Company) {
    setCompanyDraft({
      ...company,
      country: normalizeCountryName(company.country) || null,
      tel_country: company.tel_country || getCountryCode(company.country) || null,
    })
    setCompanyModalOpen(true)
    setMessage("")
  }

  function closeCompanyModal() {
    setCompanyModalOpen(false)
    setCompanyDraft(null)
    setCompanySaving(false)
    setCreatingCompany(false)
  }

  async function saveCompany() {
    if (!companyDraft) return
    setCompanySaving(true)
    setMessage("")
    const previousCompanyName = companyDraft.name.trim().toUpperCase()
    const payload = {
      name: companyDraft.name.trim().toUpperCase(),
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

    setCompanies((prev) => {
      const next = creatingCompany
        ? [...prev, data as Company]
        : prev.map((item) => (item.id === companyDraft.id ? (data as Company) : item))
      return next.sort((a, b) => a.name.localeCompare(b.name))
    })

    const affectedContacts = contacts.filter(
      (contact) => normalizeCompanyKey(contact.company) === normalizeCompanyKey(previousCompanyName),
    )
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

      setContacts((prev) =>
        prev.map((contact) => {
          const updated = nextContacts.find((item) => item.id === contact.id)
          return updated ? updated : contact
        }),
      )
      if (current && contactIds.includes(current.id)) {
        const updatedCurrent = nextContacts.find((contact) => contact.id === current.id) || null
        setCurrent(updatedCurrent)
        setDraft(updatedCurrent ? { ...updatedCurrent } : null)
      }
    }

    if (creatingCompany) {
      setSelectedCompany(payload.name)
      setMessage("New company added.")
    } else {
      if (selectedCompany === companyDraft.name && payload.name !== companyDraft.name) {
        setSelectedCompany(payload.name)
      }
      setMessage("Company saved.")
    }

    setCompanyDraft(data as Company)
    setCompanySaving(false)
    setCompanyModalOpen(false)
    setCreatingCompany(false)

    if (!creatingCompany && previousCompanyName === payload.name) {
      syncedContactIds = contacts
        .filter((contact) => normalizeCompanyKey(contact.company) === normalizeCompanyKey(payload.name))
        .map((contact) => contact.id)
    }

    if (syncedContactIds.length > 0) {
      await syncGoogleContacts(false, syncedContactIds, {
        successMessage: "Company saved and synced.",
        failureMessage: "Company saved locally. Google sync needs to be run from your local setup.",
      })
    }
  }

  async function deleteCompany() {
    if (!companyDraft || creatingCompany) return
    if (!confirm(`Delete ${companyDraft.name || "this company"}?`)) return
    const companyNameToDelete = companyDraft.name
    const companyContactIds = contacts
      .filter((contact) => normalizeCompanyKey(contact.company) === normalizeCompanyKey(companyNameToDelete))
      .map((contact) => contact.id)

    const { error } = await supabase.from("phonebook_companies").delete().eq("id", companyDraft.id)
    if (error) {
      setMessage("Unable to delete company.")
      return
    }

    setCompanies((prev) => prev.filter((item) => item.id !== companyDraft.id))
    if (selectedCompany === companyDraft.name) {
      setSelectedCompany("")
    }
    setCompanyModalOpen(false)
    setCompanyDraft(null)
    setCreatingCompany(false)
    if (companyContactIds.length > 0) {
      await syncGoogleContacts(false, null, {
        deleteContactIds: companyContactIds,
        successMessage: "Company deleted and Google contacts updated.",
        failureMessage: "Company deleted locally. Google sync needs to be run from your local setup.",
      })
    } else {
      setMessage("Company deleted.")
    }
  }

  async function addContact() {
    const payload = {
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
      source_key: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      search_text: selectedCompany.toLowerCase(),
    }
    const { data, error } = await supabase.from("phonebook_contacts").insert(payload).select("*").single()
    if (error || !data) {
      setMessage("Unable to add contact.")
      return
    }
    setContacts((prev) => [data as Contact, ...prev])
    setSelectedId((data as Contact).id)
    setEditing(true)
    setMessage("New contact added.")
  }

  async function togglePinned(contact: Contact) {
    if (!selectedCompany) return
    const nextFavorite = !contact.favorite
    const { error } = await supabase.from("phonebook_contacts").update({ favorite: nextFavorite }).eq("id", contact.id)
    if (error) {
      setMessage("Unable to update priority.")
      return
    }
    setContacts((prev) => prev.map((item) => (item.id === contact.id ? { ...item, favorite: nextFavorite } : item)))
    if (draft?.id === contact.id) setDraft({ ...draft, favorite: nextFavorite })
    if (current?.id === contact.id) setCurrent({ ...current, favorite: nextFavorite })
    setMessage(nextFavorite ? "Pinned to top." : "Removed from top.")
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

  async function syncGoogleContacts(
    fullRebuild = false,
    contactIds: string[] | null = null,
    options?: {
      deleteContactIds?: string[]
      successMessage?: string
      retryMissing?: boolean
      failureMessage?: string
      silentFailure?: boolean
    },
  ) {
    setGoogleSyncing(true)
    if (!options?.silentFailure) setMessage("")
    try {
      if (!fullRebuild && !contactIds?.length && !options?.deleteContactIds?.length && !options?.retryMissing && !selectedCompany) {
        setMessage("Select a company first, or use Full Rebuild from the menu.")
        return false
      }

      const response = await fetch("/api/phonebook/google-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedCompany: fullRebuild ? null : selectedCompany || null,
          fullRebuild,
          contactIds: contactIds?.length ? contactIds : null,
          deleteContactIds: options?.deleteContactIds?.length ? options.deleteContactIds : null,
          retryMissing: Boolean(options?.retryMissing),
        }),
      })

      const payload = (await response.json().catch(() => ({}))) as { message?: string; failed?: GoogleSyncFailure[] }
      if (!response.ok) {
        if (options?.failureMessage) {
          setMessage(options.failureMessage)
        } else if (!options?.silentFailure) {
          setMessage(payload.message || "Unable to sync Google Contacts.")
        }
        return false
      }

      if (payload.failed) {
        localStorage.setItem(LAST_GOOGLE_SYNC_FAILED_KEY, JSON.stringify(payload.failed))
      }
      setMessage(options?.successMessage || payload.message || "Google Contacts synced.")
      return true
    } catch {
      if (options?.failureMessage) {
        setMessage(options.failureMessage)
      } else if (!options?.silentFailure) {
        setMessage("Unable to sync Google Contacts.")
      }
      return false
    } finally {
      setGoogleSyncing(false)
      setMenuOpen(false)
    }
  }

  async function retryFailedGoogleContacts() {
    const raw = localStorage.getItem(LAST_GOOGLE_SYNC_FAILED_KEY)
    const failedEntries = raw ? (JSON.parse(raw) as GoogleSyncFailure[]) : []
    if (failedEntries.length > 0) {
      const ids = failedEntries.map((entry) => entry.id).filter(Boolean)

      if (ids.length === 0) {
        setMessage("Unable to find the failed contacts in phonebook.")
        setMenuOpen(false)
        return
      }

      await syncGoogleContacts(false, ids, { successMessage: "Retried failed Google contacts." })
      return
    }

    await syncGoogleContacts(false, null, {
      retryMissing: true,
      successMessage: "Retried missing Google contacts.",
    })
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      const firstCompany = filteredCompanies[0]
      if (firstCompany) companyRefs.current[firstCompany.id]?.focus()
    }
  }

  function onCompanyKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, companyId: string) {
    const index = filteredCompanies.findIndex((company) => company.id === companyId)
    if (event.key === "ArrowDown") {
      event.preventDefault()
      const next = filteredCompanies[index + 1] || filteredCompanies[0]
      if (next) companyRefs.current[next.id]?.focus()
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      const previous = filteredCompanies[index - 1] || filteredCompanies[filteredCompanies.length - 1]
      if (previous) companyRefs.current[previous.id]?.focus()
    } else if (event.key === "Enter") {
      event.preventDefault()
      setSelectedCompany(filteredCompanies[index].name)
    } else if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      const firstContact = filteredContacts[0]
      if (firstContact) contactRefs.current[firstContact.id]?.focus()
    }
  }

  function onContactKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, contactId: string) {
    const index = filteredContacts.findIndex((contact) => contact.id === contactId)
    if (event.key === "ArrowDown") {
      event.preventDefault()
      const next = filteredContacts[index + 1] || filteredContacts[0]
      if (next) contactRefs.current[next.id]?.focus()
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      const previous = filteredContacts[index - 1] || filteredContacts[filteredContacts.length - 1]
      if (previous) contactRefs.current[previous.id]?.focus()
    } else if (event.key === "Enter") {
      event.preventDefault()
      setSelectedId(filteredContacts[index].id)
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "12px", letterSpacing: "0.16em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>Trading Tools</div>
            <h1 style={{ margin: "6px 0 0", fontSize: "28px", lineHeight: 1.05 }}>Phonebook</h1>
          </div>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center", position: "relative" }}>
            <a href="/admin" style={buttonStyle}>Back To Admin</a>
            <button
              onClick={() => void syncGoogleContacts(false)}
              disabled={googleSyncing}
              style={{
                ...buttonStyle,
                minWidth: "190px",
                background: "linear-gradient(180deg, rgba(66, 133, 244, 0.34) 0%, rgba(52, 168, 83, 0.16) 100%)",
                color: "#f4f8ff",
                border: "1px solid rgba(126, 180, 255, 0.28)",
              }}
            >
              {googleSyncing ? "Syncing" : `Synced ${contacts.length} Contacts`}
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((prev) => !prev)}
              style={buttonStyle}
            >
              ☰
            </button>
            {menuOpen ? (
              <div style={menuPanelStyle}>
                <button
                  type="button"
                  onClick={() => void retryFailedGoogleContacts()}
                  disabled={googleSyncing}
                  style={buttonStyle}
                >
                  Retry Failed
                </button>
                <button
                  type="button"
                  onClick={() => void syncGoogleContacts(true)}
                  disabled={googleSyncing}
                  style={buttonStyle}
                >
                  Full Rebuild
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div style={{ ...panelStyle, padding: "12px 14px" }}>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              if (selectedCompany) setSelectedCompany("")
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search name, company, phone, or email..."
            style={inputStyle}
          />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "420px minmax(280px, 360px) minmax(0, 1fr)",
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
                background: "linear-gradient(180deg, rgba(12, 49, 88, 0.98) 0%, rgba(8, 34, 62, 0.98) 100%)",
                padding: "12px",
                borderBottom: "1px solid rgba(210,236,255,0.08)",
              }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "8px" }}>
                <button
                  type="button"
                  onClick={() => setSelectedCompany("")}
                  style={{
                    ...buttonStyle,
                    width: "100%",
                    textAlign: "left",
                    background: !selectedCompany ? "linear-gradient(180deg, rgba(76, 164, 255, 0.34) 0%, rgba(31, 82, 143, 0.18) 100%)" : buttonStyle.background,
                  }}
                >
                  All Companies
                </button>
                <button
                  onClick={() => void addCompany()}
                  style={{
                    ...buttonStyle,
                    background: "linear-gradient(180deg, rgba(76, 164, 255, 0.34) 0%, rgba(31, 82, 143, 0.18) 100%)",
                    color: "#e8f4ff",
                    border: "1px solid rgba(108, 185, 255, 0.24)",
                    whiteSpace: "nowrap",
                  }}
                >
                  New Company
                </button>
              </div>
            </div>
            <div style={{ maxHeight: isMobile ? "unset" : "calc(72vh - 74px)", overflowY: "auto", background: "linear-gradient(180deg, rgba(15, 58, 102, 0.68) 0%, rgba(9, 36, 67, 0.78) 100%)" }}>
              {filteredCompanies.map((company) => (
                <button
                  key={company.id}
                  ref={(node) => {
                    companyRefs.current[company.id] = node
                  }}
                  type="button"
                  onClick={() => setSelectedCompany(company.name)}
                  onDoubleClick={() => openCompanyModal(company)}
                  onKeyDown={(event) => onCompanyKeyDown(event, company.id)}
                  style={{
                    ...listRowStyle,
                    background:
                      selectedCompany === company.name
                        ? "linear-gradient(180deg, rgba(76, 164, 255, 0.2) 0%, rgba(31, 82, 143, 0.12) 100%)"
                        : "transparent",
                  }}
                >
                  <span style={{ whiteSpace: "normal", lineHeight: 1.2, textAlign: "left", display: "block" }}>
                    <div style={{ textTransform: "uppercase", fontWeight: 800, fontSize: "14px" }}>{company.name || "No Company"}</div>
                    {company.other_name ? (
                      <div style={{ color: "#8fd7ff", fontSize: "12px", fontWeight: 500, marginTop: "4px" }}>
                        {company.other_name}
                      </div>
                    ) : null}
                    {formatCompanyPhoneLine(company) ? (
                      <div style={{ color: "#bcdcff", fontSize: "11px", marginTop: "4px" }}>
                        {formatCompanyPhoneLine(company)}
                      </div>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section style={{ ...sidebarPanelStyle }}>
            <div style={{ padding: "10px 12px", borderBottom: "1px solid rgba(210,236,255,0.08)" }}>
              {selectedCompany ? (
                <button
                  onClick={() => void addContact()}
                  style={{
                    ...buttonStyle,
                    width: "100%",
                    background: "linear-gradient(180deg, rgba(76, 164, 255, 0.34) 0%, rgba(31, 82, 143, 0.18) 100%)",
                    color: "#e8f4ff",
                    border: "1px solid rgba(108, 185, 255, 0.24)",
                  }}
                >
                  Add Contact
                </button>
              ) : null}
            </div>
            <div style={{ maxHeight: isMobile ? "unset" : "calc(72vh - 58px)", overflowY: "auto", background: "linear-gradient(180deg, rgba(15, 58, 102, 0.68) 0%, rgba(9, 36, 67, 0.78) 100%)" }}>
              {filteredContacts.map((contact) => (
                <button
                  key={contact.id}
                  ref={(node) => {
                    contactRefs.current[contact.id] = node
                  }}
                  onClick={() => setSelectedId(contact.id)}
                  onKeyDown={(event) => onContactKeyDown(event, contact.id)}
                  onMouseEnter={() => setPinHoverId(contact.id)}
                  onMouseLeave={() => setPinHoverId((prev) => (prev === contact.id ? null : prev))}
                  style={{
                    ...listRowStyle,
                    background: selectedId === contact.id ? "linear-gradient(180deg, rgba(76, 164, 255, 0.2) 0%, rgba(31, 82, 143, 0.12) 100%)" : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: "3px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                      {contact.favorite ? <span style={{ color: "#ffd166", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 800 }}>Top</span> : null}
                      <div style={{ fontWeight: 800, fontSize: "14px", minWidth: 0, textTransform: "uppercase" }}>{contact.full_name || "(No Name)"}</div>
                      {contact.tel_ext ? (
                        <span style={{ color: "#ffd166", fontSize: "11px", fontWeight: 700, whiteSpace: "nowrap" }}>
                          EXT {contact.tel_ext}
                        </span>
                      ) : null}
                    </div>
                    <div style={{ width: "44px", display: "flex", justifyContent: "flex-end", flex: "0 0 44px" }}>
                      {selectedCompany && pinHoverId === contact.id ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            void togglePinned(contact)
                          }}
                          style={{ ...buttonStyle, padding: "4px 8px", fontSize: "10px", minWidth: "40px" }}
                        >
                          Pin
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ color: "#8fd7ff", fontSize: "12px", textTransform: "uppercase" }}>{normalizeCompanyName(contact.company)}</div>
                </button>
              ))}
            </div>
          </section>

          <section style={{ ...panelStyle, padding: "16px", display: "grid", gap: "12px" }}>
            {displayed ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0,1fr) auto auto auto auto", gap: "10px", alignItems: "end" }}>
                  <div>
                    <div style={{ color: "#8fd7ff", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "6px" }}>Name</div>
                    {editing ? (
                      <input value={draft?.full_name || ""} onChange={(event) => updateCapsField("full_name", event.target.value)} style={detailInputStyle} />
                    ) : (
                      <div style={{ fontSize: "24px", fontWeight: 800, lineHeight: 1.15, textTransform: "uppercase" }}>{current?.full_name || "(No Name)"}</div>
                    )}
                  </div>
                  {!editing ? (
                    <button
                      ref={editButtonRef}
                      onClick={() => {
                        setDraft(current ? { ...current } : null)
                        setEditing(true)
                      }}
                      disabled={!current}
                      style={{
                        ...buttonStyle,
                        background: "linear-gradient(180deg, rgba(255, 210, 86, 0.36) 0%, rgba(191, 136, 16, 0.18) 100%)",
                        color: "#fff2bc",
                        border: "1px solid rgba(255, 211, 110, 0.34)",
                      }}
                    >
                      Edit
                    </button>
                  ) : null}
                  {editing ? (
                    <>
                      <button onClick={() => void saveCurrent()} disabled={saving} style={{ ...buttonStyle, background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)", color: "#ddffef", border: "1px solid rgba(73, 219, 165, 0.26)" }}>
                        {saving ? "Saving..." : "Save"}
                      </button>
                      <button onClick={() => setEditing(false)} style={buttonStyle}>Cancel</button>
                      <button onClick={() => void deleteCurrent()} style={{ ...buttonStyle, background: "linear-gradient(180deg, rgba(230, 57, 70, 0.24) 0%, rgba(170, 47, 53, 0.12) 100%)", color: "#ffd6db", border: "1px solid rgba(255, 120, 120, 0.22)" }}>
                        Delete
                      </button>
                    </>
                  ) : null}
                </div>

                <div>
                  <div style={{ color: "#8fd7ff", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "6px" }}>Company</div>
                  {editing ? (
                    <input value={draft?.company || ""} onChange={(event) => updateCapsField("company", event.target.value)} style={detailInputStyle} />
                  ) : current?.company ? (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "2px 0" }}>
                      <span style={{ fontSize: "15px", lineHeight: 1.5, textTransform: "uppercase" }}>{current.company}</span>
                      <button onClick={() => copyToClipboard(current.company || "", setMessage)} style={iconButtonStyle} title="Copy">
                        ⧉
                      </button>
                    </div>
                  ) : null}
                </div>

                <div style={{ display: "grid", gap: "12px" }}>
                  <div style={modalSectionStyle}>
                    <div style={{ ...sectionLabelStyle, marginBottom: "10px" }}>Contact Data</div>
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "10px" }}>
                      {[
                        ["Title", "title"],
                        ["Ext", "tel_ext"],
                        ["Direct line", "direct_line"],
                        ["Mobile 1", "mobile_1"],
                        ["Mobile 2", "mobile_2"],
                        ["Personal Email", "personal_email"],
                        ["General Email", "general_email"],
                        ["Private Email", "private_email"],
                        ["Others", "others"],
                      ].map(([label, field]) => {
                        const key = field as keyof Contact
                        const value = displayed[key] as string | null
                        if (!editing && !value) return null
                        return (
                          <div key={field}>
                            <div style={sectionLabelStyle}>{label}</div>
                            {editing ? key === "title" ? (
                              <select
                                value={(draft?.[key] as string) || ""}
                                onChange={(event) => updateField(key, event.target.value as never)}
                                style={selectStyle}
                              >
                                <option value="">Select title</option>
                                {TITLE_OPTIONS.map((option) => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </select>
                            ) : (
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
                                <button onClick={() => copyToClipboard(value || "", setMessage)} style={iconButtonStyle} title="Copy">
                                  ⧉
                                </button>
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
              <div style={{ color: "#9dc0da", fontSize: "14px", lineHeight: 1.6 }}>Select a contact to view details.</div>
            )}
          </section>
        </div>

        {message && (
          <div style={{ color: message.startsWith("Unable") ? "#ffb0b0" : "#8ff0c8", fontWeight: 700 }}>
            {message}
          </div>
        )}
      </div>

      {companyModalOpen && companyDraft ? (
        <div style={modalOverlayStyle} onClick={closeCompanyModal}>
          <div style={modalCardStyle} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "16px" }}>
              <div>
                <div style={{ color: "#8fd7ff", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "6px" }}>Company</div>
                <div style={{ fontSize: "24px", fontWeight: 800, lineHeight: 1.15 }}>{companyDraft.name || "(No Name)"}</div>
              </div>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                <button
                  onClick={() => void saveCompany()}
                  disabled={companySaving}
                  style={{
                    ...buttonStyle,
                    background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)",
                    color: "#ddffef",
                    border: "1px solid rgba(73, 219, 165, 0.26)",
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
                      background: "linear-gradient(180deg, rgba(230, 57, 70, 0.24) 0%, rgba(170, 47, 53, 0.12) 100%)",
                      color: "#ffd6db",
                      border: "1px solid rgba(255, 120, 120, 0.22)",
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
                <div style={{ ...sectionLabelStyle, marginBottom: "10px" }}>General Data</div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "12px" }}>
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
                      style={{ ...detailInputStyle, minHeight: "90px", resize: "vertical", fontFamily: "Arial, Helvetica, sans-serif", lineHeight: 1.5 }}
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
                    <div style={sectionLabelStyle}>Tel 1</div>
                    <input
                      value={companyDraft.tel_no_1 || ""}
                      onChange={(event) => setCompanyDraft({ ...companyDraft, tel_no_1: toCaps(event.target.value), phone: toCaps(event.target.value) })}
                      style={detailInputStyle}
                    />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Tel 2</div>
                    <input value={companyDraft.tel_no_2 || ""} onChange={(event) => updateCompanyDraftField("tel_no_2", event.target.value)} style={detailInputStyle} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
