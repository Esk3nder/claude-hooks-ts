#!/usr/bin/env bun
import * as fs from "node:fs"
import * as path from "node:path"
import { runCommandLive } from "../src/services/command-runner.ts"
import { writeCliStderr, writeCliStdout } from "./io.ts"

const platform =
  process.platform === "darwin"
    ? "darwin"
    : process.platform === "linux"
      ? "linux"
      : process.platform
const arch =
  process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch
const target = `bun-${platform}-${arch}`
const outfile = path.join("dist", `claude-hook-${platform}-${arch}`)

fs.mkdirSync("dist", { recursive: true })
const result = await runCommandLive(
  "bun",
  [
    "build",
    "--compile",
    "--minify",
    "--sourcemap",
    `--target=${target}`,
    "src/dispatcher.ts",
    `--outfile=${outfile}`,
  ],
  { timeoutMs: 120_000 },
)
if (result.stdout.length > 0) writeCliStdout(result.stdout)
if (result.stderr.length > 0) writeCliStderr(result.stderr)
if (result.exitCode !== 0 || result.timedOut) {
  process.exit(result.exitCode > 0 ? result.exitCode : 1)
}

const stat = fs.statSync(outfile)
writeCliStdout(`built ${outfile} (${(stat.size / 1024 / 1024).toFixed(1)} MB)\n`)
