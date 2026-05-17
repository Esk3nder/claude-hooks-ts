import { describe, expect, test } from "bun:test"
import {
  isSuccessfulToolResponse,
  isUsableSourceToolResponse,
  isVerificationCommand,
  urlsFromToolInput,
  urlsFromToolResponse,
} from "../../src/policies/tool-evidence.ts"

describe("tool evidence helpers", () => {
  test("verification commands require a real command boundary", () => {
    expect(isVerificationCommand("bun test")).toBe(true)
    expect(isVerificationCommand("npm run typecheck")).toBe(true)
    expect(isVerificationCommand("rg latest src")).toBe(false)
    expect(isVerificationCommand("echo bun test")).toBe(false)
  })

  test("tool response success recognizes Claude-style failure markers", () => {
    expect(isSuccessfulToolResponse(undefined)).toBe(true)
    expect(isSuccessfulToolResponse(null)).toBe(true)
    expect(isSuccessfulToolResponse({ success: true })).toBe(true)
    expect(isSuccessfulToolResponse({ is_error: true })).toBe(false)
    expect(isSuccessfulToolResponse({ isError: true })).toBe(false)
    expect(isSuccessfulToolResponse({ interrupted: true })).toBe(false)
    expect(isSuccessfulToolResponse({ timedOut: true })).toBe(false)
    expect(isSuccessfulToolResponse({ timed_out: true })).toBe(false)
    expect(isSuccessfulToolResponse({ status: 403 })).toBe(false)
    expect(isSuccessfulToolResponse({ statusCode: 404 })).toBe(false)
    expect(isSuccessfulToolResponse({ status_code: 500 })).toBe(false)
    expect(isSuccessfulToolResponse({ status: "503 Service Unavailable" })).toBe(false)
  })

  test("source responses must contain usable content, not just metadata", () => {
    expect(isUsableSourceToolResponse("Fetched source body")).toBe(true)
    expect(isUsableSourceToolResponse({ content: "Fetched source body" })).toBe(true)
    expect(isUsableSourceToolResponse("")).toBe(false)
    expect(isUsableSourceToolResponse({})).toBe(false)
    expect(isUsableSourceToolResponse({ success: true })).toBe(false)
    expect(isUsableSourceToolResponse({ success: true, stdout: "" })).toBe(false)
  })

  test("source responses reject dead fetch and tool failure output", () => {
    expect(isUsableSourceToolResponse("Received 0 bytes (404 Not Found)")).toBe(false)
    expect(isUsableSourceToolResponse({ success: false, error: "403 Forbidden" })).toBe(false)
    expect(isUsableSourceToolResponse({ statusCode: 403, url: "https://example.com" })).toBe(false)
  })

  test("source URL extraction trims prose punctuation", () => {
    expect(urlsFromToolInput({ url: "https://example.com/report." })).toEqual([
      "https://example.com/report",
    ])
    expect(urlsFromToolResponse("Source: https://example.com/report].")).toEqual([
      "https://example.com/report",
    ])
  })

  test("source URL extraction does not count search-query URLs as evidence", () => {
    expect(
      urlsFromToolInput({ query: "Read https://example.com/a, then summarize it." }),
    ).toEqual([])
  })
})
