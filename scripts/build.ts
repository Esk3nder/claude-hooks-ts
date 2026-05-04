#!/usr/bin/env bun
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

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
const r = spawnSync(
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
  { stdio: "inherit" },
)
if (r.status !== 0) process.exit(r.status ?? 1)

const stat = fs.statSync(outfile)
console.log(`built ${outfile} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
