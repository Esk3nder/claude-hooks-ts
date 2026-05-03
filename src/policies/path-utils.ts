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
    const home = process.env["HOME"] ?? ""
    s = home + "/" + s.slice(2)
  } else if (s === "~") {
    s = process.env["HOME"] ?? "~"
  }
  s = s.replace(/\\/g, "/").replace(/\/+/g, "/")
  return s
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
