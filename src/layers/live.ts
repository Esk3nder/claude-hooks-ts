import { Layer } from "effect"
import { FileSystemLive } from "../services/filesystem.ts"
import { ShellLive } from "../services/shell.ts"
import { GitLive } from "../services/git.ts"
import { ProjectLiveFor } from "../services/project.ts"
import { PolicyConfigLiveFor } from "../services/policy-config.ts"
import { LedgerLive } from "../services/ledger.ts"
import { RedactLive } from "../services/redact.ts"
import { BudgetLive } from "../services/budget.ts"
import { SessionStateLive } from "../services/session-state.ts"
import { ApprovalsLive } from "../services/approvals.ts"
import { ElicitationsLive } from "../services/elicitations.ts"
import { ClaudeSubprocessLive } from "../services/claude-subprocess.ts"
import { InferenceLive } from "../services/inference.ts"
import { ClassifierTelemetryLive } from "../services/classifier-telemetry.ts"
import { RuntimeConfigLive } from "../services/runtime-config.ts"
import { HookFailureLive } from "../services/hook-failure.ts"

export const makeAppLive = (root: string = process.cwd()) =>
  Layer.mergeAll(
    RuntimeConfigLive,
    HookFailureLive,
    FileSystemLive,
    ShellLive,
    GitLive,
    ProjectLiveFor(root),
    PolicyConfigLiveFor(root),
    LedgerLive(root),
    RedactLive,
    BudgetLive,
    SessionStateLive(root),
    ApprovalsLive,
    ElicitationsLive,
    ClaudeSubprocessLive,
    InferenceLive,
    ClassifierTelemetryLive(root),
  )

export const AppLive = makeAppLive()
