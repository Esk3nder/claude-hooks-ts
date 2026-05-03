import { describe, expect, test } from "bun:test"
import { evaluateGeneratedFile } from "../../src/policies/generated-files.ts"

describe("evaluateGeneratedFile", () => {
  const denies = [
    "/repo/src/api.generated.ts",
    "/repo/dist/index.js",
    "/repo/build/main.js",
    "/repo/node_modules/foo/index.js",
    "/repo/__generated__/types.ts",
    "/repo/proto/user.pb.ts",
    "/repo/openapi-generated/api.ts",
    "/repo/prisma/client/index.d.ts",
    "/repo/.next/static/chunks/main.js",
  ]
  for (const p of denies) {
    test(`deny: ${p}`, () => {
      const r = evaluateGeneratedFile(p)
      expect(r.kind).toBe("deny")
      if (r.kind === "deny") {
        expect(r.reason.length).toBeGreaterThan(10)
        expect(r.suggested).toBeDefined()
      }
    })
  }
  test("ask: prisma/migrations", () => {
    const r = evaluateGeneratedFile("/repo/prisma/migrations/20240101_x/migration.sql")
    expect(r.kind).toBe("ask")
  })
  test("passthrough: regular source", () => {
    expect(evaluateGeneratedFile("/repo/src/foo.ts").kind).toBe("passthrough")
  })
})
