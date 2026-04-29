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

const env = loadEnv();
const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const { data: companies, error } = await supabase
  .from("phonebook_companies")
  .select("id,name,other_name")
  .eq("other_name", "TO BE DELETED")
  .order("name");

if (error) {
  console.error("company query failed", error);
  process.exit(1);
}

console.log("companies", companies.length);
console.log(JSON.stringify(companies, null, 2));

const companyNames = [...new Set(companies.map((company) => company.name).filter(Boolean))];

if (!companyNames.length) {
  process.exit(0);
}

const { data: contacts, error: contactError } = await supabase
  .from("phonebook_contacts")
  .select("id,full_name,company")
  .in("company", companyNames)
  .order("company");

if (contactError) {
  console.error("contact query failed", contactError);
  process.exit(1);
}

console.log("contacts", contacts.length);
console.log(JSON.stringify(contacts, null, 2));
