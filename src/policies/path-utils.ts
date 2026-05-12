import { homedir } from "node:os"
import * as path from "node:path"

/**
 * Glob → RegExp converter scoped to the patterns we use in M2 policies.
 * Supports `**`, `*`, `?`, character classes, and brace alternatives `{a,b}`.
 *
 * Matches against POSIX-style paths; callers should normalize.
 */
export const globToRegExp = (glob: string): RegExp => {
  let i = 0
  let out = "^"
  while (i < glob.length) {
    const c = glob[i]!
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** — match across path separators
        // consume optional trailing slash
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?"
          i += 3
        } else {
          out += ".*"
          i += 2
        }
      } else {
        out += "[^/]*"
        i += 1
      }
    } else if (c === "?") {
      out += "[^/]"
      i += 1
    } else if (c === "{") {
      const end = glob.indexOf("}", i)
      if (end === -1) {
        out += "\\{"
        i += 1
      } else {
        const alts = glob.slice(i + 1, end).split(",").map(escapeRegex)
        out += "(?:" + alts.join("|") + ")"
        i = end + 1
      }
    } else if (c === "[") {
      const end = glob.indexOf("]", i)
      if (end === -1) {
        out += "\\["
        i += 1
      } else {
        out += glob.slice(i, end + 1)
        i = end + 1
      }
    } else {
      out += escapeRegexChar(c)
      i += 1
    }
  }
  out += "$"
  return new RegExp(out)
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const escapeRegexChar = (c: string): string =>
  /[.*+?^${}()|[\]\\]/.test(c) ? "\\" + c : c

/** Normalize: collapse `//`, expand `~/` to `${HOME}/`. */
export const normalizePath = (p: string): string => {
  let s = p
  if (s.startsWith("~/")) {
    const home = homedir()
    s = home + "/" + s.slice(2)
  } else if (s === "~") {
    s = homedir() || "~"
  }
  s = s.replace(/\\/g, "/").replace(/\/+/g, "/")
  return s
}

const stripDotPrefix = (p: string): string => p.replace(/^\.\//, "")

/** Normalize a policy glob/source pattern without changing wildcard meaning. */
export const normalizePathPattern = (pattern: string): string =>
  stripDotPrefix(normalizePath(pattern))

const isInsideRootRelative = (relativePath: string): boolean =>
  relativePath.length === 0 ||
  (relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath))

/**
 * Build path spellings that repo-local glob policies should consider for a
 * changed file.
 *
 * Session state usually records Edit/Write `file_path` values exactly as
 * Claude Code supplied them, which is commonly absolute (`/repo/src/a.ts`).
 * User policy files, however, are normally repo-relative (`src/*.ts`). Return
 * both the original normalized spelling and, when the path is inside `root`,
 * the repo-relative spelling so anchored glob rules match normal edits.
 *
 * For relative inputs we also include the root-absolute spelling, preserving
 * compatibility with uncommon absolute policy rules.
 */
export const expandPathMatchCandidates = (
  root: string,
  paths: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const out = new Set<string>()
  const rootAbs = path.resolve(root)

  const add = (candidate: string): void => {
    const normalized = normalizePathPattern(candidate)
    if (normalized.length > 0) out.add(normalized)
  }

  for (const raw of paths) {
    if (raw.length === 0) continue
    add(raw)

    // Windows absolute paths cannot be relativized meaningfully with POSIX
    // `path.relative` on macOS/Linux. Keep their normalized original spelling.
    if (path.win32.isAbsolute(raw) && !path.isAbsolute(raw)) continue

    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(rootAbs, raw)
    add(abs)

    const rel = path.relative(rootAbs, abs)
    if (isInsideRootRelative(rel)) add(rel.length === 0 ? "." : rel)
  }

  return [...out]
}

/** Test a path against any of a list of glob patterns. */
export const matchesAnyGlob = (
  path: string,
  globs: ReadonlyArray<string>,
): string | undefined => {
  const norm = normalizePath(path)
  const basename = norm.slice(norm.lastIndexOf("/") + 1)
  for (const g of globs) {
    const re = globToRegExp(g)
    if (re.test(norm) || re.test(basename)) return g
  }
  return undefined
}
