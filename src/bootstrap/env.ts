export type EnvMap = Record<string, string | undefined>

/**
 * Bootstrap-only access to the process environment.
 * Runtime code should depend on typed services derived from this boundary.
 */
export const currentProcessEnv = (): EnvMap => process.env
