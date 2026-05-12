/**
 * Minimal shell-word helpers for hook command strings.
 *
 * We only need the subset emitted by this package (`'single quoted path' ARG`)
 * plus enough compatibility for existing unquoted settings. This is not a
 * shell evaluator: it does not expand variables, globs, command substitution,
 * or redirections.
 */

export const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`

export const splitShellWords = (input: string): ReadonlyArray<string> => {
  const out: string[] = []
  let current = ""
  let quote: "'" | "\"" | null = null
  let started = false

  const push = (): void => {
    if (!started) return
    out.push(current)
    current = ""
    started = false
  }

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!

    if (quote === "'") {
      if (ch === "'") {
        quote = null
      } else {
        current += ch
      }
      started = true
      continue
    }

    if (quote === "\"") {
      if (ch === "\"") {
        quote = null
      } else if (ch === "\\" && i + 1 < input.length) {
        i += 1
        current += input[i]!
      } else {
        current += ch
      }
      started = true
      continue
    }

    if (/\s/.test(ch)) {
      push()
      continue
    }
    if (ch === "'" || ch === "\"") {
      quote = ch
      started = true
      continue
    }
    if (ch === "\\" && i + 1 < input.length) {
      i += 1
      current += input[i]!
      started = true
      continue
    }

    current += ch
    started = true
  }

  push()
  return out
}
