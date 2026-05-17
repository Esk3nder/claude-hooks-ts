import { Schema } from "effect"
import { HookDecision, WorktreeCreateDecision } from "./decisions.ts"

export const NormalizedHookDecision = HookDecision
export type NormalizedHookDecision = HookDecision

export const HookDecisionStdout = HookDecision
export type HookDecisionStdout = HookDecision

export const encodeHookDecision = (decision: NormalizedHookDecision) =>
  Schema.encodeEither(HookDecisionStdout)(decision)

export const encodeWorktreeCreateDecision = (decision: WorktreeCreateDecision) =>
  Schema.encodeEither(WorktreeCreateDecision)(decision)
