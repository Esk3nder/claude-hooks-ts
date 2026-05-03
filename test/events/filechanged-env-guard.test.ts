import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handleFileChanged } from "../../src/events/filechanged-env-guard.ts"
import { HookPayload } from "../../src/schema/payloads.ts"

const decode = (raw: unknown) => Schema.decodeUnknownSync(HookPayload)(raw)

const fileChange = (file_path: string, change_type = "modified") =>
  decode({
    _tag: "FileChanged",
    session_id: "s",
    hook_event_name: "FileChanged",
    file_path,
    change_type,
  })

describe("handleFileChanged", () => {
  test("alerts on .env modification", async () => {
    const d = await Effect.runPromise(handleFileChanged(fileChange("/repo/.env")))
    const out = d as { hookSpecificOutput: { additionalContext: string } }
    expect(out.hookSpecificOutput.additionalContext).toContain("secret")
  })
  test("alerts on lockfile modification", async () => {
    const d = await Effect.runPromise(handleFileChanged(fileChange("/repo/pnpm-lock.yaml")))
    const out = d as { hookSpecificOutput: { additionalContext: string } }
    expect(out.hookSpecificOutput.additionalContext).toContain("lockfile")
  })
  test("alerts on manifest modification", async () => {
    const d = await Effect.runPromise(handleFileChanged(fileChange("/repo/package.json")))
    const out = d as { hookSpecificOutput: { additionalContext: string } }
    expect(out.hookSpecificOutput.additionalContext).toContain("manifest")
  })
  test("ignores ordinary source files", async () => {
    const d = await Effect.runPromise(handleFileChanged(fileChange("/repo/src/foo.ts")))
    expect(d).toEqual({})
  })
})
