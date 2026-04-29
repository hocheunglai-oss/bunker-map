import fs from "fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const env = {};
  for (const rawLine of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    env[key] = value;
  }
  return env;
}

function normalizeText(value) {
  return (value || "").trim();
}

function buildStrictCompanyPhone(company) {
  const country = normalizeText(company.tel_country);
  const area = normalizeText(company.tel_area);
  const tel1 = normalizeText(company.tel_no_1);

  if (!tel1) return "";
  if (country === "852" || company.country === "HONG KONG") return tel1;
  if (country && area) return `+${country}-${area}-${tel1}`;
  if (country) return `+${country}-${tel1}`;
  if (area) return `${area}-${tel1}`;
  return tel1;
}

const env = loadEnv();
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

const names = ["ADITYA TANGUDU", "STANLEY DU", "JOEY WEI"];

const { data: contacts, error: contactError } = await supabase
  .from("phonebook_contacts")
  .select("id,full_name,company")
  .in("full_name", names);

if (contactError) {
  console.error(contactError);
  process.exit(1);
}

console.log("contacts");
console.log(JSON.stringify(contacts, null, 2));

const companyNames = [...new Set((contacts || []).map((c) => c.company).filter(Boolean))];
if (!companyNames.length) process.exit(0);

const { data: companies, error: companyError } = await supabase
  .from("phonebook_companies")
  .select("name,country,tel_country,tel_area,tel_no_1,phone")
  .in("name", companyNames);

if (companyError) {
  console.error(companyError);
  process.exit(1);
}

console.log("companies");
console.log(JSON.stringify(companies, null, 2));

console.log("computed");
for (const company of companies || []) {
  console.log(company.name, "=>", buildStrictCompanyPhone(company));
}
