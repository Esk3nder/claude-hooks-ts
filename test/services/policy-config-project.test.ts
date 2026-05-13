import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import {
  DEFAULT_POLICY,
  PolicyConfig,
  PolicyConfigLiveFor,
  loadPolicyConfig,
} from "../../src/services/policy-config.ts"

const withTempProject = (fn: (root: string) => void | Promise<void>) => async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chts-policy-"))
  try {
    fs.mkdirSync(path.join(root, ".claude-hooks"), { recursive: true })
    await fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("PolicyConfig typed project config", () => {
  test("loads defaults plus project yaml through typed service", withTempProject(async (root) => {
    fs.writeFileSync(
      path.join(root, ".claude-hooks", "policy.yaml"),
      [
        "destructiveCommandPatterns:",
        "  - custom-danger",
        "secretPathGlobs:",
        "  - '**/custom.secret'",
        "generatedFilePatterns:",
        "  - '(^|/)vendor-generated/'",
        "secretValuePatterns:",
        "  - 'tok_[A-Za-z0-9]{8,}'",
        "elicitationDenylist:",
        "  - risky-server",
        "",
      ].join("\n"),
      "utf8",
    )

    const direct = loadPolicyConfig(root)
    expect(direct.secretPathGlobs).toContain("**/custom.secret")
    expect(direct.secretPathGlobs).toContain(DEFAULT_POLICY.secretPathGlobs[0]!)
    expect(direct.destructiveCommandPatterns.some((r) => r.test("custom-danger"))).toBe(true)

    const viaService = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* PolicyConfig
        return yield* service.load()
      }).pipe(Effect.provide(PolicyConfigLiveFor(root))),
    )

    expect(viaService.generatedFilePatterns.some((r) => r.test("vendor-generated/out.js"))).toBe(true)
    expect(viaService.secretValuePatterns.some((r) => r.test("tok_abcdefghi"))).toBe(true)
    expect(viaService.elicitationDenylist).toContain("risky-server")
  }))
})
