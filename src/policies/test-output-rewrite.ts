/**
 * Stub policy reserved for M5: rewrites/condenses noisy test output before
 * it is injected back into the agent's context. Currently a pass-through.
 */
export interface TestOutputRewriteResult {
  readonly rewritten: string
  readonly truncated: boolean
}

export const rewriteTestOutput = (raw: string): TestOutputRewriteResult => ({
  rewritten: raw,
  truncated: false,
})
