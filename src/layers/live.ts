import { Layer } from "effect"
import { FileSystemLive } from "../services/filesystem.ts"
import { ShellLive } from "../services/shell.ts"
import { GitLive } from "../services/git.ts"
import { ProjectLive } from "../services/project.ts"
import { PolicyConfigLive } from "../services/policy-config.ts"
import { LedgerLive } from "../services/ledger.ts"
import { RedactLive } from "../services/redact.ts"
import { BudgetLive } from "../services/budget.ts"
import { SessionStateLive } from "../services/session-state.ts"
import { ApprovalsLive } from "../services/approvals.ts"
import { ElicitationsLive } from "../services/elicitations.ts"
import { ClaudeSubprocessLive } from "../services/claude-subprocess.ts"
import { InferenceLive } from "../services/inference.ts"
import { ClassifierTelemetryLive } from "../services/classifier-telemetry.ts"

export const AppLive = Layer.mergeAll(
  FileSystemLive,
  ShellLive,
  GitLive,
  ProjectLive,
  PolicyConfigLive,
  LedgerLive(),
  RedactLive,
  BudgetLive,
  SessionStateLive(),
  ApprovalsLive,
  ElicitationsLive,
  ClaudeSubprocessLive,
  InferenceLive,
  ClassifierTelemetryLive(),
)
