#!/usr/bin/env bun
/**
 * US-22 — Regenerate `docs/CLASSIFIER_CONTRACT.json` from the live
 * `src/algorithm/classifier.ts` module.
 *
 * Modes:
 *   bun run scripts/generate-classifier-contract.ts          → write to disk
 *   bun run scripts/generate-classifier-contract.ts --check  → compare,
 *     exit non-zero if disk differs from regenerated. This is what CI runs.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  buildClassifierContract,
  serializeContract,
} from "../src/algorithm/classifier-contract.ts"

const ARTIFACT_PATH = resolve(
  import.meta.dir,
  "..",
  "docs",
  "CLASSIFIER_CONTRACT.json",
)

const fresh = serializeContract(buildClassifierContract())
const checkMode = process.argv.includes("--check")

if (checkMode) {
  let onDisk: string
  try {
    onDisk = readFileSync(ARTIFACT_PATH, "utf8")
  } catch {
    console.error(
      `contract:check FAILED — ${ARTIFACT_PATH} does not exist. Run \`bun run contract:generate\`.`,
    )
    process.exit(1)
  }
  if (onDisk !== fresh) {
    console.error(
      "contract:check FAILED — docs/CLASSIFIER_CONTRACT.json is stale.\n" +
        "Run `bun run contract:generate` and commit the result.",
    )
    process.exit(1)
  }
  console.log("contract:check OK")
  process.exit(0)
}

writeFileSync(ARTIFACT_PATH, fresh)
console.log(`wrote ${ARTIFACT_PATH}`)
