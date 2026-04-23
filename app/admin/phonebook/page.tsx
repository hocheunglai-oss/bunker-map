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

function normalizeCompanyName(value: string | null | undefined) {
  return value?.trim() || "No Company"
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

function vcardEscape(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
}

function buildVcard(contact: Contact) {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${vcardEscape(contact.full_name || "")}`,
  ]

  if (contact.company) lines.push(`ORG:${vcardEscape(contact.company)}`)
  if (contact.mobile_1) lines.push(`TEL;TYPE=CELL:${vcardEscape(contact.mobile_1)}`)
  if (contact.mobile_2) lines.push(`TEL;TYPE=CELL,VOICE:${vcardEscape(contact.mobile_2)}`)
  if (contact.direct_line) lines.push(`TEL;TYPE=WORK:${vcardEscape(contact.direct_line)}`)
  if (contact.general_email) lines.push(`EMAIL;TYPE=INTERNET:${vcardEscape(contact.general_email)}`)
  if (contact.personal_email) lines.push(`EMAIL;TYPE=INTERNET:${vcardEscape(contact.personal_email)}`)
  if (contact.private_email) lines.push(`EMAIL;TYPE=INTERNET:${vcardEscape(contact.private_email)}`)
  if (contact.notes) lines.push(`NOTE:${vcardEscape(contact.notes)}`)
  lines.push("END:VCARD")
  return lines.join("\n")
}

function downloadTextFile(filename: string, contents: string, type = "text/vcard;charset=utf-8") {
  const blob = new Blob([contents], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function copyToClipboard(value: string, onDone: (message: string) => void) {
  navigator.clipboard
    .writeText(value)
    .then(() => onDone("Copied."))
    .catch(() => onDone("Unable to copy."))
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
      setCompanies(companyData)
      setContacts(contactData)
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

  const companiesWithMatchingContacts = useMemo(() => {
    if (queryTokens.length === 0) return new Set<string>()

    return new Set(
      contacts
        .filter((contact) => {
          const haystack = contact.search_text || ""
          return queryTokens.every((token) => haystack.includes(token))
        })
        .map((contact) => normalizeCompanyName(contact.company))
    )
  }, [contacts, queryTokens])

  const filteredCompanies = useMemo(() => {
    if (queryTokens.length === 0) return companies
    return companies.filter((company) => {
      const haystack = company.name.toLowerCase()
      const matchesCompanyName = queryTokens.every((token) => haystack.includes(token))
      return matchesCompanyName || companiesWithMatchingContacts.has(company.name)
    })
  }, [companies, companiesWithMatchingContacts, queryTokens])

  const filteredContacts = useMemo(() => {
    let next = contacts.filter((contact) => {
      const matchesCompany = !selectedCompany || normalizeCompanyName(contact.company) === selectedCompany
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
  }, [contacts, queryTokens, selectedCompany])

  async function saveCurrent() {
    if (!draft) return
    setSaving(true)
    setMessage("")
    const payload = {
      full_name: draft.full_name.trim(),
      company: draft.company?.trim() || null,
      company_source_id: draft.company_source_id?.trim() || null,
      title: draft.title?.trim() || null,
      name_remark: draft.name_remark?.trim() || null,
      position: draft.position?.trim() || null,
      department: draft.department?.trim() || null,
      tel_ext: draft.tel_ext?.trim() || null,
      direct_line: draft.direct_line?.trim() || null,
      mobile_area: draft.mobile_area?.trim() || null,
      mobile_1: draft.mobile_1?.trim() || null,
      mobile_2: draft.mobile_2?.trim() || null,
      personal_email: draft.personal_email?.trim() || null,
      general_email: draft.general_email?.trim() || null,
      private_email: draft.private_email?.trim() || null,
      instant_messaging: draft.instant_messaging?.trim() || null,
      others: draft.others?.trim() || null,
      area_of_responsibility: draft.area_of_responsibility?.trim() || null,
      mobile_phone: draft.mobile_1?.trim() || null,
      pager: draft.mobile_2?.trim() || null,
      business_phone: draft.direct_line?.trim() || null,
      business_phone_2: draft.tel_ext?.trim() || null,
      other_phone: draft.others?.trim() || null,
      email_1: draft.personal_email?.trim() || null,
      email_2: draft.general_email?.trim() || null,
      notes: draft.notes?.trim() || null,
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
    setMessage("Saved.")
    setSaving(false)
  }

  async function deleteCurrent() {
    if (!current) return
    if (!confirm(`Delete ${current.full_name}?`)) return
    const { error } = await supabase.from("phonebook_contacts").delete().eq("id", current.id)
    if (error) {
      setMessage("Unable to delete contact.")
      return
    }
    setContacts((prev) => prev.filter((item) => item.id !== current.id))
    setSelectedId("")
    setMessage("Deleted.")
  }

  async function addCompany() {
    const payload = {
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
    }
    const { data, error } = await supabase.from("phonebook_companies").insert(payload).select("*").single()
    if (error || !data) {
      setMessage("Unable to add company.")
      return
    }
    setCompanies((prev) => [...prev, data as Company].sort((a, b) => a.name.localeCompare(b.name)))
    setSelectedCompany((data as Company).name || "")
    setMessage("New company added.")
  }

  function openCompanyModal(company: Company) {
    setCompanyDraft({ ...company })
    setCompanyModalOpen(true)
    setMessage("")
  }

  function closeCompanyModal() {
    setCompanyModalOpen(false)
    setCompanyDraft(null)
    setCompanySaving(false)
  }

  async function saveCompany() {
    if (!companyDraft) return
    setCompanySaving(true)
    setMessage("")
    const payload = {
      name: companyDraft.name.trim(),
      other_name: companyDraft.other_name?.trim() || null,
      phone: companyDraft.phone?.trim() || null,
      address: companyDraft.address?.trim() || null,
      country: companyDraft.country?.trim() || null,
      tel_country: companyDraft.tel_country?.trim() || null,
      tel_area: companyDraft.tel_area?.trim() || null,
      tel_no_1: companyDraft.tel_no_1?.trim() || null,
      tel_no_2: companyDraft.tel_no_2?.trim() || null,
      tel_speed_dial: companyDraft.tel_speed_dial?.trim() || null,
      fax_no_1: companyDraft.fax_no_1?.trim() || null,
      website: companyDraft.website?.trim() || null,
      email: companyDraft.email?.trim() || null,
      contact_type: companyDraft.contact_type?.trim() || null,
      stem_management: companyDraft.stem_management?.trim() || null,
      company_status: companyDraft.company_status?.trim() || null,
      company_info: companyDraft.company_info?.trim() || null,
      seller_term: companyDraft.seller_term?.trim() || null,
      seller_credit_limit: companyDraft.seller_credit_limit?.trim() || null,
      seller_credit_limit_flexibility: companyDraft.seller_credit_limit_flexibility?.trim() || null,
      seller_classification: companyDraft.seller_classification?.trim() || null,
      seller_remark_1: companyDraft.seller_remark_1?.trim() || null,
      seller_remark_2: companyDraft.seller_remark_2?.trim() || null,
      seller_remark_3: companyDraft.seller_remark_3?.trim() || null,
      seller_remark_4: companyDraft.seller_remark_4?.trim() || null,
      buyer_term: companyDraft.buyer_term?.trim() || null,
      buyer_credit_limit: companyDraft.buyer_credit_limit?.trim() || null,
      buyer_credit_limit_flexibility: companyDraft.buyer_credit_limit_flexibility?.trim() || null,
      buyer_classification: companyDraft.buyer_classification?.trim() || null,
      buyer_remark_1: companyDraft.buyer_remark_1?.trim() || null,
      buyer_remark_2: companyDraft.buyer_remark_2?.trim() || null,
      buyer_remark_3: companyDraft.buyer_remark_3?.trim() || null,
      buyer_remark_4: companyDraft.buyer_remark_4?.trim() || null,
      notes: companyDraft.notes?.trim() || null,
    }

    const { data, error } = await supabase
      .from("phonebook_companies")
      .update(payload)
      .eq("id", companyDraft.id)
      .select("*")
      .single()

    if (error || !data) {
      setMessage("Unable to save company.")
      setCompanySaving(false)
      return
    }

    setCompanies((prev) =>
      prev
        .map((item) => (item.id === companyDraft.id ? (data as Company) : item))
        .sort((a, b) => a.name.localeCompare(b.name)),
    )

    if (selectedCompany === companyDraft.name && payload.name !== companyDraft.name) {
      setSelectedCompany(payload.name)
    }

    setCompanyDraft(data as Company)
    setCompanySaving(false)
    setMessage("Company saved.")
    setCompanyModalOpen(false)
  }

  async function addContact() {
    const payload = {
      full_name: "",
      company: selectedCompany,
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

  function exportAllVcards() {
    const source = selectedCompany ? filteredContacts : contacts
    if (source.length === 0) return
    const contents = source.map((contact) => buildVcard(contact)).join("\n")
    downloadTextFile(`phonebook-${new Date().toISOString().slice(0, 10)}.vcf`, `${contents}\n`)
    setMessage("vCards exported.")
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
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
            <button
              onClick={() => void addCompany()}
              style={{
                ...buttonStyle,
                background: "linear-gradient(180deg, rgba(76, 164, 255, 0.34) 0%, rgba(31, 82, 143, 0.18) 100%)",
                color: "#e8f4ff",
                border: "1px solid rgba(108, 185, 255, 0.24)",
              }}
            >
              Add Company
            </button>
            <button
              onClick={exportAllVcards}
              style={{
                ...buttonStyle,
                background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)",
                color: "#ddffef",
                border: "1px solid rgba(73, 219, 165, 0.26)",
              }}
            >
              Export vCard
            </button>
            <a href="/admin" style={buttonStyle}>Back</a>
            <div style={{ color: "#8fd7ff", fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>
              Count: {filteredContacts.length}
            </div>
          </div>
        </div>

        <div style={{ ...panelStyle, padding: "12px 14px" }}>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
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
          <aside style={{ ...panelStyle, padding: "12px", display: "grid", gap: "8px", maxHeight: isMobile ? "unset" : "72vh", overflowY: "auto" }}>
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
                  ...buttonStyle,
                  width: "100%",
                  textAlign: "left",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "10px",
                  background: selectedCompany === company.name ? "linear-gradient(180deg, rgba(76, 164, 255, 0.34) 0%, rgba(31, 82, 143, 0.18) 100%)" : buttonStyle.background,
                }}
              >
                <span style={{ whiteSpace: "normal", lineHeight: 1.35, textAlign: "left", flex: "1 1 auto" }}>{company.name || "No Company"}</span>
              </button>
            ))}
          </aside>

          <section style={{ ...panelStyle, overflow: "hidden" }}>
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
            <div style={{ maxHeight: isMobile ? "unset" : "72vh", overflowY: "auto" }}>
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
                    width: "100%",
                    border: "none",
                    background: selectedId === contact.id ? "linear-gradient(180deg, rgba(76, 164, 255, 0.2) 0%, rgba(31, 82, 143, 0.12) 100%)" : "transparent",
                    borderBottom: "1px solid rgba(210,236,255,0.08)",
                    textAlign: "left",
                    padding: "11px 14px",
                    color: "#edf7ff",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: "3px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                      {contact.favorite ? <span style={{ color: "#ffd166", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 800 }}>Top</span> : null}
                      <div style={{ fontWeight: 800, fontSize: "14px", minWidth: 0 }}>{contact.full_name || "(No Name)"}</div>
                    </div>
                    {selectedCompany && pinHoverId === contact.id ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          void togglePinned(contact)
                        }}
                        style={{ ...buttonStyle, padding: "4px 8px", fontSize: "10px" }}
                      >
                        Pin
                      </button>
                    ) : null}
                  </div>
                  <div style={{ color: "#8fd7ff", fontSize: "12px" }}>{normalizeCompanyName(contact.company)}</div>
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
                      <input value={draft?.full_name || ""} onChange={(event) => updateField("full_name", event.target.value)} style={detailInputStyle} />
                    ) : (
                      <div style={{ fontSize: "24px", fontWeight: 800, lineHeight: 1.15 }}>{current?.full_name || "(No Name)"}</div>
                    )}
                  </div>
                  <button
                    ref={editButtonRef}
                    onClick={() => {
                      setDraft(current ? { ...current } : null)
                      setEditing(true)
                    }}
                    disabled={editing || !current}
                    style={{
                      ...buttonStyle,
                      background: "linear-gradient(180deg, rgba(255, 210, 86, 0.36) 0%, rgba(191, 136, 16, 0.18) 100%)",
                      color: "#fff2bc",
                      border: "1px solid rgba(255, 211, 110, 0.34)",
                    }}
                  >
                    Edit
                  </button>
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
                    <input value={draft?.company || ""} onChange={(event) => updateField("company", event.target.value)} style={detailInputStyle} />
                  ) : current?.company ? (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "2px 0" }}>
                      <span style={{ fontSize: "15px", lineHeight: 1.5 }}>{current.company}</span>
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
                        ["Name Remark", "name_remark"],
                        ["Position", "position"],
                        ["Department", "department"],
                        ["Ext", "tel_ext"],
                        ["Direct line", "direct_line"],
                        ["Mobile area", "mobile_area"],
                        ["Mobile 1", "mobile_1"],
                        ["Mobile 2", "mobile_2"],
                        ["Personal Email", "personal_email"],
                        ["General Email", "general_email"],
                        ["Private Email", "private_email"],
                        ["Others", "others"],
                        ["Area of Responsibility", "area_of_responsibility"],
                      ].map(([label, field]) => {
                        const key = field as keyof Contact
                        const value = displayed[key] as string | null
                        if (!editing && !value) return null
                        return (
                          <div key={field}>
                            <div style={sectionLabelStyle}>{label}</div>
                            {editing ? (
                              <input value={(draft?.[key] as string) || ""} onChange={(event) => updateField(key, event.target.value as never)} style={detailInputStyle} />
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

                  {(editing || displayed.instant_messaging) && (
                    <div style={modalSectionStyle}>
                      <div style={{ ...sectionLabelStyle, marginBottom: "10px" }}>Instant Messaging</div>
                      {editing ? (
                        <textarea
                          value={draft?.instant_messaging || ""}
                          onChange={(event) => updateField("instant_messaging", event.target.value)}
                          style={{ ...detailInputStyle, minHeight: "110px", resize: "vertical", fontFamily: "Arial, Helvetica, sans-serif", lineHeight: 1.55 }}
                        />
                      ) : (
                        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{displayed.instant_messaging}</div>
                      )}
                    </div>
                  )}

                  {(editing || displayed.notes) && (
                    <div style={modalSectionStyle}>
                      <div style={{ ...sectionLabelStyle, marginBottom: "10px" }}>Notes</div>
                      {editing ? (
                        <textarea
                          value={draft?.notes || ""}
                          onChange={(event) => updateField("notes", event.target.value)}
                          style={{ ...detailInputStyle, minHeight: "140px", resize: "vertical", fontFamily: "Arial, Helvetica, sans-serif", lineHeight: 1.5 }}
                        />
                      ) : (
                        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{displayed.notes}</div>
                      )}
                    </div>
                  )}
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
                    <div style={sectionLabelStyle}>Name</div>
                    <input value={companyDraft.name || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, name: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Other Name</div>
                    <input value={companyDraft.other_name || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, other_name: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div style={{ gridColumn: isMobile ? "auto" : "1 / -1" }}>
                    <div style={sectionLabelStyle}>Address</div>
                    <textarea
                      value={companyDraft.address || ""}
                      onChange={(event) => setCompanyDraft({ ...companyDraft, address: event.target.value })}
                      style={{ ...detailInputStyle, minHeight: "90px", resize: "vertical", fontFamily: "Arial, Helvetica, sans-serif", lineHeight: 1.5 }}
                    />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Country</div>
                    <input value={companyDraft.country || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, country: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Country Code</div>
                    <input value={companyDraft.tel_country || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, tel_country: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Area Code</div>
                    <input value={companyDraft.tel_area || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, tel_area: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Tel 1</div>
                    <input value={companyDraft.tel_no_1 || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, tel_no_1: event.target.value, phone: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Tel 2</div>
                    <input value={companyDraft.tel_no_2 || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, tel_no_2: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Tel Speed Dial</div>
                    <input value={companyDraft.tel_speed_dial || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, tel_speed_dial: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Fax</div>
                    <input value={companyDraft.fax_no_1 || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, fax_no_1: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Website</div>
                    <input value={companyDraft.website || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, website: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Domain</div>
                    <input value={companyDraft.email || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, email: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Contact Type</div>
                    <input value={companyDraft.contact_type || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, contact_type: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Stem Management</div>
                    <input value={companyDraft.stem_management || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, stem_management: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div>
                    <div style={sectionLabelStyle}>Status</div>
                    <input value={companyDraft.company_status || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, company_status: event.target.value })} style={detailInputStyle} />
                  </div>
                  <div style={{ gridColumn: isMobile ? "auto" : "1 / -1" }}>
                    <div style={sectionLabelStyle}>Remarks</div>
                    <textarea
                      value={companyDraft.company_info || ""}
                      onChange={(event) => setCompanyDraft({ ...companyDraft, company_info: event.target.value })}
                      style={{ ...detailInputStyle, minHeight: "110px", resize: "vertical", fontFamily: "Arial, Helvetica, sans-serif", lineHeight: 1.55 }}
                    />
                  </div>
                </div>
              </div>

              <div style={modalSectionStyle}>
                <div style={{ ...sectionLabelStyle, marginBottom: "10px" }}>Profile As Seller</div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "12px" }}>
                  <div><div style={sectionLabelStyle}>Term</div><input value={companyDraft.seller_term || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, seller_term: event.target.value })} style={detailInputStyle} /></div>
                  <div><div style={sectionLabelStyle}>Credit Limit</div><input value={companyDraft.seller_credit_limit || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, seller_credit_limit: event.target.value })} style={detailInputStyle} /></div>
                  <div><div style={sectionLabelStyle}>Credit Limit Flexibility</div><input value={companyDraft.seller_credit_limit_flexibility || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, seller_credit_limit_flexibility: event.target.value })} style={detailInputStyle} /></div>
                  <div><div style={sectionLabelStyle}>Classification</div><input value={companyDraft.seller_classification || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, seller_classification: event.target.value })} style={detailInputStyle} /></div>
                  {(["seller_remark_1","seller_remark_2","seller_remark_3","seller_remark_4"] as const).map((field, index) => (
                    <div key={field} style={{ gridColumn: isMobile ? "auto" : "1 / -1" }}>
                      <div style={sectionLabelStyle}>{`Remarks ${index + 1}`}</div>
                      <textarea
                        value={companyDraft[field] || ""}
                        onChange={(event) => setCompanyDraft({ ...companyDraft, [field]: event.target.value })}
                        style={{ ...detailInputStyle, minHeight: "96px", resize: "vertical", fontFamily: "Arial, Helvetica, sans-serif", lineHeight: 1.55 }}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div style={modalSectionStyle}>
                <div style={{ ...sectionLabelStyle, marginBottom: "10px" }}>Profile As Buyer</div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "12px" }}>
                  <div><div style={sectionLabelStyle}>Term</div><input value={companyDraft.buyer_term || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, buyer_term: event.target.value })} style={detailInputStyle} /></div>
                  <div><div style={sectionLabelStyle}>Credit Limit</div><input value={companyDraft.buyer_credit_limit || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, buyer_credit_limit: event.target.value })} style={detailInputStyle} /></div>
                  <div><div style={sectionLabelStyle}>Credit Limit Flexibility</div><input value={companyDraft.buyer_credit_limit_flexibility || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, buyer_credit_limit_flexibility: event.target.value })} style={detailInputStyle} /></div>
                  <div><div style={sectionLabelStyle}>PDD Classification</div><input value={companyDraft.buyer_classification || ""} onChange={(event) => setCompanyDraft({ ...companyDraft, buyer_classification: event.target.value })} style={detailInputStyle} /></div>
                  {(["buyer_remark_1","buyer_remark_2","buyer_remark_3","buyer_remark_4"] as const).map((field, index) => (
                    <div key={field} style={{ gridColumn: isMobile ? "auto" : "1 / -1" }}>
                      <div style={sectionLabelStyle}>{`Remarks ${index + 1}`}</div>
                      <textarea
                        value={companyDraft[field] || ""}
                        onChange={(event) => setCompanyDraft({ ...companyDraft, [field]: event.target.value })}
                        style={{ ...detailInputStyle, minHeight: "96px", resize: "vertical", fontFamily: "Arial, Helvetica, sans-serif", lineHeight: 1.55 }}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div style={modalSectionStyle}>
                <div style={{ ...sectionLabelStyle, marginBottom: "10px" }}>Notes</div>
                <textarea
                  value={companyDraft.notes || ""}
                  onChange={(event) => setCompanyDraft({ ...companyDraft, notes: event.target.value })}
                  style={{ ...detailInputStyle, minHeight: "120px", resize: "vertical", fontFamily: "Arial, Helvetica, sans-serif", lineHeight: 1.55 }}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
