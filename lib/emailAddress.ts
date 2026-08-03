export function normalizeEmailList(value: unknown) {
  const raw = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : ""

  return Array.from(
    new Set(
      raw
        .split(/[\n,;]+/)
        .map((item) => {
          const trimmed = item.trim().toLowerCase()
          return trimmed.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/)?.[1] || trimmed
        })
        .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)),
    ),
  )
}
