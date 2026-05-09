/**
 * End-to-end integration: UserPromptSubmit handler with all this package features
 * threaded through. Asserts:
 * - transcript_path → context flows into Inference (L10)
 * - Telemetry record is appended (L11)
 * - cleanPrompt runs before subprocess (L12)
 * - System-text returns SAFE_DEFAULT, NO classification, NO telemetry (L14)
 * - Workflow line + mode line are emitted in order (B4)
 */
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleUserPromptSubmit } from "../../src/events/prompt-router.ts"
import { HookPayload } from "../../src/schema/payloads.ts"
import { SessionStateTest } from "../../src/services/session-state.ts"
import {
  ClaudeSubprocessTest,
  type ClaudeSpawnOptions,
} from "../../src/services/claude-subprocess.ts"
import {
  Inference,
  InferenceLive,
  type Classification,
  type ClassifyOptions,
} from "../../src/services/inference.ts"
import { ClassifierTelemetryTest } from "../../src/services/classifier-telemetry.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

interface RunResult {
  raw: string
  workflowLine: string
  modeLine: string
  capturedClassifyOpts: ClassifyOptions | undefined
  capturedSubprocStdin: string | null
  telemetryRecords: ReadonlyArray<unknown>
}

/**
 * Run handler with InferenceLive (so Inference's classify actually goes
 * through cleanPrompt + buildUserPrompt + ClaudeSubprocess), but the
 * subprocess returns a canned response. This proves the WHOLE pipeline.
 */
const runE2E = async (input: {
  prompt: string
  transcriptPath?: string
  subprocResponse: string
}): Promise<RunResult> => {
  const tel = ClassifierTelemetryTest()
  let capturedSubprocStdin: string | null = null
  const subprocLayer = ClaudeSubprocessTest(
    (args, opts: ClaudeSpawnOptions) => {
      void args
      capturedSubprocStdin = opts.stdin
      return {
        stdout: input.subprocResponse,
        stderr: "",
        exitCode: 0,
        latencyMs: 100,
        timedOut: false,
      }
    },
  )
  const payload = decode({
    _tag: "UserPromptSubmit",
    session_id: "sid-e2e",
    hook_event_name: "UserPromptSubmit",
    prompt: input.prompt,
    ...(input.transcriptPath !== undefined
      ? { transcript_path: input.transcriptPath }
      : {}),
  })
  const decision = await Effect.runPromise(
    handleUserPromptSubmit(payload).pipe(
      Effect.provide(InferenceLive),
      Effect.provide(subprocLayer),
      Effect.provide(SessionStateTest()),
      Effect.provide(tel.layer),
    ),
  )
  const out = decision as {
    hookSpecificOutput?: { additionalContext?: string }
  }
  const raw = out.hookSpecificOutput?.additionalContext ?? ""
  const [workflowLine = "", modeLine = ""] = raw.split("\n")
  return {
    raw,
    workflowLine,
    modeLine,
    capturedClassifyOpts: undefined,
    capturedSubprocStdin,
    telemetryRecords: tel.records(),
  }
}

describe("UserPromptSubmit E2E — all this package features", () => {
  test("ambiguous prompt with transcript context: full pipeline fires", async () => {
    const root = mkdtempSync(join(tmpdir(), "e2e-"))
    try {
      const transcriptFile = join(root, "transcript.jsonl")
      writeFileSync(
        transcriptFile,
        [
          JSON.stringify({
            type: "assistant",
            message: { content: "proposed three numbered fixes" },
          }),
        ].join("\n"),
        "utf8",
      )
      const result = await runE2E({
        prompt: "<wrapper>yes do them</wrapper>",
        transcriptPath: transcriptFile,
        subprocResponse: `{"mode":"ALGORITHM","tier":3,"mode_reason":"approves multi-step plan"}`,
      })

      // L10: context fed to subprocess stdin
      expect(result.capturedSubprocStdin).toContain("CONTEXT:")
      expect(result.capturedSubprocStdin).toContain(
        "proposed three numbered fixes",
      )
      expect(result.capturedSubprocStdin).toContain("CURRENT MESSAGE:")

      // L12: cleanPrompt stripped <wrapper> tags
      expect(result.capturedSubprocStdin).not.toContain("<wrapper>")
      expect(result.capturedSubprocStdin).toContain("yes do them")

      // B4: two-line emission
      expect(result.workflowLine).toContain("Detected workflow:")
      expect(result.modeLine).toContain("MODE: ALGORITHM | TIER: E3")
      expect(result.modeLine).toContain("approves multi-step plan")

      // L11: telemetry record appended
      expect(result.telemetryRecords.length).toBe(1)
      const r = result.telemetryRecords[0] as {
        mode: string
        tier: number
        mode_reason: string
        source: string
        session_id: string
      }
      expect(r.mode).toBe("ALGORITHM")
      expect(r.tier).toBe(3)
      expect(r.source).toBe("classifier")
      expect(r.session_id).toBe("sid-e2e")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("system-text prompt: SAFE_DEFAULT, NO classification, NO telemetry", async () => {
    const result = await runE2E({
      prompt: "<system-reminder>this is injected</system-reminder>",
      subprocResponse: `{"mode":"ALGORITHM","tier":3,"mode_reason":"should not be reached"}`,
    })
    // L14: the classifier — process.exit without emission
    expect(result.raw).toBe("")
    // No classification → no telemetry record
    expect(result.telemetryRecords.length).toBe(0)
    // No subprocess call at all
    expect(result.capturedSubprocStdin).toBeNull()
  })

  test("fast-path 'excellent' praise: classified MINIMAL, telemetry shows fast-path, no subprocess", async () => {
    const result = await runE2E({
      prompt: "excellent",
      subprocResponse: `{"mode":"ALGORITHM","tier":3,"mode_reason":"would be wrong"}`,
    })
    expect(result.modeLine).toContain("MODE: MINIMAL")
    // B2 invariant: additionalContext collapses fast-path to "classifier"
    // (the classifier hardcodes), but telemetry preserves the distinction.
    expect(result.modeLine).toContain("SOURCE: classifier")
    expect(result.modeLine).not.toContain("SOURCE: fast-path")
    // Fast-path → no subprocess
    expect(result.capturedSubprocStdin).toBeNull()
    // Telemetry records WITH source: "fast-path" — that's how auditors
    // compute classifier-vs-fast-path-vs-fail-safe ratio.
    expect(result.telemetryRecords.length).toBe(1)
    const r = result.telemetryRecords[0] as { mode: string; source: string }
    expect(r.mode).toBe("MINIMAL")
    expect(r.source).toBe("fast-path")
  })

  test("missing transcript_path → context is empty, classifier still runs", async () => {
    const result = await runE2E({
      prompt: "implement the thing",
      subprocResponse: `{"mode":"ALGORITHM","tier":3,"mode_reason":"build"}`,
    })
    // No CONTEXT: framing because no context was found
    expect(result.capturedSubprocStdin).not.toContain("CONTEXT:")
    expect(result.capturedSubprocStdin).toContain("implement the thing")
    expect(result.modeLine).toContain("MODE: ALGORITHM")
  })

  test("classifier disabled via env: fail-safe E3 emitted, telemetry recorded", async () => {
    process.env["CLAUDE_HOOKS_DISABLE_CLASSIFIER"] = "1"
    try {
      const result = await runE2E({
        prompt: "implement the thing",
        subprocResponse: `{"mode":"NATIVE","tier":null,"mode_reason":"would be wrong"}`,
      })
      expect(result.modeLine).toContain("MODE: ALGORITHM | TIER: E3")
      expect(result.modeLine).toContain("SOURCE: fail-safe")
      // Subprocess not called when classifier is disabled
      expect(result.capturedSubprocStdin).toBeNull()
      expect(result.telemetryRecords.length).toBe(1)
    } finally {
      delete process.env["CLAUDE_HOOKS_DISABLE_CLASSIFIER"]
    }
  })
})

describe("Inference symbol surfaces", () => {
  test("re-import for sanity", () => {
    expect(Inference).toBeDefined()
  })
  test("Classification type compiles", () => {
    const c: Classification = {
      mode: "MINIMAL",
      tier: null,
      reason: "x",
      source: "classifier",
      latencyMs: 0,
    }
    expect(c.mode).toBe("MINIMAL")
  })
})
