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
  .select("id,name")
  .eq("other_name", "TO BE DELETED");

if (error) {
  console.error("company lookup failed", error);
  process.exit(1);
}

if (!companies.length) {
  console.log("deleted 0");
  process.exit(0);
}

const ids = companies.map((company) => company.id);

const { error: deleteError } = await supabase
  .from("phonebook_companies")
  .delete()
  .in("id", ids);

if (deleteError) {
  console.error("delete failed", deleteError);
  process.exit(1);
}

console.log(`deleted ${ids.length}`);
