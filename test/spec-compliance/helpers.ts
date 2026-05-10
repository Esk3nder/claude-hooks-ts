// Test-layer harness for spec-compliance audit.
//
// Per the existing repo pattern (see test/events/notification.test.ts),
// handlers that read services must be run under a composed test Layer.
// This module provides the canonical spec-compliance Layer plus a runHook
// helper that pipes through withSession so SessionState observers see a
// consistent session id.
import { Effect, Layer } from "effect"
import { withSession } from "../../src/services/session-context.ts"
import { FileSystemTest } from "../../src/services/filesystem.ts"
import { ProjectTest } from "../../src/services/project.ts"
import { SessionStateTest } from "../../src/services/session-state.ts"
import { ApprovalsTest } from "../../src/services/approvals.ts"
import { ElicitationsTest } from "../../src/services/elicitations.ts"
import { LedgerTest } from "../../src/services/ledger.ts"
import { PolicyConfigTest } from "../../src/services/policy-config.ts"
import { ShellTest } from "../../src/services/shell.ts"
import { GitTest } from "../../src/services/git.ts"
import { ClaudeSubprocessTest } from "../../src/services/claude-subprocess.ts"
import { InferenceTest } from "../../src/services/inference.ts"
import { ClassifierTelemetryTest } from "../../src/services/classifier-telemetry.ts"
import { RedactTest } from "../../src/services/redact.ts"
import { BudgetTest } from "../../src/services/budget.ts"
import { TracingLive } from "../../src/services/tracing.ts"

export const SPEC_ROOT = "/tmp/claude-hooks-ts-spec"

export const makeSpecLayer = () => {
  const telemetry = ClassifierTelemetryTest()

  return Layer.mergeAll(
    FileSystemTest(),
    ProjectTest({ root: SPEC_ROOT }),
    SessionStateTest(),
    ApprovalsTest(),
    ElicitationsTest(),
    LedgerTest(),
    PolicyConfigTest(),
    ShellTest(),
    GitTest(),
    ClaudeSubprocessTest(),
    InferenceTest(),
    telemetry.layer,
    RedactTest(),
    BudgetTest(),
    TracingLive,
  )
}

// Generic R — at call sites R is concrete (handler-specific). The cast
// to `Effect<A, E, never>` reflects the runtime fact that makeSpecLayer
// provides every service handlers in this repo declare. If a future
// handler adds a new service, runPromise will fail at runtime with
// "Service not found" — the cast doesn't paper over that.
export const runHook = <A, E, R>(
  sessionId: string,
  effect: Effect.Effect<A, E, R>,
): Promise<A> =>
  Effect.runPromise(
    withSession(sessionId, effect).pipe(
      Effect.provide(makeSpecLayer()),
    ) as unknown as Effect.Effect<A, E, never>,
  )
