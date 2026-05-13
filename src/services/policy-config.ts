import * as fs from "node:fs"
import * as path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { parse as parseYaml } from "yaml"
import { logWarningSync } from "./diagnostics.ts"

export interface PolicyConfigData {
  readonly destructiveCommandPatterns: ReadonlyArray<RegExp>
  readonly secretPathGlobs: ReadonlyArray<string>
  readonly generatedFilePatterns: ReadonlyArray<RegExp>
  readonly secretValuePatterns: ReadonlyArray<RegExp>
  /** MCP server names auto-declined for elicitation requests. */
  readonly elicitationDenylist: ReadonlyArray<string>
}

export interface PolicyConfigApi {
  readonly load: () => Effect.Effect<PolicyConfigData>
}

export class PolicyConfig extends Context.Tag("PolicyConfig")<
  PolicyConfig,
  PolicyConfigApi
>() {}

export const DEFAULT_POLICY: PolicyConfigData = {
  destructiveCommandPatterns: [
    /\brm\s+-rf?\b/,
    /\brm\s+--recursive\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\s+-fd?x?\b/,
    /\bgit\s+push\s+(?:.*\s)?--force\b/,
    /\bgit\s+push\s+(?:.*\s)?-f\b/,
    /\bdd\s+if=/,
    /\bmkfs(\.[a-z0-9]+)?\b/,
    /:\(\)\s*\{\s*:\|:&\s*\};:/,
    /\bsudo\s+rm\b/,
    /\bchmod\s+-R\s+777\b/,
    /\bshutdown\b/,
    /\breboot\b/,
  ],
  secretPathGlobs: [
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/id_rsa",
    "**/id_ed25519",
    "**/credentials",
    "**/credentials.json",
    "**/.aws/credentials",
    "**/.npmrc",
    "**/.netrc",
  ],
  generatedFilePatterns: [
    /(^|\/)node_modules\//,
    /(^|\/)dist\//,
    /(^|\/)build\//,
    /(^|\/)\.next\//,
    /(^|\/)\.turbo\//,
    /(^|\/)coverage\//,
    /(^|\/)target\//,
    /(^|\/)__pycache__\//,
    /\.lockb?$/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)pnpm-lock\.yaml$/,
  ],
  secretValuePatterns: [
    /sk-[A-Za-z0-9]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /ghp_[A-Za-z0-9]{30,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ],
  elicitationDenylist: [],
}

const ProjectPolicyConfigSchema = Schema.Struct({
  destructiveCommandPatterns: Schema.optional(Schema.Array(Schema.String)),
  secretPathGlobs: Schema.optional(Schema.Array(Schema.String)),
  generatedFilePatterns: Schema.optional(Schema.Array(Schema.String)),
  secretValuePatterns: Schema.optional(Schema.Array(Schema.String)),
  elicitationDenylist: Schema.optional(Schema.Array(Schema.String)),
})

type ProjectPolicyConfig = Schema.Schema.Type<typeof ProjectPolicyConfigSchema>

const PROJECT_CONFIG_BASENAMES = ["policy.json", "policy.yaml", "policy.yml"] as const

const compilePatterns = (patterns: ReadonlyArray<string>): ReadonlyArray<RegExp> =>
  patterns.flatMap((pattern) => {
    try {
      return [new RegExp(pattern)]
    } catch {
      logWarningSync(`policy-config: ignored invalid regexp ${JSON.stringify(pattern)}`)
      return []
    }
  })

const mergeProjectPolicy = (
  base: PolicyConfigData,
  project: ProjectPolicyConfig,
): PolicyConfigData => ({
  destructiveCommandPatterns: [
    ...base.destructiveCommandPatterns,
    ...compilePatterns(project.destructiveCommandPatterns ?? []),
  ],
  secretPathGlobs: [
    ...base.secretPathGlobs,
    ...(project.secretPathGlobs ?? []),
  ],
  generatedFilePatterns: [
    ...base.generatedFilePatterns,
    ...compilePatterns(project.generatedFilePatterns ?? []),
  ],
  secretValuePatterns: [
    ...base.secretValuePatterns,
    ...compilePatterns(project.secretValuePatterns ?? []),
  ],
  elicitationDenylist: [
    ...base.elicitationDenylist,
    ...(project.elicitationDenylist ?? []),
  ],
})

const parseProjectConfig = (file: string, raw: string): unknown =>
  file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw)

const readProjectPolicy = (root: string): ProjectPolicyConfig | null => {
  for (const basename of PROJECT_CONFIG_BASENAMES) {
    const file = path.join(root, ".claude-hooks", basename)
    if (!fs.existsSync(file)) continue
    const parsed = parseProjectConfig(file, fs.readFileSync(file, "utf8"))
    return Schema.decodeUnknownSync(ProjectPolicyConfigSchema)(parsed)
  }
  return null
}

export const loadPolicyConfig = (root: string): PolicyConfigData => {
  const project = readProjectPolicy(root)
  return project === null ? DEFAULT_POLICY : mergeProjectPolicy(DEFAULT_POLICY, project)
}

/**
 * `Effect.cached` memoises the underlying read for the lifetime of the Live
 * Layer (i.e. the dispatcher process). Subsequent `load()` calls return the
 * already-resolved value without re-running YAML/JSON disk reads.
 */
const makeLive = (root: string): Effect.Effect<PolicyConfigApi> =>
  Effect.gen(function* () {
    const rawLoad: Effect.Effect<PolicyConfigData> = Effect.sync(() =>
      loadPolicyConfig(root),
    )
    const cachedLoad = yield* Effect.cached(rawLoad)
    return PolicyConfig.of({
      load: () => cachedLoad,
    })
  })

export const PolicyConfigLiveFor = (root: string = process.cwd()): Layer.Layer<PolicyConfig> =>
  Layer.effect(PolicyConfig, makeLive(root))

export const PolicyConfigLive = PolicyConfigLiveFor()

export const PolicyConfigTest = (
  override: Partial<PolicyConfigData> = {},
): Layer.Layer<PolicyConfig> =>
  Layer.succeed(
    PolicyConfig,
    PolicyConfig.of({
      load: () => Effect.succeed({ ...DEFAULT_POLICY, ...override }),
    }),
  )

/**
 * Test helper for cached-read tests: build a Live-style PolicyConfig where
 * the underlying loader is a counter-mock supplied by the caller.
 */
export const PolicyConfigCachedFromLoader = (
  loader: Effect.Effect<PolicyConfigData>,
): Layer.Layer<PolicyConfig> =>
  Layer.effect(
    PolicyConfig,
    Effect.gen(function* () {
      const cached = yield* Effect.cached(loader)
      return PolicyConfig.of({ load: () => cached })
    }),
  )
