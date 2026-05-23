import { Effect } from "effect"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { HookDecision } from "../schema/decisions.ts"
import { NO_DECISION } from "../schema/decisions.ts"
import type { HookPayload } from "../schema/payloads.ts"
import {
  RuntimeConfigService,
  type RuntimeConfig,
} from "../services/runtime-config.ts"
import { isSuccessfulToolResponse } from "../policies/tool-evidence.ts"

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".py", ".go"])
const DEFAULT_MAX_MARKDOWN_LINES = 50
const MAX_CALL_SITES = 20

interface ReadTldrOptions {
  readonly cacheRoot?: string
  readonly maxMarkdownLines?: number
}

interface TldrEntry {
  readonly line: number
  readonly name: string
  readonly kind?: string
  readonly detail?: string
}

interface TldrSummary {
  readonly filePath: string
  readonly lineCount: number
  readonly imports: ReadonlyArray<TldrEntry>
  readonly symbols: ReadonlyArray<TldrEntry>
  readonly exports: ReadonlyArray<TldrEntry>
  readonly callSites: ReadonlyArray<TldrEntry>
}

interface CacheEntry {
  readonly filePath: string
  readonly mtimeMs: number
  readonly size: number
  readonly lineCount: number
  readonly summaryMarkdown: string
  readonly generatedAt: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const readInputPath = (input: unknown): string | null => {
  if (!isRecord(input)) return null
  const filePath = input["file_path"] ?? input["path"]
  return typeof filePath === "string" && filePath.length > 0 ? filePath : null
}

const readInputOffset = (input: unknown): number | null => {
  if (!isRecord(input)) return null
  const offset = input["offset"]
  return typeof offset === "number" && Number.isFinite(offset) ? offset : null
}

const isFirstSliceRead = (input: unknown): boolean => {
  const offset = readInputOffset(input)
  return offset === null || offset <= 1
}

const resolveInputPath = (filePath: string, cwd: string | undefined): string => {
  const expanded =
    filePath === "~" || filePath.startsWith("~/")
      ? path.join(os.homedir(), filePath.slice(2))
      : filePath
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(cwd ?? process.cwd(), expanded)
}

const lineCount = (text: string): number =>
  text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length

const extensionFor = (filePath: string): string => {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(".d.ts")) return ".ts"
  return path.extname(lower)
}

const hashFilePath = (filePath: string): string =>
  crypto.createHash("sha256").update(path.resolve(filePath)).digest("hex")

export const defaultReadTldrCacheRoot = (): string =>
  path.join(os.homedir(), ".claude-hooks", "state", "tldr-cache")

export const readTldrCachePath = (
  filePath: string,
  cacheRoot = defaultReadTldrCacheRoot(),
): string => path.join(cacheRoot, `${hashFilePath(filePath)}.json`)

const readCachedSummary = (
  cachePath: string,
  stat: fs.Stats,
  currentLineCount: number,
): string | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Partial<CacheEntry>
    if (
      parsed.mtimeMs === stat.mtimeMs &&
      parsed.size === stat.size &&
      (parsed.lineCount === undefined || parsed.lineCount === currentLineCount) &&
      typeof parsed.summaryMarkdown === "string"
    ) {
      return parsed.summaryMarkdown
    }
  } catch {
    return null
  }
  return null
}

const writeCachedSummary = (
  cachePath: string,
  filePath: string,
  stat: fs.Stats,
  currentLineCount: number,
  summaryMarkdown: string,
): void => {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    const entry: CacheEntry = {
      filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      lineCount: currentLineCount,
      summaryMarkdown,
      generatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2))
  } catch {
    // Cache writes are best-effort; the hook can still inject this run's TLDR.
  }
}

const pushUnique = (entries: TldrEntry[], entry: TldrEntry): void => {
  if (entries.some((e) => e.line === entry.line && e.name === entry.name)) return
  entries.push(entry)
}

const trimDetail = (line: string): string => {
  const trimmed = line.trim()
  return trimmed.length > 100 ? `${trimmed.slice(0, 97)}...` : trimmed
}

const braceDelta = (line: string): number => {
  let delta = 0
  for (const char of line) {
    if (char === "{") delta++
    else if (char === "}") delta--
  }
  return delta
}

const firstCapture = (match: RegExpMatchArray | null): string | null => {
  const value = match?.[1]
  return value === undefined ? null : value
}

const extractTs = (
  lines: ReadonlyArray<string>,
): Omit<TldrSummary, "filePath" | "lineCount" | "callSites"> => {
  const imports: TldrEntry[] = []
  const symbols: TldrEntry[] = []
  const exports: TldrEntry[] = []
  let depth = 0

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = line.trim()
    const atTop = depth === 0

    if (/^import\b/.test(trimmed)) {
      const moduleName =
        firstCapture(trimmed.match(/\bfrom\s+["']([^"']+)["']/)) ??
        firstCapture(trimmed.match(/^import\s+["']([^"']+)["']/)) ??
        "import"
      pushUnique(imports, {
        line: lineNumber,
        name: moduleName,
        detail: trimDetail(line),
      })
    }

    if (atTop) {
      const symbolMatch =
        trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/) ??
        trimmed.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/) ??
        trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/) ??
        trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/) ??
        trimmed.match(/^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/) ??
        trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/)
      if (symbolMatch) {
        const name = firstCapture(symbolMatch)
        if (name === null) return
        const kind =
          trimmed.includes("function") || trimmed.includes("=>")
            ? "function"
            : trimmed.includes("class")
              ? "class"
              : trimmed.includes("interface")
                ? "interface"
                : trimmed.includes("type")
                  ? "type"
                  : trimmed.includes("enum")
                    ? "enum"
                    : "value"
        pushUnique(symbols, {
          line: lineNumber,
          name,
          kind,
          detail: trimDetail(line),
        })
      }

      if (/^export\b/.test(trimmed)) {
        const namedExport = trimmed.match(/^export\s*{\s*([^}]+)\s*}/)
        const namedExportList = firstCapture(namedExport)
        if (namedExportList !== null) {
          for (const raw of namedExportList.split(",")) {
            const name = raw
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/)
              .pop()
              ?.trim()
            if (name) {
              pushUnique(exports, {
                line: lineNumber,
                name,
                detail: trimDetail(line),
              })
            }
          }
        } else {
          const declExport =
            trimmed.match(/^export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/) ??
            trimmed.match(/^export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/) ??
            trimmed.match(/^export\s+interface\s+([A-Za-z_$][\w$]*)\b/) ??
            trimmed.match(/^export\s+type\s+([A-Za-z_$][\w$]*)\b/) ??
            trimmed.match(/^export\s+enum\s+([A-Za-z_$][\w$]*)\b/) ??
            trimmed.match(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/) ??
            trimmed.match(/^export\s+default\s+([A-Za-z_$][\w$]*)\b/)
          pushUnique(exports, {
            line: lineNumber,
            name: firstCapture(declExport) ?? "default",
            detail: trimDetail(line),
          })
        }
      }
    }

    depth = Math.max(0, depth + braceDelta(line))
  })

  return { imports, symbols, exports }
}

const extractPython = (
  lines: ReadonlyArray<string>,
): Omit<TldrSummary, "filePath" | "lineCount" | "callSites"> => {
  const imports: TldrEntry[] = []
  const symbols: TldrEntry[] = []
  const exports: TldrEntry[] = []

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = line.trim()
    const atTop = line.length === line.trimStart().length

    if (atTop && /^(?:from\s+\S+\s+import|import)\b/.test(trimmed)) {
      pushUnique(imports, {
        line: lineNumber,
        name: trimmed.split(/\s+/).slice(0, 3).join(" "),
        detail: trimDetail(line),
      })
    }

    if (atTop) {
      const symbolMatch =
        trimmed.match(/^(?:async\s+def|def)\s+([A-Za-z_]\w*)\s*\(/) ??
        trimmed.match(/^class\s+([A-Za-z_]\w*)\b/) ??
        trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=/)
      if (symbolMatch) {
        const name = firstCapture(symbolMatch)
        if (name === null) return
        const kind = trimmed.startsWith("class ")
          ? "class"
          : trimmed.includes("def ")
            ? "function"
            : "value"
        pushUnique(symbols, {
          line: lineNumber,
          name,
          kind,
          detail: trimDetail(line),
        })
      }

      const allMatch = trimmed.match(/^__all__\s*=\s*\[([^\]]*)\]/)
      const allList = firstCapture(allMatch)
      if (allList !== null) {
        for (const quoted of allList.matchAll(/["']([^"']+)["']/g)) {
          const name = firstCapture(quoted)
          if (name === null) continue
          pushUnique(exports, {
            line: lineNumber,
            name,
            detail: trimDetail(line),
          })
        }
      }
    }
  })

  if (exports.length === 0) {
    for (const symbol of symbols.filter((s) => !s.name.startsWith("_"))) {
      pushUnique(exports, symbol)
    }
  }

  return { imports, symbols, exports }
}

const extractGo = (
  lines: ReadonlyArray<string>,
): Omit<TldrSummary, "filePath" | "lineCount" | "callSites"> => {
  const imports: TldrEntry[] = []
  const symbols: TldrEntry[] = []
  let inImportBlock = false
  let depth = 0

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = line.trim()
    const atTop = depth === 0

    if (atTop && trimmed === "import (") {
      inImportBlock = true
      pushUnique(imports, { line: lineNumber, name: "import", detail: "import (...)" })
    } else if (inImportBlock) {
      if (trimmed === ")") inImportBlock = false
      const moduleName = firstCapture(trimmed.match(/"([^"]+)"/))
      if (moduleName) {
        pushUnique(imports, {
          line: lineNumber,
          name: moduleName,
          detail: trimDetail(line),
        })
      }
    } else if (atTop && /^import\s+/.test(trimmed)) {
      pushUnique(imports, {
        line: lineNumber,
        name: firstCapture(trimmed.match(/"([^"]+)"/)) ?? "import",
        detail: trimDetail(line),
      })
    }

    if (atTop) {
      const symbolMatch =
        trimmed.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/) ??
        trimmed.match(/^type\s+([A-Za-z_]\w*)\b/) ??
        trimmed.match(/^(?:const|var)\s+([A-Za-z_]\w*)\b/)
      if (symbolMatch) {
        const name = firstCapture(symbolMatch)
        if (name === null) return
        const kind = trimmed.startsWith("func ")
          ? "function"
          : trimmed.startsWith("type ")
            ? "type"
            : "value"
        pushUnique(symbols, {
          line: lineNumber,
          name,
          kind,
          detail: trimDetail(line),
        })
      }
    }

    depth = Math.max(0, depth + braceDelta(line))
  })

  return {
    imports,
    symbols,
    exports: symbols.filter((s) => /^[A-Z]/.test(s.name)),
  }
}

const extractCallSites = (
  lines: ReadonlyArray<string>,
  symbols: ReadonlyArray<TldrEntry>,
): ReadonlyArray<TldrEntry> => {
  const symbolLines = new Map(symbols.map((s) => [s.name, s.line]))
  const names = new Set(symbols.map((s) => s.name))
  const callSites: TldrEntry[] = []

  lines.forEach((line, index) => {
    if (callSites.length >= MAX_CALL_SITES) return

    const lineNumber = index + 1
    const trimmed = line.trim()
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("from ") ||
      trimmed.startsWith("export ") ||
      trimmed.startsWith("def ") ||
      trimmed.startsWith("async def ") ||
      trimmed.startsWith("func ") ||
      trimmed.startsWith("class ")
    ) {
      return
    }

    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = firstCapture(match)
      if (name === null) continue
      if (!names.has(name)) continue
      if (symbolLines.get(name) === lineNumber) continue
      pushUnique(callSites, {
        line: lineNumber,
        name,
        kind: "call",
        detail: trimDetail(line),
      })
      if (callSites.length >= MAX_CALL_SITES) return
    }
  })

  return callSites
}

export const summarizeSource = (
  filePath: string,
  text: string,
): TldrSummary => {
  const lines = text.split(/\r\n|\r|\n/)
  const ext = extensionFor(filePath)
  const base =
    ext === ".py"
      ? extractPython(lines)
      : ext === ".go"
        ? extractGo(lines)
        : extractTs(lines)
  return {
    filePath,
    lineCount: lineCount(text),
    ...base,
    callSites: extractCallSites(lines, base.symbols),
  }
}

const renderEntry = (entry: TldrEntry): string => {
  const kind = entry.kind === undefined ? "" : ` ${entry.kind}`
  const detail = entry.detail === undefined ? "" : ` — \`${entry.detail}\``
  return `- L${entry.line} \`${entry.name}\`${kind}${detail}`
}

export const renderReadTldr = (
  summary: TldrSummary,
  maxLines = DEFAULT_MAX_MARKDOWN_LINES,
): string => {
  const lines: string[] = [
    `### Read TLDR: ${summary.filePath}`,
    "",
    `_File has ${summary.lineCount} lines. Heuristic v1 summary; cache key is file mtime+size._`,
  ]

  const appendSection = (
    title: string,
    entries: ReadonlyArray<TldrEntry>,
    maxEntries: number,
  ): void => {
    if (lines.length >= maxLines) return
    lines.push("", `**${title}**`)
    if (entries.length === 0) {
      lines.push("- none found")
      return
    }
    const remainingSlots = Math.max(0, maxLines - lines.length - 1)
    const take = Math.min(entries.length, maxEntries, remainingSlots)
    for (const entry of entries.slice(0, take)) {
      lines.push(renderEntry(entry))
    }
    if (entries.length > take && lines.length < maxLines) {
      lines.push(`- ... ${entries.length - take} more`)
    }
  }

  appendSection("Imports", summary.imports, 10)
  appendSection("Top-level symbols", summary.symbols, 18)
  appendSection("Public exports", summary.exports, 12)
  appendSection("Call sites", summary.callSites, 8)

  if (lines.length > maxLines) {
    return [...lines.slice(0, maxLines - 1), "- ... TLDR truncated"].join("\n")
  }
  return lines.join("\n")
}

const buildSummaryMarkdown = (
  filePath: string,
  config: RuntimeConfig,
  options: ReadTldrOptions,
): string | null => {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) return null
  const text = fs.readFileSync(filePath, "utf8")
  const currentLineCount = lineCount(text)
  if (currentLineCount <= config.readTldrMinLines) return null

  const cacheRoot = options.cacheRoot ?? defaultReadTldrCacheRoot()
  const cachePath = readTldrCachePath(filePath, cacheRoot)
  const cached = readCachedSummary(cachePath, stat, currentLineCount)
  if (cached !== null) return cached

  const summary = summarizeSource(filePath, text)
  const markdown = renderReadTldr(
    summary,
    options.maxMarkdownLines ?? DEFAULT_MAX_MARKDOWN_LINES,
  )
  writeCachedSummary(cachePath, filePath, stat, currentLineCount, markdown)
  return markdown
}

export const handleReadTldr = (
  payload: HookPayload,
  options: ReadTldrOptions = {},
): Effect.Effect<HookDecision, never, RuntimeConfigService> =>
  Effect.gen(function* () {
    if (payload._tag !== "PostToolUse") return NO_DECISION
    if (payload.tool_name !== "Read") return NO_DECISION

    const configService = yield* RuntimeConfigService
    const config = yield* configService.load()
    if (!config.readTldrEnabled) return NO_DECISION
    if (!isSuccessfulToolResponse(payload.tool_response)) return NO_DECISION
    if (!isFirstSliceRead(payload.tool_input)) return NO_DECISION

    const inputPath = readInputPath(payload.tool_input)
    if (inputPath === null) return NO_DECISION
    const filePath = resolveInputPath(inputPath, payload.cwd)
    if (!SUPPORTED_EXTENSIONS.has(extensionFor(filePath))) return NO_DECISION

    const markdown = yield* Effect.sync(() =>
      buildSummaryMarkdown(filePath, config, options),
    ).pipe(Effect.catchAll(() => Effect.succeed(null)))

    if (markdown === null) return NO_DECISION
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: markdown,
      },
    }
  })
