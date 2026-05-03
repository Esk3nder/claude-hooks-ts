import { Context, Effect, Layer } from "effect"

export interface PolicyConfigData {
  readonly destructiveCommandPatterns: ReadonlyArray<RegExp>
  readonly secretPathGlobs: ReadonlyArray<string>
  readonly generatedFilePatterns: ReadonlyArray<RegExp>
  readonly secretValuePatterns: ReadonlyArray<RegExp>
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
}

export const PolicyConfigLive = Layer.succeed(
  PolicyConfig,
  PolicyConfig.of({
    load: () => Effect.succeed(DEFAULT_POLICY),
  }),
)

export const PolicyConfigTest = (
  override: Partial<PolicyConfigData> = {},
): Layer.Layer<PolicyConfig> =>
  Layer.succeed(
    PolicyConfig,
    PolicyConfig.of({
      load: () => Effect.succeed({ ...DEFAULT_POLICY, ...override }),
    }),
  )
