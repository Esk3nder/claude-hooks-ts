import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"

export interface ProjectApi {
  readonly root: () => Effect.Effect<string>
  readonly typecheckCommand: () => Effect.Effect<string | null>
  readonly lintCommand: () => Effect.Effect<string | null>
  readonly testCommand: (
    scope: "targeted" | "full",
  ) => Effect.Effect<string | null>
}

export class Project extends Context.Tag("Project")<Project, ProjectApi>() {}

const findRoot = (start: string): string => {
  let dir = start
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

const readPkg = (root: string): { scripts?: Record<string, string> } => {
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8")
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

const pickScript = (
  scripts: Record<string, string> | undefined,
  candidates: string[],
): string | null => {
  if (!scripts) return null
  for (const name of candidates) {
    if (scripts[name]) {
      return `npm run ${name}`
    }
  }
  return null
}

const pickScriptWithRunner = (
  root: string,
  scripts: Record<string, string> | undefined,
  candidates: string[],
): string | null => {
  if (!scripts) return null
  const useBun = fs.existsSync(path.join(root, "bun.lock")) ||
    fs.existsSync(path.join(root, "bun.lockb"))
  for (const name of candidates) {
    if (scripts[name]) {
      return useBun ? `bun run ${name}` : `npm run ${name}`
    }
  }
  return null
}

/**
 * Live Project layer with `Effect.cached` on each hot read.
 *
 * Each command query (typecheck/lint/test) reads the project's package.json
 * from disk; on a long-running dispatcher process, that's O(N hooks) of
 * redundant disk traffic. We cache for the lifetime of the layer.
 *
 * Note: `testCommand` takes a scope param, so we cache per-scope.
 */
const makeLive = Effect.gen(function* () {
  // Compute the project root and read package.json exactly once per layer
  // instantiation. Previously each cached command Effect re-ran findRoot +
  // readPkg on first execution; though Effect.cached prevented repeated runs
  // per command, root resolution still happened up to 5x.
  const root = findRoot(process.cwd())
  const pkg = readPkg(root)

  const rawRoot = Effect.sync(() => root)
  const cachedRoot = yield* Effect.cached(rawRoot)

  const rawTypecheck = Effect.sync(() =>
    pickScriptWithRunner(root, pkg.scripts, ["typecheck", "tsc"]),
  )
  const cachedTypecheck = yield* Effect.cached(rawTypecheck)

  const rawLint = Effect.sync(() =>
    pickScriptWithRunner(root, pkg.scripts, ["lint"]),
  )
  const cachedLint = yield* Effect.cached(rawLint)

  const rawTestTargeted = Effect.sync(() =>
    pickScriptWithRunner(root, pkg.scripts, [
      "test:changed",
      "test:unit",
      "test",
    ]),
  )
  const cachedTestTargeted = yield* Effect.cached(rawTestTargeted)

  const rawTestFull = Effect.sync(() =>
    pickScriptWithRunner(root, pkg.scripts, ["test"]),
  )
  const cachedTestFull = yield* Effect.cached(rawTestFull)

  return Project.of({
    root: () => cachedRoot,
    typecheckCommand: () => cachedTypecheck,
    lintCommand: () => cachedLint,
    testCommand: (scope) =>
      scope === "targeted" ? cachedTestTargeted : cachedTestFull,
  })
})

export const ProjectLive = Layer.effect(Project, makeLive)

// Silence unused warning from older variant
void pickScript

export const ProjectTest = (overrides: {
  root?: string
  typecheck?: string | null
  lint?: string | null
  test?: { targeted?: string | null; full?: string | null }
} = {}): Layer.Layer<Project> =>
  Layer.succeed(
    Project,
    Project.of({
      root: () => Effect.succeed(overrides.root ?? "/tmp/test-project"),
      typecheckCommand: () => Effect.succeed(overrides.typecheck ?? null),
      lintCommand: () => Effect.succeed(overrides.lint ?? null),
      testCommand: (scope) =>
        Effect.succeed(
          (scope === "targeted"
            ? overrides.test?.targeted
            : overrides.test?.full) ?? null,
        ),
    }),
  )

/**
 * Test helper: build a Live-style Project from caller-supplied loaders so
 * tests can confirm the underlying read happens once across many calls.
 */
export const ProjectCachedFromLoaders = (loaders: {
  root: Effect.Effect<string>
  typecheck: Effect.Effect<string | null>
  lint: Effect.Effect<string | null>
  testTargeted: Effect.Effect<string | null>
  testFull: Effect.Effect<string | null>
}): Layer.Layer<Project> =>
  Layer.effect(
    Project,
    Effect.gen(function* () {
      const cRoot = yield* Effect.cached(loaders.root)
      const cTc = yield* Effect.cached(loaders.typecheck)
      const cLint = yield* Effect.cached(loaders.lint)
      const cTt = yield* Effect.cached(loaders.testTargeted)
      const cTf = yield* Effect.cached(loaders.testFull)
      return Project.of({
        root: () => cRoot,
        typecheckCommand: () => cTc,
        lintCommand: () => cLint,
        testCommand: (scope) => (scope === "targeted" ? cTt : cTf),
      })
    }),
  )
