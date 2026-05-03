import { describe, expect, test } from "bun:test"
import { evaluateLockfile } from "../../src/policies/lockfile-paths.ts"

describe("evaluateLockfile", () => {
  const asks = [
    "/repo/package-lock.json",
    "/repo/pnpm-lock.yaml",
    "/repo/yarn.lock",
    "/repo/bun.lockb",
    "/repo/Cargo.lock",
    "/repo/uv.lock",
    "/repo/poetry.lock",
    "/repo/go.sum",
    "/repo/composer.lock",
    "/repo/Gemfile.lock",
  ]
  for (const p of asks) {
    test(`ask: ${p}`, () => {
      expect(evaluateLockfile(p).kind).toBe("ask")
    })
  }
  test("passthrough: package.json", () => {
    expect(evaluateLockfile("/repo/package.json").kind).toBe("passthrough")
  })
})
