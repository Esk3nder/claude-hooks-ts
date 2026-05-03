import { describe, expect, test } from "bun:test"
import { Either } from "effect"
import {
  makeAbsolutePath,
  makeShellCommand,
  makeRedactedString,
  RedactedString,
} from "../../src/schema/branded.ts"
import { BrandValidationError } from "../../src/schema/errors.ts"

describe("AbsolutePath", () => {
  test("accepts a normalized absolute path", () => {
    const r = makeAbsolutePath("/tmp/foo/bar")
    expect(Either.isRight(r)).toBe(true)
  })
  test("rejects relative paths", () => {
    const r = makeAbsolutePath("foo/bar")
    expect(Either.isLeft(r)).toBe(true)
    if (Either.isLeft(r)) expect(r.left).toBeInstanceOf(BrandValidationError)
  })
  test("rejects '..' segments after normalization", () => {
    const r = makeAbsolutePath("/tmp/foo/../../etc/passwd")
    expect(Either.isLeft(r)).toBe(true)
  })
  test("rejects empty string", () => {
    const r = makeAbsolutePath("")
    expect(Either.isLeft(r)).toBe(true)
  })
})

describe("ShellCommand", () => {
  test("builds with posix single-quote escaping", () => {
    const r = makeShellCommand("echo", ["hi", "it's me"])
    expect(Either.isRight(r)).toBe(true)
    if (Either.isRight(r)) {
      expect(r.right as unknown as string).toBe("echo 'hi' 'it'\\''s me'")
    }
  })
  test("rejects cmd containing whitespace", () => {
    const r = makeShellCommand("ls -la", [])
    expect(Either.isLeft(r)).toBe(true)
    if (Either.isLeft(r)) expect(r.left).toBeInstanceOf(BrandValidationError)
  })
  test("rejects empty cmd", () => {
    const r = makeShellCommand("", ["x"])
    expect(Either.isLeft(r)).toBe(true)
  })
})

describe("RedactedString", () => {
  test("toString returns [REDACTED]", () => {
    const r = makeRedactedString("super-secret")
    expect(Either.isRight(r)).toBe(true)
    if (Either.isRight(r)) {
      expect(r.right.toString()).toBe("[REDACTED]")
      expect(JSON.stringify({ x: r.right })).toBe('{"x":"[REDACTED]"}')
      expect(r.right.reveal()).toBe("super-secret")
      expect(r.right).toBeInstanceOf(RedactedString)
    }
  })
})
