function normalizeSearchText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
}

export function matchesSpcFixtureSearch(query: string, values: unknown[]) {
  const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = normalizeSearchText(values.join(" "))
  return tokens.every((token) => haystack.includes(token))
}
