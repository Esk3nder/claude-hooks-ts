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
      // Detect bun via bunfig/bun.lock; fall back to npm
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

export const ProjectLive = Layer.succeed(
  Project,
  Project.of({
    root: () => Effect.sync(() => findRoot(process.cwd())),
    typecheckCommand: () =>
      Effect.sync(() => {
        const root = findRoot(process.cwd())
        const pkg = readPkg(root)
        return pickScriptWithRunner(root, pkg.scripts, ["typecheck", "tsc"])
      }),
    lintCommand: () =>
      Effect.sync(() => {
        const root = findRoot(process.cwd())
        const pkg = readPkg(root)
        return pickScriptWithRunner(root, pkg.scripts, ["lint"])
      }),
    testCommand: (scope) =>
      Effect.sync(() => {
        const root = findRoot(process.cwd())
        const pkg = readPkg(root)
        const candidates =
          scope === "targeted" ? ["test:changed", "test:unit", "test"] : ["test"]
        return pickScriptWithRunner(root, pkg.scripts, candidates)
      }),
  }),
)
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
