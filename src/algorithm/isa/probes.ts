/**
 * ISC probe registry — hot-loadable user code that verifies ISCs after
 * tool calls finish.
 *
 * NEW DESIGN — no this package parallel. this package's CheckpointPerISC.hook.ts only watches
 * for `[ ]→[x]` transitions written by the model; this module lets users
 * declare programmatic verifications that flip the checkbox automatically
 * when the test passes. The two systems compose: a probe-flipped checkbox
 * triggers the same checkpoint commit that a model-flipped one does.
 *
 * Privilege model (HONEST disclosure):
 * - Probes run in the dispatcher process with FULL Node privileges
 * (filesystem, network, shell, env vars). There is no real sandbox.
 * - Each probe is wrapped in a 1s Effect.timeout and a catch-all that
 * treats failure as a non-passing probe (same as a returned `false`).
 * - The probe file is `<root>/.claude-hooks/probes.ts` — opt-in. Default
 * install ships zero probes. Loading respects the same trust boundary
 * the user implicitly grants any code already in their repo.
 *
 * Activation flow (planned for slice 2c wiring):
 * 1. PostToolUse fires for any tool the model used.
 * 2. The handler locates the active ISA (via locate.ts), parses Test
 * Strategy to map iscId → probe-name, finds probes the user defined
 * that match, runs each in isolation.
 * 3. For passing probes whose target ISC is currently `[ ]`, edits the
 * ISA in place to flip to `[x]`. That ISA edit then fires PostToolUse
 * again, where checkpoint.ts notices the transition and commits.
 *
 * Recursion guard: probes module reads ISA but only WRITES on `passed`
 * transitions and only when the matching ISC is currently unchecked.
 * Idempotent — running the same probe set twice with the same world-
 * state is a no-op.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { CriterionEntry } from "./criteria.ts"

/**
 * The shape user-defined probes export. A probe takes the criterion it
 * was matched against and returns a boolean (or a Promise<boolean>).
 * Sync return is fine; we wrap everything in Effect.tryPromise.
 */
export type ProbeFn = (
 criterion: CriterionEntry,
) => boolean | Promise<boolean>

export interface ProbesModule {
 readonly probes: Readonly<Record<string, ProbeFn>>
}

/** Default per-probe timeout — defensive ceiling for hot-loaded user code. */
export const PROBE_TIMEOUT_MS = 1_000

const PROBES_SUBPATH = [".claude-hooks", "probes.ts"] as const

export const probesPathFor = (root: string = process.cwd()): string =>
 join(root, ...PROBES_SUBPATH)

/**
 * Hot-load the user's probes module. Returns an empty registry when:
 * - the file doesn't exist (the common case — opt-in)
 * - the import throws
 * - the module's `probes` export is missing or non-object
 *
 * Fails closed — no probes is the safe default. Errors logged to stderr.
 *
 * Bun caches imports by URL; appending a cache-buster timestamp would let
 * the user iterate without restart, but that contradicts the
 * "deterministic per dispatcher invocation" model the dispatcher uses.
 * Each hook fires a fresh process, so cache-bust is unnecessary.
 */
export const loadProbes = async (
 root: string = process.cwd(),
): Promise<Readonly<Record<string, ProbeFn>>> => {
 const file = probesPathFor(root)
 if (!existsSync(file)) return Object.freeze({})
 try {
 const mod = (await import(file)) as Partial<ProbesModule>
 if (
 typeof mod.probes !== "object" ||
 mod.probes === null ||
 Array.isArray(mod.probes)
 ) {
 process.stderr.write(
 `[probes] ${file} did not export an object literal named 'probes'\n`,
 )
 return Object.freeze({})
 }
 // Defensive copy + freeze; only keep entries whose value is a function.
 const out: Record<string, ProbeFn> = {}
 for (const [name, fn] of Object.entries(mod.probes)) {
 if (typeof fn === "function") out[name] = fn as ProbeFn
 }
 return Object.freeze(out)
 } catch (err) {
 process.stderr.write(`[probes] failed to load ${file}: ${String(err)}\n`)
 return Object.freeze({})
 }
}

/**
 * Run a single probe with a hard timeout and total error containment.
 * Returns `false` for: probe missing, probe throws, probe times out,
 * or probe returns a non-boolean. Returns the boolean otherwise.
 *
 * The 1s timeout sits well under the dispatcher's 4s default cap, leaving
 * headroom for the rest of the PostToolUse handler (formatter probes,
 * checkpoint git ops).
 */
export const runProbe = (
 probe: ProbeFn,
 criterion: CriterionEntry,
 timeoutMs: number = PROBE_TIMEOUT_MS,
): Effect.Effect<boolean> =>
 Effect.tryPromise({
 try: async () => {
 const result = await Promise.resolve(probe(criterion))
 return result === true
 },
 catch: (cause) => {
 process.stderr.write(
 `[probes] probe for ${criterion.id} threw: ${String(cause).slice(0, 200)}\n`,
 )
 return new Error(String(cause))
 },
 }).pipe(
 Effect.timeout(`${timeoutMs} millis`),
 Effect.catchAll((cause) => {
 // Timeout OR upstream error → treat as non-passing.
 const reason =
 cause instanceof Error && cause.name === "TimeoutException"
 ? "timed out"
 : "errored"
 process.stderr.write(
 `[probes] probe for ${criterion.id} ${reason} after ${timeoutMs}ms\n`,
 )
 return Effect.succeed(false)
 }),
 )

/**
 * Given the parsed Test Strategy table from an ISA and a probe registry,
 * return the list of (criterion, probeFn) pairs to actually invoke. The
 * Test Strategy section format (per IsaFormat.md line 183) is:
 * `isc | type | check | threshold | tool`
 * The `tool` column names the probe. Only criteria currently `[ ]`
 * (status === 'pending') match — completed ones are skipped (idempotent).
 *
 * Pure function — no I/O, easy to test.
 */
export interface ProbeMatch {
 readonly criterion: CriterionEntry
 readonly probeName: string
 readonly probe: ProbeFn
}

export const matchProbes = (
 criteria: ReadonlyArray<CriterionEntry>,
 testStrategy: ReadonlyMap<string, string>, // iscId → probe name
 registry: Readonly<Record<string, ProbeFn>>,
): ReadonlyArray<ProbeMatch> => {
 const matches: ProbeMatch[] = []
 for (const c of criteria) {
 if (c.status !== "pending") continue
 const probeName = testStrategy.get(c.id)
 if (probeName === undefined) continue
 const probe = registry[probeName]
 if (probe === undefined) continue
 matches.push({ criterion: c, probeName, probe })
 }
 return matches
}

/**
 * Parse the Test Strategy section body into a `iscId → probeName` map.
 * The body is a markdown pipe table; we tolerate header rows and
 * separator rows (`---|---|...`). A row contributes when:
 * - first cell starts with `ISC-` (after stripping leading/trailing whitespace)
 * - last cell is a non-empty token (the probe name)
 *
 * Rows missing either side are silently skipped (best-effort).
 */
export const parseTestStrategy = (
 body: string,
): ReadonlyMap<string, string> => {
 const out = new Map<string, string>()
 for (const rawLine of body.split("\n")) {
 const line = rawLine.trim()
 if (line.length === 0) continue
 if (!line.startsWith("|")) continue
 if (/^\|\s*[-:]+\s*\|/.test(line)) continue // separator row
 const cells = line
 .split("|")
 .slice(1, -1) // drop leading/trailing empty from outer pipes
 .map((c) => c.trim())
 if (cells.length < 2) continue
 const first = cells[0]
 const last = cells[cells.length - 1]
 if (first === undefined || last === undefined) continue
 if (!/^ISC-[\w.-]+/.test(first)) continue
 if (last.length === 0) continue
 out.set(first, last)
 }
 return out
}
