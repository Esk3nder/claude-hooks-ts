import { Effect } from "effect"
import type { HookPayload } from "../schema/payloads.ts"
import type { HookDecision } from "../schema/decisions.ts"
import { SAFE_DEFAULT } from "../schema/decisions.ts"
import { Project } from "../services/project.ts"
import { Shell } from "../services/shell.ts"
import { makeShellCommand } from "../schema/branded.ts"

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Update"])

interface FormatterSpec {
  readonly probe: { cmd: string; args: ReadonlyArray<string> }
  readonly run: { cmd: string; args: (file: string) => ReadonlyArray<string> }
}

const FORMATTERS: ReadonlyArray<{
  readonly extensions: ReadonlyArray<string>
  readonly spec: FormatterSpec
}> = [
  {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md"],
    spec: {
      probe: { cmd: "sh", args: ["-c", "command -v prettier >/dev/null 2>&1"] },
      run: {
        cmd: "prettier",
        args: (file) => ["--write", file],
      },
    },
  },
  {
    extensions: [".py"],
    spec: {
      probe: { cmd: "sh", args: ["-c", "command -v ruff >/dev/null 2>&1"] },
      run: { cmd: "ruff", args: (file) => ["format", file] },
    },
  },
  {
    extensions: [".rs"],
    spec: {
      probe: { cmd: "sh", args: ["-c", "command -v rustfmt >/dev/null 2>&1"] },
      run: { cmd: "rustfmt", args: (file) => [file] },
    },
  },
  {
    extensions: [".go"],
    spec: {
      probe: { cmd: "sh", args: ["-c", "command -v gofmt >/dev/null 2>&1"] },
      run: { cmd: "gofmt", args: (file) => ["-w", file] },
    },
  },
]

const filePathFromInput = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null) return null
  const fp = (input as { file_path?: unknown }).file_path
  return typeof fp === "string" ? fp : null
}

const formatterFor = (filePath: string): FormatterSpec | null => {
  const lower = filePath.toLowerCase()
  for (const entry of FORMATTERS) {
    if (entry.extensions.some((ext) => lower.endsWith(ext))) return entry.spec
  }
  return null
}

export const handlePostToolUse = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, Project | Shell> =>
  Effect.gen(function* () {
    if (payload._tag !== "PostToolUse") return SAFE_DEFAULT
    if (!EDIT_TOOLS.has(payload.tool_name)) return SAFE_DEFAULT
    const file = filePathFromInput(payload.tool_input)
    if (file === null) return SAFE_DEFAULT
    const fmt = formatterFor(file)
    if (fmt === null) return SAFE_DEFAULT
    const shell = yield* Shell
    void (yield* Project) // ensure Project is in the context for symmetry / future use

    // Probe availability
    const probeCmdE = makeShellCommand(fmt.probe.cmd, fmt.probe.args)
    if (probeCmdE._tag === "Left") return SAFE_DEFAULT
    const probe = yield* shell
      .run(probeCmdE.right, { timeoutMs: 1500 })
      .pipe(
        Effect.catchAll((cause: unknown) => {
          const msg = String(cause).slice(0, 120)
          process.stderr.write(
            `post-edit-quality: ${fmt.probe.cmd} failed silently: ${msg}\n`,
          )
          return Effect.succeed({ stdout: "", stderr: "", exitCode: -1 })
        }),
      )
    if (probe.exitCode !== 0) return SAFE_DEFAULT

    // Run formatter best-effort
    const runCmdE = makeShellCommand(fmt.run.cmd, fmt.run.args(file))
    if (runCmdE._tag === "Left") return SAFE_DEFAULT
    yield* shell
      .run(runCmdE.right, { timeoutMs: 5000 })
      .pipe(
        Effect.catchAll((cause: unknown) => {
          const msg = String(cause).slice(0, 120)
          process.stderr.write(
            `post-edit-quality: ${fmt.run.cmd} failed silently: ${msg}\n`,
          )
          return Effect.succeed({ stdout: "", stderr: "", exitCode: -1 })
        }),
      )
    return SAFE_DEFAULT
  })
