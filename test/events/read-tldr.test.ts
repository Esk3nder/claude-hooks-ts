import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { handleReadTldr, summarizeSource } from "../../src/events/read-tldr.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { RuntimeConfigTest } from "../../src/services/runtime-config.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const readPayload = (file: string, input: Record<string, unknown> = {}) =>
  decode({
    _tag: "PostToolUse",
    session_id: "s",
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: file, ...input },
    tool_response: { success: true },
  })

const runReadTldr = (
  file: string,
  cacheRoot: string,
  input = {},
  readTldrMinLines = 5,
) =>
  Effect.runPromise(
    handleReadTldr(readPayload(file, input), { cacheRoot }).pipe(
      Effect.provide(
        RuntimeConfigTest({
          readTldrEnabled: true,
          readTldrMinLines,
        }),
      ),
    ),
  )

const writeLargeTs = (dir: string): string => {
  const file = path.join(dir, "large.ts")
  fs.writeFileSync(
    file,
    [
      'import { Effect } from "effect"',
      'import helperDefault from "./helper"',
      "",
      "export interface Widget {",
      "  id: string",
      "}",
      "",
      "export const exportedValue = 1",
      "",
      "function localHelper() {",
      "  return exportedValue",
      "}",
      "",
      "export function exportedFunction() {",
      "  return localHelper()",
      "}",
      "",
      "export class PublicClass {",
      "  render() {",
      "    return exportedFunction()",
      "  }",
      "}",
      "",
      "const boot = exportedFunction()",
    ].join("\n"),
  )
  return file
}

describe("handleReadTldr", () => {
  test("disabled by default returns no injection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-tldr-"))
    const cacheRoot = path.join(dir, "cache")
    const file = writeLargeTs(dir)

    const decision = await Effect.runPromise(
      handleReadTldr(readPayload(file), { cacheRoot }).pipe(
        Effect.provide(RuntimeConfigTest()),
      ),
    )

    expect(decision).toEqual({})
  })

  test("small file returns no injection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-tldr-"))
    const cacheRoot = path.join(dir, "cache")
    const file = path.join(dir, "small.ts")
    fs.writeFileSync(file, 'export function tiny() { return "ok" }\n')

    const decision = await runReadTldr(file, cacheRoot)

    expect(decision).toEqual({})
  })

  test("large TS file injects imports, symbols, and public exports", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-tldr-"))
    const cacheRoot = path.join(dir, "cache")
    const file = writeLargeTs(dir)

    const decision = await runReadTldr(file, cacheRoot)
    const out = decision as {
      hookSpecificOutput?: { additionalContext?: string }
    }
    const context = out.hookSpecificOutput?.additionalContext ?? ""

    expect(out.hookSpecificOutput).toBeDefined()
    expect(context).toContain("Read TLDR")
    expect(context).toContain("Imports")
    expect(context).toContain("Top-level symbols")
    expect(context).toContain("Public exports")
    expect(context).toContain("exportedFunction")
    expect(context).toContain("PublicClass")
    expect(context).toContain("Widget")
    expect(context.split("\n").length).toBeLessThanOrEqual(50)
  })

  test("caps call-site extraction at twenty entries", () => {
    const source = [
      "function target() { return 1 }",
      ...Array.from(
        { length: 40 },
        (_, index) => `const value${index} = target()`,
      ),
    ].join("\n")

    const summary = summarizeSource("/tmp/many.ts", source)

    expect(summary.callSites).toHaveLength(20)
    expect(summary.callSites.at(-1)?.line).toBe(21)
  })

  test("second read hits the mtime+size cache", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-tldr-"))
    const cacheRoot = path.join(dir, "cache")
    const file = writeLargeTs(dir)

    await runReadTldr(file, cacheRoot)
    const [cacheFile] = fs.readdirSync(cacheRoot)
    expect(cacheFile).toBeDefined()
    if (cacheFile === undefined) throw new Error("expected read TLDR cache file")
    const cachePath = path.join(cacheRoot, cacheFile)
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      summaryMarkdown: string
    }
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        ...cached,
        summaryMarkdown: "### Read TLDR\n\nCACHED TLDR SENTINEL",
      }),
    )

    const decision = await runReadTldr(file, cacheRoot)
    const out = decision as {
      hookSpecificOutput?: { additionalContext?: string }
    }

    expect(out.hookSpecificOutput?.additionalContext ?? "").toContain(
      "CACHED TLDR SENTINEL",
    )
  })

  test("raised threshold suppresses a previously cached file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-tldr-"))
    const cacheRoot = path.join(dir, "cache")
    const file = writeLargeTs(dir)

    await runReadTldr(file, cacheRoot, {}, 5)
    const decision = await runReadTldr(file, cacheRoot, {}, 1_000)

    expect(decision).toEqual({})
  })
})
