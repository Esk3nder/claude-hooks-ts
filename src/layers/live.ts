import { Layer } from "effect"
import { FileSystemLive } from "../services/filesystem.ts"
import { ShellLive } from "../services/shell.ts"
import { GitLive } from "../services/git.ts"
import { ProjectLiveFor } from "../services/project.ts"
import { PolicyConfigLiveFor } from "../services/policy-config.ts"
import { LedgerLiveBase } from "../services/ledger.ts"
import { RedactLive } from "../services/redact.ts"
import { BudgetLive } from "../services/budget.ts"
import { SessionStateLive } from "../services/session-state.ts"
import { ApprovalsLiveBase } from "../services/approvals.ts"
import { ElicitationsLiveBase } from "../services/elicitations.ts"
import { ClaudeSubprocessLive } from "../services/claude-subprocess.ts"
import { InferenceLive } from "../services/inference.ts"
import { ClassifierTelemetryLiveBase } from "../services/classifier-telemetry.ts"
import { RuntimeConfigLive } from "../services/runtime-config.ts"
import { HookFailureLive } from "../services/hook-failure.ts"
import { CommandRunnerPlatformLive } from "../services/command-runner.ts"
import { EventStoreLive } from "../services/event-store.ts"
import { WorkerQueueLive } from "../services/worker-queue.ts"
import { WorkerRunsLive } from "../services/worker-runs.ts"
import { WorkerAggregationLive } from "../services/worker-aggregation.ts"
import { WorkerIntegrationLive } from "../services/worker-integration.ts"
import { WorkerExecutorLive, WorkerSupervisorLive } from "../services/worker-supervisor.ts"

export const makeAppLive = (root: string = process.cwd()) => {
  const runtime = RuntimeConfigLive
  const eventBacked = Layer.provideMerge(
    Layer.mergeAll(
      LedgerLiveBase(root),
      ApprovalsLiveBase,
      ElicitationsLiveBase,
      ClassifierTelemetryLiveBase(root),
      WorkerQueueLive(root),
      WorkerRunsLive(root),
    ),
    Layer.mergeAll(EventStoreLive, runtime),
  )
  const commandBase = Layer.provideMerge(
    Layer.mergeAll(ShellLive, GitLive, ClaudeSubprocessLive),
    CommandRunnerPlatformLive,
  )
  const commandBacked = Layer.provideMerge(WorkerExecutorLive, commandBase)
  const workerRuntime = Layer.provideMerge(
    Layer.mergeAll(WorkerAggregationLive, WorkerIntegrationLive, WorkerSupervisorLive),
    Layer.mergeAll(eventBacked, commandBacked),
  )
  return Layer.mergeAll(
    runtime,
    HookFailureLive,
    FileSystemLive,
    workerRuntime,
    ProjectLiveFor(root),
    PolicyConfigLiveFor(root),
    RedactLive,
    BudgetLive,
    SessionStateLive(root),
    InferenceLive,
  )
}

export const AppLive = makeAppLive()
