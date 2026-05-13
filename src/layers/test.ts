import { Layer } from "effect"
import { FileSystemTest } from "../services/filesystem.ts"
import { ShellTest } from "../services/shell.ts"
import { GitTest } from "../services/git.ts"
import { ProjectTest } from "../services/project.ts"
import { PolicyConfigTest } from "../services/policy-config.ts"
import { LedgerTest } from "../services/ledger.ts"
import { RedactTest } from "../services/redact.ts"
import { BudgetTest } from "../services/budget.ts"
import { SessionStateTest } from "../services/session-state.ts"
import { ApprovalsTest } from "../services/approvals.ts"
import { ElicitationsTest } from "../services/elicitations.ts"
import { ClaudeSubprocessTest } from "../services/claude-subprocess.ts"
import { InferenceTest } from "../services/inference.ts"
import { ClassifierTelemetryTest } from "../services/classifier-telemetry.ts"
import { RuntimeConfigTest } from "../services/runtime-config.ts"
import { HookFailureLive } from "../services/hook-failure.ts"
import { EventStoreTest } from "../services/event-store.ts"
import { CommandRunnerTest } from "../services/command-runner.ts"
import { WorkerQueueLive } from "../services/worker-queue.ts"
import { WorkerRunsLive } from "../services/worker-runs.ts"
import { WorkerAggregationLive } from "../services/worker-aggregation.ts"
import { WorkerIntegrationLive } from "../services/worker-integration.ts"
import { WorkerExecutorTest, WorkerSupervisorLive } from "../services/worker-supervisor.ts"

const WorkerDataTest = Layer.provideMerge(
  Layer.mergeAll(WorkerQueueLive(), WorkerRunsLive()),
  Layer.mergeAll(EventStoreTest(), RuntimeConfigTest()),
)

const WorkerRuntimeTest = Layer.provideMerge(
  Layer.mergeAll(WorkerAggregationLive, WorkerIntegrationLive, WorkerSupervisorLive),
  Layer.mergeAll(WorkerDataTest, WorkerExecutorTest(), CommandRunnerTest()),
)

export const AppTest = Layer.mergeAll(
  RuntimeConfigTest(),
  HookFailureLive,
  WorkerRuntimeTest,
  CommandRunnerTest(),
  FileSystemTest(),
  ShellTest(),
  GitTest(),
  ProjectTest(),
  PolicyConfigTest(),
  LedgerTest(),
  RedactTest(),
  BudgetTest(),
  SessionStateTest(),
  ApprovalsTest(),
  ElicitationsTest(),
  ClaudeSubprocessTest(),
  InferenceTest(),
  ClassifierTelemetryTest().layer,
)
