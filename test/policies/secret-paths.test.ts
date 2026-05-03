import { describe, expect, test } from "bun:test"
import { evaluateSecretPath } from "../../src/policies/secret-paths.ts"

describe("evaluateSecretPath", () => {
  const denies = [
    "/Users/x/proj/.env",
    "/repo/.env.production",
    "/repo/secrets/api.pem",
    "/home/u/.ssh/id_rsa",
    "/home/u/.ssh/id_ed25519",
    "/etc/credentials",
    "/Users/x/.aws/credentials",
    "/Users/x/.kube/config",
    "/Users/x/.config/gcloud/application_default_credentials.json",
  ]
  for (const p of denies) {
    test(`deny: ${p}`, () => {
      expect(evaluateSecretPath(p).kind).toBe("deny")
    })
  }

  const passes = [
    "/repo/.env.example",
    "/repo/.env.sample",
    "/repo/src/index.ts",
    "/repo/README.md",
    "/repo/test/foo.test.ts",
  ]
  for (const p of passes) {
    test(`passthrough: ${p}`, () => {
      expect(evaluateSecretPath(p).kind).toBe("passthrough")
    })
  }
})
