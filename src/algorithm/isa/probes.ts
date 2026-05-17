/**
 * ISC probe registry — hot-loadable user code that verifies ISCs after
 * tool calls finish. Composes with the model-flipped checkbox path: a
 * probe-flipped `[x]` triggers the same checkpoint commit that a
 * model-flipped one does.
 *
 * Privilege model (honest disclosure):
 * - Probes run in the dispatcher process with FULL Node privileges
 *   (filesystem, network, shell, env vars). There is no sandbox.
 * - Each probe is wrapped in a 1s Effect.timeout and a catch-all that
 *   treats failure as a non-passing probe (same as a returned `false`).
 * - The probe file is `<root>/.claude-hooks/probes.ts` — opt-in. Default
 *   install ships zero probes. Loading respects the same trust boundary
 *   the user implicitly grants any code already in their repo.
 *
 * Activation flow:
 * 1. PostToolUse fires for any tool the model used.
 * 2. The handler locates the active ISA, parses Test Strategy to map
 *    iscId → probe-name, finds matching probes, runs each in isolation.
 * 3. For passing probes whose target ISC is currently `[ ]`, the ISA
 *    is edited in place to flip to `[x]`. That edit fires PostToolUse
 *    again where checkpoint.ts notices the transition and commits.
 *
 * Idempotency: probes only write on a true→passing transition and only
 * when the matching ISC is currently unchecked. Running the same probe
 * set twice with the same world-state is a no-op.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { CriterionEntry } from "./criteria.ts"
import { logWarning, logWarningSync } from "../../services/diagnostics.ts"

/**
 * The shape user-defined probes export. A probe takes the criterion it
 * was matched against and returns a boolean (or a Promise<boolean>).
 * Sync return is fine; we wrap everything in Effect.tryPromise.
 */
export type ProbeFn = (criterion: CriterionEntry) => boolean | Promise<boolean>

/**
 * Object spec form for probes that need a non-default timeout. The default
 * 1s cap is fine for `() => true` and other cheap checks but kills any
 * probe doing real work (e.g. spawning `bun test`). Declare a longer
 * `timeoutMs` to opt out of the default — capped on the user's side, not
 * the dispatcher's.
 *
 *   export const probes = {
 *     "tests-pass": { fn: async () => runTests(), timeoutMs: 8_000 },
 *   }
 */
export interface ProbeSpec {
  readonly fn: ProbeFn
  readonly timeoutMs?: number
}

/**
 * What the user's `probes.ts` may export per key. Bare functions are the
 * common shape; object specs unlock per-probe timeout overrides.
 */
export type Probe = ProbeFn | ProbeSpec

export interface ProbesModule {
  readonly probes: Readonly<Record<string, Probe>>
}

/** Default per-probe timeout — defensive ceiling for hot-loaded user code. */
export const PROBE_TIMEOUT_MS = 1_000

/**
 * Detect the object spec form. A `Probe` is either a function or an object
 * with a `fn` field that is a function. Anything else is treated as
 * malformed and dropped at load time.
 */
const isProbeSpec = (p: unknown): p is ProbeSpec =>
  typeof p === "object" &&
  p !== null &&
  !Array.isArray(p) &&
  typeof (p as { fn?: unknown }).fn === "function"

/**
 * Normalize a Probe into `{fn, timeoutMs}` so call sites don't have to
 * branch on the shape. Bare functions resolve to the default timeout.
 */
export const resolveProbe = (
  p: Probe,
): { readonly fn: ProbeFn; readonly timeoutMs: number } => {
  if (typeof p === "function") return { fn: p, timeoutMs: PROBE_TIMEOUT_MS }
  return { fn: p.fn, timeoutMs: p.timeoutMs ?? PROBE_TIMEOUT_MS }
}

const PROBES_SUBPATH = [".claude-hooks", "probes.ts"] as const

export const probesPathFor = (root: string = process.cwd()): string =>
  join(root, ...PROBES_SUBPATH)

/**
 * Hot-load the user's probes module. Returns an empty registry when:
 * - the file doesn't exist (the common case — opt-in)
 * - the import throws
 * - the module's `probes` export is missing or non-object
 *
 * Fails closed — no probes is the safe default. Errors are warning-logged.
 *
 * Bun caches imports by URL; appending a cache-buster timestamp would let
 * the user iterate without restart, but that contradicts the
 * "deterministic per dispatcher invocation" model the dispatcher uses.
 * Each hook fires a fresh process, so cache-bust is unnecessary.
 */
export const loadProbes = async (
  root: string = process.cwd(),
): Promise<Readonly<Record<string, Probe>>> => {
  const file = probesPathFor(root)
  if (!existsSync(file)) return Object.freeze({})
  try {
    const mod = (await import(file)) as Partial<ProbesModule>
    if (
      typeof mod.probes !== "object" ||
      mod.probes === null ||
      Array.isArray(mod.probes)
    ) {
      logWarningSync(`[probes] ${file} did not export an object literal named 'probes'`)
      return Object.freeze({})
    }
    // Defensive copy + freeze. Accept bare functions (the common shape)
    // and `{fn, timeoutMs}` object specs (for probes that need >default
    // timeout). Anything else is dropped — same fail-closed posture as
    // before.
    const out: Record<string, Probe> = {}
    for (const [name, val] of Object.entries(mod.probes)) {
      if (typeof val === "function") out[name] = val as ProbeFn
      else if (isProbeSpec(val)) out[name] = val
    }
    return Object.freeze(out)
  } catch (err) {
    logWarningSync(`[probes] failed to load ${file}: ${String(err)}`)
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
    catch: (cause) => new Error(String(cause)),
  }).pipe(
    Effect.tapError((cause) =>
      logWarning(`[probes] probe for ${criterion.id} threw: ${String(cause).slice(0, 200)}`),
    ),
    Effect.timeout(`${timeoutMs} millis`),
    Effect.catchAll((cause) => {
      // Timeout OR upstream error → treat as non-passing.
      const reason =
        cause instanceof Error && cause.name === "TimeoutException"
          ? "timed out"
          : "errored"
      return logWarning(
        `[probes] probe for ${criterion.id} ${reason} after ${timeoutMs}ms`,
      ).pipe(Effect.as(false))
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
 * Pure function — no I/O by default. The optional `onMiss` callback is
 * invoked when an ISA declares a probe (`tool` column) that is not present
 * in the registry — a silent skip otherwise, which is a known footgun:
 * a typo in `probes.ts` (e.g. keying by ISC id instead of by tool name)
 * yields zero matches and zero observable signal until a downstream
 * gate fires. Callers can pass a logger to make the miss observable;
 * tests can pass a recorder to assert on the miss.
 */
export interface ProbeMatch {
  readonly criterion: CriterionEntry
  readonly probeName: string
  readonly probe: Probe
}

export interface ProbeMiss {
  readonly iscId: string
  readonly probeName: string
  readonly registeredNames: ReadonlyArray<string>
}

export const matchProbes = (
  criteria: ReadonlyArray<CriterionEntry>,
  testStrategy: ReadonlyMap<string, string>, // iscId → probe name
  registry: Readonly<Record<string, Probe>>,
  onMiss?: (miss: ProbeMiss) => void,
): ReadonlyArray<ProbeMatch> => {
  const matches: ProbeMatch[] = []
  let registeredNames: ReadonlyArray<string> | undefined
  for (const c of criteria) {
    if (c.status !== "pending") continue
    const probeName = testStrategy.get(c.id)
    if (probeName === undefined) continue
    const probe = registry[probeName]
    if (probe === undefined) {
      if (onMiss !== undefined) {
        registeredNames ??= Object.keys(registry)
        onMiss({ iscId: c.id, probeName, registeredNames })
      }
      continue
    }
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
    // Bare ISC id only — anchored on both sides so a cell like
    // `ISC-1: my criterion` doesn't get keyed by the whole description
    // (which would never match parseCriteriaList's clean id keys).
    const idMatch = first.match(/^(ISC-[\w.-]+)$/)
    if (idMatch === null || idMatch[1] === undefined) continue
    if (last.length === 0) continue
    out.set(idMatch[1], last)
  }
  return out
}
