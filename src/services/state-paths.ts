import * as crypto from "node:crypto"

const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/

const hashSuffix = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)

const slugSegment = (value: string, fallback: string): string => {
  const slug = value
    .trim()
    .replace(/[\\/]/g, "-")
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/\.\.+/g, ".")
    .replace(/^[.-]+/, "")
    .slice(0, 80)
  return slug.length > 0 ? slug : fallback
}

export const safeStateSegment = (
  value: string,
  fallback = "state",
): string => {
  const trimmed = value.trim()
  if (
    SAFE_SEGMENT_RE.test(trimmed) &&
    !trimmed.includes("..") &&
    trimmed !== "." &&
    trimmed !== ".."
  ) {
    return trimmed
  }
  return `${slugSegment(value, fallback)}-${hashSuffix(value)}`
}
