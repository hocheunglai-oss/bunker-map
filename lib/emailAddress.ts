function hasEmailShape(value: string, rejectAngles = false) {
  if (!value || /\s/.test(value)) return false
  if (rejectAngles && (value.includes("<") || value.includes(">"))) return false

  const at = value.indexOf("@")
  if (at <= 0 || at !== value.lastIndexOf("@")) return false

  const dot = value.indexOf(".", at + 2)
  return dot >= 0 && dot < value.length - 1
}

function extractAngleAddress(value: string) {
  let start = -1

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === "<") {
      start = index + 1
    } else if (character === ">" && start >= 0) {
      const candidate = value.slice(start, index)
      if (hasEmailShape(candidate, true)) return candidate
      start = -1
    }
  }

  return null
}

export function normalizeEmailList(value: unknown) {
  const raw = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : ""

  return Array.from(
    new Set(
      raw
        .split(/[\n,;]+/)
        .map((item) => {
          const trimmed = item.trim().toLowerCase()
          return extractAngleAddress(trimmed) || trimmed
        })
        .filter((item) => hasEmailShape(item)),
    ),
  )
}
