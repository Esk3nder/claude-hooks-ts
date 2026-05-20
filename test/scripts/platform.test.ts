/**
 * P0-2 — Platform mapping helper.
 *
 * Pins the Bun-compile-target translation so build.ts and install.ts
 * stay in sync on Windows. Without this, `process.platform === "win32"`
 * would emit `bun-win32-x64` (which Bun rejects as "unknown target")
 * and install would probe for a binary that's never built.
 */

import { describe, expect, test } from "bun:test"
import {
  bunCompileTarget,
  dispatcherBinaryName,
  normalizeArch,
  normalizePlatform,
} from "../../scripts/platform.ts"

describe("normalizePlatform (P0-2)", () => {
  test("linux passes through", () => {
    expect(normalizePlatform("linux")).toBe("linux")
  })
  test("darwin passes through", () => {
    expect(normalizePlatform("darwin")).toBe("darwin")
  })
  test("win32 maps to windows (Bun compile target)", () => {
    expect(normalizePlatform("win32")).toBe("windows")
  })
  test("unknown platforms fall through unchanged", () => {
    expect(normalizePlatform("freebsd")).toBe("freebsd")
  })
})

describe("normalizeArch (P0-2)", () => {
  test.each<[string, string]>([
    ["x64", "x64"],
    ["arm64", "arm64"],
    ["ia32", "ia32"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeArch(input)).toBe(expected)
  })
})

describe("bunCompileTarget (P0-2)", () => {
  test.each<[string, string, string]>([
    ["linux", "x64", "bun-linux-x64"],
    ["linux", "arm64", "bun-linux-arm64"],
    ["darwin", "x64", "bun-darwin-x64"],
    ["darwin", "arm64", "bun-darwin-arm64"],
    ["win32", "x64", "bun-windows-x64"],
    ["win32", "arm64", "bun-windows-arm64"],
  ])("%s + %s → %s", (platform, arch, expected) => {
    expect(bunCompileTarget(platform, arch)).toBe(expected)
  })
})

describe("dispatcherBinaryName (P0-2)", () => {
  test("linux: no .exe suffix", () => {
    expect(dispatcherBinaryName("linux", "x64")).toBe("claude-hook-linux-x64")
  })
  test("darwin: no .exe suffix", () => {
    expect(dispatcherBinaryName("darwin", "arm64")).toBe(
      "claude-hook-darwin-arm64",
    )
  })
  test("win32: .exe suffix appended AND platform renamed", () => {
    expect(dispatcherBinaryName("win32", "x64")).toBe(
      "claude-hook-windows-x64.exe",
    )
  })
  test("win32 arm64", () => {
    expect(dispatcherBinaryName("win32", "arm64")).toBe(
      "claude-hook-windows-arm64.exe",
    )
  })
})
