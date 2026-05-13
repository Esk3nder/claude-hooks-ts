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

export const AppTest = Layer.mergeAll(
  RuntimeConfigTest(),
  HookFailureLive,
  EventStoreTest(),
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
