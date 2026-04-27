import fs from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"

function readEnv(file) {
  const out = {}
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue
    const i = line.indexOf("=")
    if (i === -1) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")
  }
  return out
}

function toCaps(value) {
  return typeof value === "string" ? value.toUpperCase() : value
}

function buildSearchText(contact) {
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

const env = readEnv(path.join(process.cwd(), ".env.local"))
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

async function loadAll(table, orderField) {
  const rows = []
  const pageSize = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase.from(table).select("*").order(orderField, { ascending: true }).range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return rows
}

async function run() {
  const contacts = await loadAll("phonebook_contacts", "full_name")
  const companies = await loadAll("phonebook_companies", "name")

  let contactUpdates = 0
  for (const contact of contacts) {
    const payload = {
      full_name: toCaps(contact.full_name),
      company: toCaps(contact.company),
      title: toCaps(contact.title),
      name_remark: toCaps(contact.name_remark),
      position: toCaps(contact.position),
      department: toCaps(contact.department),
      tel_ext: toCaps(contact.tel_ext),
      direct_line: toCaps(contact.direct_line),
      mobile_area: toCaps(contact.mobile_area),
      mobile_1: toCaps(contact.mobile_1),
      mobile_2: toCaps(contact.mobile_2),
      instant_messaging: toCaps(contact.instant_messaging),
      others: toCaps(contact.others),
      area_of_responsibility: toCaps(contact.area_of_responsibility),
      mobile_phone: toCaps(contact.mobile_phone),
      pager: toCaps(contact.pager),
      business_phone: toCaps(contact.business_phone),
      business_phone_2: toCaps(contact.business_phone_2),
      other_phone: toCaps(contact.other_phone),
      notes: toCaps(contact.notes),
    }
    payload.search_text = buildSearchText({ ...contact, ...payload })
    const { error } = await supabase.from("phonebook_contacts").update(payload).eq("id", contact.id)
    if (error) throw error
    contactUpdates += 1
    if (contactUpdates % 500 === 0 || contactUpdates === contacts.length) {
      console.log(`Updated contacts ${contactUpdates}/${contacts.length}`)
    }
  }

  let companyUpdates = 0
  for (const company of companies) {
    const payload = {
      name: toCaps(company.name),
      other_name: toCaps(company.other_name),
      phone: toCaps(company.phone),
      address: toCaps(company.address),
      country: toCaps(company.country),
      tel_country: toCaps(company.tel_country),
      tel_area: toCaps(company.tel_area),
      tel_no_1: toCaps(company.tel_no_1),
      tel_no_2: toCaps(company.tel_no_2),
      tel_speed_dial: toCaps(company.tel_speed_dial),
      fax_no_1: toCaps(company.fax_no_1),
      website: toCaps(company.website),
      contact_type: toCaps(company.contact_type),
      stem_management: toCaps(company.stem_management),
      company_status: toCaps(company.company_status),
      company_info: toCaps(company.company_info),
      seller_term: toCaps(company.seller_term),
      seller_credit_limit: toCaps(company.seller_credit_limit),
      seller_credit_limit_flexibility: toCaps(company.seller_credit_limit_flexibility),
      seller_classification: toCaps(company.seller_classification),
      seller_remark_1: toCaps(company.seller_remark_1),
      seller_remark_2: toCaps(company.seller_remark_2),
      seller_remark_3: toCaps(company.seller_remark_3),
      seller_remark_4: toCaps(company.seller_remark_4),
      buyer_term: toCaps(company.buyer_term),
      buyer_credit_limit: toCaps(company.buyer_credit_limit),
      buyer_credit_limit_flexibility: toCaps(company.buyer_credit_limit_flexibility),
      buyer_classification: toCaps(company.buyer_classification),
      buyer_remark_1: toCaps(company.buyer_remark_1),
      buyer_remark_2: toCaps(company.buyer_remark_2),
      buyer_remark_3: toCaps(company.buyer_remark_3),
      buyer_remark_4: toCaps(company.buyer_remark_4),
      notes: toCaps(company.notes),
    }
    const { error } = await supabase.from("phonebook_companies").update(payload).eq("id", company.id)
    if (error) throw error
    companyUpdates += 1
    if (companyUpdates % 250 === 0 || companyUpdates === companies.length) {
      console.log(`Updated companies ${companyUpdates}/${companies.length}`)
    }
  }

  console.log(JSON.stringify({ contacts: contacts.length, companies: companies.length }, null, 2))
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
