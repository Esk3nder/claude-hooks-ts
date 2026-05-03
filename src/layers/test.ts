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

export const AppTest = Layer.mergeAll(
  FileSystemTest(),
  ShellTest(),
  GitTest(),
  ProjectTest(),
  PolicyConfigTest(),
  LedgerTest(),
  RedactTest(),
  BudgetTest(),
  SessionStateTest(),
)
