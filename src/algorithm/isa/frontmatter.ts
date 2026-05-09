/**
 * ISA frontmatter parser.
 *
 * Naive line-by-line YAML — does NOT use a YAML library. The choice is
 * deliberate: ISA frontmatter is a flat key:value map (8 required fields,
 * a handful of optional ones), and a YAML lib's quoting/normalization
 * semantics would diverge from what callers expect here.
 *
 * This module covers the on-disk read/write surface only — field
 * validation lives in `completeness.ts`.
 */

/**
 * Extract YAML frontmatter to a flat string map. Returns null when the file
 * has no `---\n…\n---` opening block.
 *
 * Mirror of the classifier. Quoted values are unwrapped (this package's
 * `.replace(/^["']|["']$/g, '')`). Multi-line values, nested objects, lists,
 * and arrays are NOT supported — same as this package.
 */
export const parseFrontmatter = (
 content: string,
): Record<string, string> | null => {
 const match = content.match(/^---\n([\s\S]*?)\n---/)
 if (!match || match[1] === undefined) return null
 const fm: Record<string, string> = {}
 for (const line of match[1].split("\n")) {
 const idx = line.indexOf(":")
 if (idx > 0) {
 fm[line.slice(0, idx).trim()] = line
 .slice(idx + 1)
 .trim()
 .replace(/^["']|["']$/g, "")
 }
 }
 return fm
}

/**
 * Update a single frontmatter field, in place. Returns the modified content
 * unchanged if the file has no frontmatter block.
 *
 * Mirror of the classifier. If the field doesn't exist, it's appended to the
 * end of the frontmatter block (this package's behavior).
 */
export const writeFrontmatterField = (
 content: string,
 field: string,
 value: string,
): string => {
 const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/)
 if (!fmMatch || fmMatch[1] === undefined || fmMatch[2] === undefined || fmMatch[3] === undefined) {
 return content
 }
 const lines = fmMatch[2].split("\n")
 let found = false
 for (let i = 0; i < lines.length; i++) {
 const line = lines[i]
 if (line !== undefined && line.startsWith(`${field}:`)) {
 lines[i] = `${field}: ${value}`
 found = true
 break
 }
 }
 if (!found) lines.push(`${field}: ${value}`)
 return fmMatch[1] + lines.join("\n") + fmMatch[3] + content.slice(fmMatch[0].length)
}
