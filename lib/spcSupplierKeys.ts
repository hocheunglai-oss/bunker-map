function cleanText(value: unknown) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim()
}

function compactText(value: unknown) {
  return cleanText(value).replace(/\s+/g, " ").trim()
}

export const SUPPLIER_ALIASES: Record<string, string> = {
  BP: "BP MARINE",
  BPSINOPEC: "BP - SINOPEC",
  "BP SINOPEC": "BP - SINOPEC",
  CHIMBUSCCO: "CHIMBUSCO",
  "CHIMBUSCCO PAN NATION": "CHIMBUSCO PAN-NATION",
  "CHIMBUSCCO PAN NATION SG": "CHIMBUSCO PAN-NATION",
  "CHIMBUSCO PAN NATION": "CHIMBUSCO PAN-NATION",
  "CHIMBUSCO PAN NATION SG": "CHIMBUSCO PAN-NATION",
  "CHIMBUSCO SG": "PETRO-CHINA",
  EASTPEC: "EASTPAC",
  EXXON: "EXXONMOBIL",
  "GLOBAL MARINE": "GLOBAL MARINE TRANSPORTATION",
  "GLOBAL MARINE FC BDN": "GLOBAL MARINE TRANSPORTATION",
  "GLOBAL MARINE TRANSPORT": "GLOBAL MARINE TRANSPORTATION",
  GMT: "GLOBAL MARINE TRANSPORTATION",
  HAIYIN: "HAI YIN",
  "ITG XIANG YU": "OPULENT",
  "MGO GO": "CNC PETROLEUM",
  "MONJASA EASTPAC": "EASTPAC",
  OPPULENT: "OPULENT",
  "PETRO CHINA": "PETRO-CHINA",
  PETROCHINA: "PETRO-CHINA",
  "PETROCHINA CHIMBUSCO SG": "PETRO-CHINA",
  "SENTEK SINGFAR": "SENTEK",
  "SENTEK SINGFAR SFI ENERGY": "SENTEK",
  "SFI ENERGY EX SINGFAR": "SENTEK",
  "SFI ENERGY": "SENTEK",
  "TFG MARINE": "TFG MARINE",
  "TIMES MARINE": "TIMES MARINE",
  VITOL: "VITOL",
}

export function supplierBase(value: unknown) {
  return compactText(value)
    .replace(/\s*>>.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function normaliseSupplierToken(value: unknown) {
  return supplierBase(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " AND ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\bPTE\b|\bLTD\b|\bLIMITED\b|\bSINGAPORE\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
}

export function canonicalSupplierName(value: unknown) {
  const token = normaliseSupplierToken(value)
  return SUPPLIER_ALIASES[token] || token
}

export function supplierKey(value: unknown) {
  return canonicalSupplierName(value).replace(/[^A-Z0-9]+/g, "")
}

export function displaySupplierName(value: unknown) {
  return supplierBase(value).replace(/\s+/g, " ").trim()
}
