import { describe, expect, test } from "bun:test"
import { evaluateSettingsSelfProtection } from "../../src/policies/settings-self-protection.ts"

describe("evaluateSettingsSelfProtection", () => {
  const asks = [
    "/Users/x/.claude/settings.json",
    "/Users/x/.claude/settings.local.json",
    "/repo/.claude/settings.json",
    "/repo/.claude/hooks/foo.mjs",
    "/repo/.claude/agents/worker.md",
    "/repo/.claude/policies/deny.yaml",
    "/repo/.claude-hooks/foo.ts",
  ]
  for (const p of asks) {
    test(`ask: ${p}`, () => {
      expect(evaluateSettingsSelfProtection(p).kind).toBe("ask")
    })
  }
  test("passthrough: src/foo.ts", () => {
    expect(evaluateSettingsSelfProtection("/repo/src/foo.ts").kind).toBe("passthrough")
  })
})
