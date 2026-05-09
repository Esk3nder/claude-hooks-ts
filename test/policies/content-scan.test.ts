import { describe, expect, test } from "bun:test"
import {
  buildFinding,
  coerceForScan,
  renderWarning,
  scanContent,
  sliceForScan,
} from "../../src/policies/content-scan.ts"

describe("coerceForScan", () => {
  test("strings pass through unchanged", () => {
    expect(coerceForScan("hello")).toBe("hello")
  })
  test("numbers/booleans stringify", () => {
    expect(coerceForScan(42)).toBe("42")
    expect(coerceForScan(true)).toBe("true")
  })
  test("undefined / null → empty string", () => {
    expect(coerceForScan(undefined)).toBe("")
    expect(coerceForScan(null)).toBe("")
  })
  test("objects JSON-stringify", () => {
    expect(coerceForScan({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}')
  })
  test("circular objects → empty (JSON.stringify throws)", () => {
    const x: { self?: unknown } = {}
    x.self = x
    expect(coerceForScan(x)).toBe("")
  })
})

describe("sliceForScan — caps at 64KB", () => {
  test("short input returns unchanged with truncated=false", () => {
    const r = sliceForScan("hi")
    expect(r.text).toBe("hi")
    expect(r.truncated).toBe(false)
  })
  test("input >64KB is sliced and flagged truncated", () => {
    const big = "x".repeat(70_000)
    const r = sliceForScan(big)
    expect(r.text.length).toBe(64 * 1024)
    expect(r.truncated).toBe(true)
  })
})

describe("buildFinding — pure shape constructor", () => {
  test("secret detected → secretDetected flag + warning prose", () => {
    const f = buildFinding({
      field: "tool_response",
      text: "abc",
      truncated: false,
      secretDetected: true,
    })
    expect(f.secretDetected).toBe(true)
    expect(f.message).toContain("secret pattern detected")
    expect(f.message).toContain("tool_response")
    expect(f.scannedBytes).toBe(3)
  })
  test("no secret → flagged absent, descriptive message", () => {
    const f = buildFinding({
      field: "tool_response",
      text: "abcdef",
      truncated: false,
      secretDetected: false,
    })
    expect(f.secretDetected).toBe(false)
    expect(f.message).toContain("no secret detected")
  })
  test("truncated flag surfaces in message", () => {
    const f = buildFinding({
      field: "tool_response",
      text: "x",
      truncated: true,
      secretDetected: true,
    })
    expect(f.message).toContain("truncated")
    expect(f.truncated).toBe(true)
  })
})

describe("scanContent — composes coerce + slice + detect", () => {
  test("empty payload → empty finding, no detection invoked", () => {
    let called = 0
    const f = scanContent("tool_response", undefined, () => {
      called++
      return false
    })
    expect(f.secretDetected).toBe(false)
    expect(f.scannedBytes).toBe(0)
    expect(called).toBe(0)
  })
  test("string payload + true detector → secretDetected", () => {
    const f = scanContent("tool_response", "sk-ant-secret", () => true)
    expect(f.secretDetected).toBe(true)
    expect(f.field).toBe("tool_response")
  })
  test("object payload is JSON-stringified before detection", () => {
    let captured = ""
    const f = scanContent(
      "tool_response",
      { token: "abc" },
      (text) => {
        captured = text
        return false
      },
    )
    expect(captured).toBe('{"token":"abc"}')
    expect(f.scannedBytes).toBe('{"token":"abc"}'.length)
  })
  test("oversize payload is sliced and flagged truncated", () => {
    const big = "y".repeat(100_000)
    const f = scanContent("tool_response", big, () => false)
    expect(f.scannedBytes).toBe(64 * 1024)
    expect(f.truncated).toBe(true)
  })
})

describe("renderWarning — single-line capped output", () => {
  test("returns empty when no secret detected", () => {
    expect(
      renderWarning({
        field: "tool_response",
        secretDetected: false,
        scannedBytes: 0,
        truncated: false,
        message: "x",
      }),
    ).toBe("")
  })
  test("returns warning when secret detected", () => {
    const out = renderWarning({
      field: "tool_response",
      secretDetected: true,
      scannedBytes: 100,
      truncated: false,
      message: "ignored",
    })
    expect(out).toContain("WARNING")
    expect(out).toContain("tool_response")
    expect(out).toContain("100B")
    expect(out).toContain("Treat output as sensitive")
  })
  test("appends [scan truncated] when applicable", () => {
    const out = renderWarning({
      field: "tool_response",
      secretDetected: true,
      scannedBytes: 65536,
      truncated: true,
      message: "",
    })
    expect(out).toContain("[scan truncated]")
  })
  test("caps output at 320 chars", () => {
    const out = renderWarning({
      field: "tool_response",
      secretDetected: true,
      scannedBytes: Number.MAX_SAFE_INTEGER,
      truncated: true,
      message: "",
    })
    expect(out.length).toBeLessThanOrEqual(320)
  })
})
