import fs from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"

const PROJECT_ROOT = process.cwd()
const DEFAULT_BASE_URL = "http://192.168.1.100:81/cistem"
const DEFAULT_USERNAME = "admin"
const DEFAULT_PASSWORD = "admin"
const LIST_PAGE_SIZE = 20

function loadEnv() {
  return Object.fromEntries(
    fs
      .readFileSync(path.join(PROJECT_ROOT, ".env.local"), "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((line) => !line.trim().startsWith("#"))
      .map((line) => {
        const idx = line.indexOf("=")
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "")]
      }),
  )
}

function parseCsvLine(line) {
  const values = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    const next = line[i + 1]
    if (char === '"' && inQuotes && next === '"') {
      current += '"'
      i += 1
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (char === "," && !inQuotes) {
      values.push(current)
      current = ""
      continue
    }
    current += char
  }

  values.push(current)
  return values
}

function normalizePhone(value) {
  return (value || "").trim()
}

function normalizeDialablePhone(value) {
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

function normalizeText(value) {
  return (value || "").trim()
}

function buildSourceKey(row) {
  return [
    row.full_name || "",
    row.company || "",
    row.mobile_phone || "",
    row.email_1 || "",
    row.email_2 || "",
  ]
    .join("|")
    .toLowerCase()
}

function buildSearchText(row) {
  return [
    row.full_name,
    row.company,
    row.mobile_phone,
    row.pager,
    row.business_phone,
    row.business_phone_2,
    row.other_phone,
    row.email_1,
    row.email_2,
    row.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function companySourceKey(name) {
  return (name || "").trim().toLowerCase()
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie()
  }
  const value = headers.get("set-cookie")
  return value ? [value] : []
}

async function loginAndAuthenticate(baseUrl, username, password) {
  const loginUrl = `${baseUrl.replace(/\/$/, "")}/login.php`
  const root = baseUrl.replace(/\/$/, "")

  const loginBody = new URLSearchParams({
    username,
    password,
    type: "",
  })

  const loginResponse = await fetch(loginUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: loginBody.toString(),
    redirect: "manual",
  })

  if (!loginResponse.ok && loginResponse.status !== 302) {
    throw new Error(`Cistem login failed with status ${loginResponse.status}.`)
  }

  const cookies = getSetCookies(loginResponse.headers)
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ")

  if (!cookies) {
    throw new Error("Cistem login did not return a session cookie.")
  }

  return {
    cookies,
    root,
  }
}

function decodeHtml(value) {
  return (value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r/g, "")
}

function stripTags(value) {
  return decodeHtml((value || "").replace(/<[^>]+>/g, ""))
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function matchInputValue(html, name) {
  const regex = new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`, "i")
  const match = html.match(regex)
  return decodeHtml(match?.[1] || "").trim()
}

function matchTextareaValue(html, name) {
  const regex = new RegExp(`<textarea[^>]*name="${name}"[^>]*>([\\s\\S]*?)<\\/textarea>`, "i")
  const match = html.match(regex)
  return stripTags(match?.[1] || "")
}

function matchSelectedOptionValue(html, selectName) {
  const selectRegex = new RegExp(`<select[^>]*name="${selectName}"[\\s\\S]*?<\\/select>`, "i")
  const selectMatch = html.match(selectRegex)
  if (!selectMatch) return ""
  const optionMatch = selectMatch[0].match(/<option value="([^"]*)"[^>]*selected="selected"/i)
  return decodeHtml(optionMatch?.[1] || "").trim()
}

function matchCheckedRadioValue(html, name) {
  const regex = new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"[^>]*checked(?:="checked")?`, "i")
  const match = html.match(regex)
  return decodeHtml(match?.[1] || "").trim()
}

function buildCompanyPhone(parts) {
  return parts.filter(Boolean).join(" ").trim() || null
}

function compactLines(lines) {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim() || null
}

function parseTotalRecords(html) {
  const match = html.match(/Records&nbsp;\d+&nbsp;to&nbsp;\d+&nbsp;of&nbsp;(\d+)/i)
  return Number(match?.[1] || "0")
}

function extractCompanyIds(html) {
  return Array.from(
    new Set(
      [...html.matchAll(/OpenUpdateCompany\((\d+)\)/g)]
        .map((match) => Number(match[1]))
        .filter((id) => id > 0),
    ),
  )
}

function stripTitleAndRemark(text) {
  const cleaned = normalizeText(text)
  const match = cleaned.match(/^(MR|MS|CP)\s+(.*?)(?:\s+\(([^)]+)\))?$/i)
  if (!match) {
    return {
      title: null,
      fullName: cleaned,
      nameRemark: null,
    }
  }
  return {
    title: match[1].toUpperCase(),
    fullName: normalizeText(match[2]),
    nameRemark: normalizeText(match[3] || "") || null,
  }
}

function parseClipContact(line) {
  const text = normalizeText(line)
  const emails = Array.from(
    new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []),
  )
  return {
    personalEmail: emails[0] || null,
    generalEmail: emails[1] || null,
    privateEmail: emails[2] || null,
  }
}

function extractContactsTable(html) {
  const contactsCellMatch = html.match(/<td style="width: 600px; white-space: nowrap;"><span id="el\d+_v_contacts_contacts"[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i)
  const tableHtml = contactsCellMatch?.[1] || ""
  const rows = [...tableHtml.matchAll(/<tr><td[^>]*>([\s\S]*?)<\/td><td[^>]*>([\s\S]*?)<\/td><td[^>]*>([\s\S]*?)<\/td><td[^>]*>([\s\S]*?)<\/td><td[^>]*>([\s\S]*?)<\/td><\/tr>/g)]
  return rows.map((match) => ({
    name: stripTags(match[1]),
    ext: stripTags(match[2]),
    direct: stripTags(match[3]),
    mobile1: stripTags(match[4]),
    mobile2: stripTags(match[5]),
  }))
}

function extractCompanyRowBlocks(html) {
  const marker = '<tr data-rowindex="'
  const startIndex = html.indexOf(marker)
  if (startIndex < 0) return []
  const tbodyStart = html.slice(startIndex)
  const parts = tbodyStart.split(marker).slice(1)
  return parts.map((part) => `${marker}${part}`)
}

function buildContactSourceKey(row) {
  return [
    row.company_source_id || "",
    row.full_name || "",
    row.personal_email || row.general_email || row.private_email || "",
    row.direct_line || "",
    row.mobile_1 || "",
  ]
    .join("|")
    .toLowerCase()
}

function parseContactsFromCompanyRow(rowHtml) {
  const companyIdMatch = rowHtml.match(/OpenUpdateCompany\((\d+)\)/)
  const companyId = companyIdMatch?.[1] || ""
  const companyName = stripTags((rowHtml.match(/OpenUpdateCompany\(\d+\)">([\s\S]*?)<\/a>/) || [])[1] || "")
  const clipValue = decodeHtml((rowHtml.match(/<input id='CLIP_\d+' type='hidden' value='([^']*)'/) || [])[1] || "")
  const clipParts = clipValue.split("!x!").map((part) => normalizeText(part)).filter(Boolean)
  const clipContacts = clipParts.filter((part) => /^(MR|MS|CP)\b/i.test(part))
  const visibleContacts = extractContactsTable(rowHtml)

  return visibleContacts.map((contact, index) => {
    const parsedName = stripTitleAndRemark(contact.name)
    const clipContact = parseClipContact(clipContacts[index] || "")
    const row = {
      contact_source_id: contact.contactId || null,
      full_name: parsedName.fullName || contact.name,
      company: companyName || null,
      company_source_id: companyId || null,
      title: parsedName.title,
      name_remark: parsedName.nameRemark,
      position: null,
      department: null,
      tel_ext: normalizeText(contact.ext) || null,
      direct_line: normalizeDialablePhone(contact.direct),
      mobile_area: null,
      mobile_1: normalizeDialablePhone(contact.mobile1),
      mobile_2: normalizeDialablePhone(contact.mobile2),
      personal_email: clipContact.personalEmail,
      general_email: clipContact.generalEmail,
      private_email: clipContact.privateEmail,
      instant_messaging: null,
      others: null,
      area_of_responsibility: null,
      mobile_phone: normalizeDialablePhone(contact.mobile1),
      pager: normalizeDialablePhone(contact.mobile2),
      business_phone: normalizeDialablePhone(contact.direct),
      business_phone_2: normalizeText(contact.ext) || null,
      other_phone: null,
      email_1: clipContact.personalEmail,
      email_2: clipContact.generalEmail || clipContact.privateEmail,
      notes: null,
      favorite: false,
    }
    return {
      ...row,
      source_key: buildContactSourceKey(row),
      search_text: buildSearchText(row),
    }
  })
}

function parseContactDetails(html) {
  return {
    personal_email: matchInputValue(html, "x_compcontact_email") || null,
    general_email: matchInputValue(html, "x_compcontact_email_group") || null,
    private_email: matchInputValue(html, "x_compcontact_email_pvt") || null,
  }
}

async function collectContactDetails(root, cookies, contacts) {
  const results = new Map()
  const targets = contacts.filter((contact) => contact.contact_source_id)
  const concurrency = 10
  let index = 0

  async function worker() {
    while (index < targets.length) {
      const currentIndex = index
      index += 1
      const contact = targets[currentIndex]
      const html = await fetchText(`${root}/compcontactedit.php?id=${contact.contact_source_id}`, cookies)
      results.set(contact.contact_source_id, parseContactDetails(html))
      if ((currentIndex + 1) % 100 === 0 || currentIndex + 1 === targets.length) {
        console.log(`Fetched contact details ${currentIndex + 1}/${targets.length}`)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}

async function collectCompaniesAndContacts(root, cookies) {
  const firstPageHtml = await fetchText(`${root}/v_contactslist.php`, cookies)
  const totalRecords = parseTotalRecords(firstPageHtml)
  if (totalRecords <= 0) {
    throw new Error("Unable to determine total company records from Cistem contacts list.")
  }

  const companyIds = new Set(extractCompanyIds(firstPageHtml))
  const contacts = []
  for (const rowHtml of extractCompanyRowBlocks(firstPageHtml)) {
    contacts.push(...parseContactsFromCompanyRow(rowHtml))
  }

  for (let start = 1; start <= totalRecords; start += LIST_PAGE_SIZE) {
    const html = start === 1 ? firstPageHtml : await fetchText(`${root}/v_contactslist.php?start=${start}`, cookies)
    for (const id of extractCompanyIds(html)) {
      companyIds.add(id)
    }
    if (start !== 1) {
      for (const rowHtml of extractCompanyRowBlocks(html)) {
        contacts.push(...parseContactsFromCompanyRow(rowHtml))
      }
    }
    console.log(`Scanned company/contact rows through row ${Math.min(start + LIST_PAGE_SIZE - 1, totalRecords)}/${totalRecords}`)
  }

  const uniqueContacts = Array.from(new Map(contacts.map((row) => [row.source_key, row])).values())
  return {
    companyIds: Array.from(companyIds),
    contacts: uniqueContacts,
  }
}

async function fetchText(url, cookies) {
  const response = await fetch(url, {
    headers: {
      Cookie: cookies,
    },
  })
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`)
  }
  return response.text()
}

async function collectCompanyIds(root, cookies) {
  const firstPageHtml = await fetchText(`${root}/v_contactslist.php`, cookies)
  const totalRecords = parseTotalRecords(firstPageHtml)
  if (totalRecords <= 0) {
    throw new Error("Unable to determine total company records from Cistem contacts list.")
  }
  const ids = new Set(extractCompanyIds(firstPageHtml))

  for (let start = 1; start <= totalRecords; start += LIST_PAGE_SIZE) {
    const html = await fetchText(`${root}/v_contactslist.php?start=${start}`, cookies)
    for (const id of extractCompanyIds(html)) {
      ids.add(id)
    }
    console.log(`Scanned company ids through row ${Math.min(start + LIST_PAGE_SIZE - 1, totalRecords)}/${totalRecords}`)
  }

  return Array.from(ids)
}

function parseCompanyDetails(html) {
  const name = matchInputValue(html, "x_company_name")
  const otherName = matchInputValue(html, "x_company_other_name")
  const address = matchTextareaValue(html, "x_company_addr")
  const country = matchSelectedOptionValue(html, "x_company_addr_country")
  const telCountry = matchInputValue(html, "x_company_tel_country")
  const telArea = matchInputValue(html, "x_company_tel_area")
  const tel1 = matchInputValue(html, "x_company_tel_no_1")
  const tel2 = matchInputValue(html, "x_company_tel_no_2")
  const speedDial = matchSelectedOptionValue(html, "x_company_tel_speeddial")
  const fax = matchInputValue(html, "x_company_fax_no_1")
  const website = matchInputValue(html, "x_company_website")
  const email = matchInputValue(html, "x_company_email")
  const remarks = matchTextareaValue(html, "x_company_info")
  const contactType = matchCheckedRadioValue(html, "x_company_type")
  const stemManagement = matchCheckedRadioValue(html, "x_company_for_bunker_prog")
  const companyStatus = matchCheckedRadioValue(html, "x_company_status")
  const sellerTerm = matchInputValue(html, "x_seller_term")
  const sellerCreditLimit = matchInputValue(html, "x_seller_credit_limit")
  const sellerCreditLimitFlexibility = matchInputValue(html, "x_seller_credit_limit_flexibility")
  const sellerClassification = matchInputValue(html, "x_seller_classification")
  const sellerRemark1 = matchTextareaValue(html, "x_seller_remark_1")
  const sellerRemark2 = matchTextareaValue(html, "x_seller_remark_2")
  const sellerRemark3 = matchTextareaValue(html, "x_seller_remark_3")
  const sellerRemark4 = matchTextareaValue(html, "x_seller_remark_4")
  const buyerTerm = matchInputValue(html, "x_buyer_term")
  const buyerCreditLimit = matchInputValue(html, "x_buyer_credit_limit")
  const buyerCreditLimitFlexibility = matchInputValue(html, "x_buyer_credit_limit_flexibility")
  const buyerClassification = matchInputValue(html, "x_buyer_classification")
  const buyerRemark1 = matchTextareaValue(html, "x_buyer_remark_1")
  const buyerRemark2 = matchTextareaValue(html, "x_buyer_remark_2")
  const buyerRemark3 = matchTextareaValue(html, "x_buyer_remark_3")
  const buyerRemark4 = matchTextareaValue(html, "x_buyer_remark_4")

  const phone = buildCompanyPhone([telCountry, telArea, tel1].filter(Boolean))
  const addressBlock = compactLines([address].filter(Boolean))
  const notes = compactLines([])

  return {
    name,
    phone,
    address: addressBlock,
    other_name: otherName || null,
    country: country || null,
    tel_country: telCountry || null,
    tel_area: telArea || null,
    tel_no_1: tel1 || null,
    tel_no_2: tel2 || null,
    tel_speed_dial: speedDial || null,
    fax_no_1: fax || null,
    website: website || null,
    email: email || null,
    contact_type: contactType || null,
    stem_management: stemManagement || null,
    company_status: companyStatus || null,
    company_info: remarks || null,
    seller_term: sellerTerm || null,
    seller_credit_limit: sellerCreditLimit || null,
    seller_credit_limit_flexibility: sellerCreditLimitFlexibility || null,
    seller_classification: sellerClassification || null,
    seller_remark_1: sellerRemark1 || null,
    seller_remark_2: sellerRemark2 || null,
    seller_remark_3: sellerRemark3 || null,
    seller_remark_4: sellerRemark4 || null,
    buyer_term: buyerTerm || null,
    buyer_credit_limit: buyerCreditLimit || null,
    buyer_credit_limit_flexibility: buyerCreditLimitFlexibility || null,
    buyer_classification: buyerClassification || null,
    buyer_remark_1: buyerRemark1 || null,
    buyer_remark_2: buyerRemark2 || null,
    buyer_remark_3: buyerRemark3 || null,
    buyer_remark_4: buyerRemark4 || null,
    notes,
    source_key: companySourceKey(name),
  }
}

async function collectCompanyDetails(root, cookies, companyIds) {
  const results = []
  const concurrency = 8
  let index = 0

  async function worker() {
    while (index < companyIds.length) {
      const currentIndex = index
      index += 1
      const companyId = companyIds[currentIndex]
      const html = await fetchText(`${root}/companyedit.php?company_id=${companyId}`, cookies)
      const company = parseCompanyDetails(html)
      if (company.name) {
        results.push(company)
      }
      if ((currentIndex + 1) % 50 === 0 || currentIndex + 1 === companyIds.length) {
        console.log(`Fetched company details ${currentIndex + 1}/${companyIds.length}`)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return Array.from(new Map(results.map((company) => [company.source_key, company])).values())
}

async function main() {
  const env = loadEnv()
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

  const baseUrl = env.CISTEM_BASE_URL || DEFAULT_BASE_URL
  const username = env.CISTEM_USERNAME || DEFAULT_USERNAME
  const password = env.CISTEM_PASSWORD || DEFAULT_PASSWORD

  const { cookies, root } = await loginAndAuthenticate(baseUrl, username, password)
  const { companyIds, contacts: uniqueRows } = await collectCompaniesAndContacts(root, cookies)
  const contactDetails = await collectContactDetails(root, cookies, uniqueRows)
  const detailedCompanies = await collectCompanyDetails(root, cookies, companyIds)

  const enrichedRows = uniqueRows.map((row) => {
    const detail = row.contact_source_id ? contactDetails.get(row.contact_source_id) : null
    const next = {
      ...row,
      personal_email: detail?.personal_email || row.personal_email,
      general_email: detail?.general_email || row.general_email,
      private_email: detail?.private_email || row.private_email,
    }
    const { contact_source_id, ...persisted } = next
    return {
      ...persisted,
      email_1: persisted.personal_email,
      email_2: persisted.general_email || persisted.private_email,
      source_key: buildContactSourceKey(persisted),
      search_text: buildSearchText(persisted),
    }
  })

  const companyMap = new Map(detailedCompanies.map((company) => [company.source_key, company]))
  for (const row of enrichedRows) {
    const name = normalizeText(row.company)
    if (!name) continue
    const key = companySourceKey(name)
    const existing = companyMap.get(key) || {
      name,
      phone: null,
      address: null,
      other_name: null,
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
      source_key: key,
    }
    existing.phone ||= row.business_phone || row.business_phone_2 || row.mobile_phone || null
    existing.email ||= row.email_2 || row.email_1 || null
    companyMap.set(key, existing)
  }

  const companies = Array.from(companyMap.values()).sort((a, b) => a.name.localeCompare(b.name))

  const { error: deleteContactsError } = await supabase.from("phonebook_contacts").delete().not("id", "is", null)
  if (deleteContactsError) throw deleteContactsError
  const { error: deleteCompaniesError } = await supabase.from("phonebook_companies").delete().not("id", "is", null)
  if (deleteCompaniesError) throw deleteCompaniesError

  for (let i = 0; i < companies.length; i += 200) {
    const chunk = companies.slice(i, i + 200)
    const { error } = await supabase.from("phonebook_companies").upsert(chunk, { onConflict: "source_key" })
    if (error) throw error
  }

  for (let i = 0; i < enrichedRows.length; i += 200) {
    const chunk = enrichedRows.slice(i, i + 200)
    const { error } = await supabase.from("phonebook_contacts").upsert(chunk, { onConflict: "source_key" })
    if (error) throw error
    console.log(`Imported ${Math.min(i + chunk.length, enrichedRows.length)}/${enrichedRows.length}`)
  }

  console.log(`Imported ${enrichedRows.length} Cistem contacts across ${companies.length} companies.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
