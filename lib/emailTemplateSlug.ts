export function slugifyEmailTemplate(input: string) {
  const hyphenated = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
  let start = 0
  let end = hyphenated.length
  while (hyphenated.charCodeAt(start) === 45) start += 1
  while (end > start && hyphenated.charCodeAt(end - 1) === 45) end -= 1
  return hyphenated.slice(start, end).slice(0, 80)
}
