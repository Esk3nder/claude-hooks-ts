import { Layer } from "effect"
import { FileSystemLive } from "../services/filesystem.ts"
import { ShellLive } from "../services/shell.ts"
import { GitLive } from "../services/git.ts"
import { ProjectLive } from "../services/project.ts"
import { PolicyConfigLive } from "../services/policy-config.ts"
import { LedgerLive } from "../services/ledger.ts"
import { RedactLive } from "../services/redact.ts"
import { BudgetLive } from "../services/budget.ts"

export const AppLive = Layer.mergeAll(
  FileSystemLive,
  ShellLive,
  GitLive,
  ProjectLive,
  PolicyConfigLive,
  LedgerLive(),
  RedactLive,
  BudgetLive,
)
