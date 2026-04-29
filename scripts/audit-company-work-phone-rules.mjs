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
  if (country === "852") return tel1;
  if (country && area) return `+${country}-${area}-${tel1}`;
  if (country) return `+${country}-${tel1}`;
  return "";
}

const env = loadEnv();
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

const rows = [];
let from = 0;
const pageSize = 1000;
while (true) {
  const { data, error } = await supabase
    .from("phonebook_companies")
    .select("name,country,tel_country,tel_area,tel_no_1,phone")
    .order("name")
    .range(from, from + pageSize - 1);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  rows.push(...(data || []));
  if (!data || data.length < pageSize) break;
  from += pageSize;
}

const suspicious = rows
  .map((company) => ({
    name: company.name,
    country: company.country,
    tel_country: company.tel_country,
    tel_area: company.tel_area,
    tel_no_1: company.tel_no_1,
    phone: company.phone,
    strict: buildStrictCompanyPhone(company),
  }))
  .filter((company) => {
    const rawPhone = normalizeText(company.phone);
    return rawPhone && !company.strict;
  });

console.log(`companies with raw phone but no strict work phone: ${suspicious.length}`);
console.log(JSON.stringify(suspicious.slice(0, 200), null, 2));
