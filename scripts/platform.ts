/**
 * Platform name + binary-name mapping for build.ts and install.ts.
 *
 * Bun's compile target strings use `windows` (not `win32`) for Windows.
 * Node's `process.platform` returns `win32`. Without this translation,
 * `bun build --compile --target=bun-win32-x64` crashes with "unknown
 * target" — P0-2's primary install failure on Windows. Extracted as a
 * pure helper so both build.ts (emits the binary) and install.ts
 * (probes for the binary) stay in sync — when one is changed, the
 * other is automatically right.
 */

export type SupportedPlatform = "linux" | "darwin" | "windows"
export type SupportedArch = "x64" | "arm64"

/**
 * Map `process.platform` to the Bun-compile-target platform name. Falls
 * through to the input string for unknown platforms so error messages
 * mention what the runtime actually saw.
 */
export const normalizePlatform = (platform: string): string => {
  if (platform === "linux") return "linux"
  if (platform === "darwin") return "darwin"
  if (platform === "win32") return "windows"
  return platform
}

/**
 * Map `process.arch` to Bun-compile-target arch. x64 / arm64 are the
 * only ones Bun publishes prebuilt runtimes for; falls through for
 * unknown so error messages name the actual arch.
 */
export const normalizeArch = (arch: string): string => {
  if (arch === "x64") return "x64"
  if (arch === "arm64") return "arm64"
  return arch
}

/** Full Bun compile target string: e.g., `bun-windows-x64`, `bun-darwin-arm64`. */
export const bunCompileTarget = (platform: string, arch: string): string =>
  `bun-${normalizePlatform(platform)}-${normalizeArch(arch)}`

/**
 * Filename of the compiled dispatcher binary inside `<installRoot>/dist/`.
 * Includes `.exe` on Windows so install.ts probes the correct path.
 */
export const dispatcherBinaryName = (platform: string, arch: string): string => {
  const base = `claude-hook-${normalizePlatform(platform)}-${normalizeArch(arch)}`
  return normalizePlatform(platform) === "windows" ? `${base}.exe` : base
}
