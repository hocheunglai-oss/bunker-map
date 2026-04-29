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
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

const contactNames = ["RAYMOND WONG", "JESTER CHAN"];

const { data: contacts, error: contactError } = await supabase
  .from("phonebook_contacts")
  .select("*")
  .in("full_name", contactNames)
  .order("full_name");

if (contactError) {
  console.error("contactError", contactError);
  process.exit(1);
}

console.log("contacts");
console.log(JSON.stringify(contacts, null, 2));

const companyNames = [...new Set((contacts || []).map((contact) => contact.company).filter(Boolean))];

const { data: companies, error: companyError } = await supabase
  .from("phonebook_companies")
  .select("*")
  .in("name", companyNames)
  .order("name");

if (companyError) {
  console.error("companyError", companyError);
  process.exit(1);
}

console.log("companies");
console.log(JSON.stringify(companies, null, 2));
