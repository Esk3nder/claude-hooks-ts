# TODO

────────────────────────────────────────

**Lever:** C. UserPromptSubmit hook nudge

**What it does:** Use the existing workflow classifier — when it tags a turn as `coding.research` / `investigation` / unknown-with-multi-file-cues, inject `additionalContext: "Prefer Agent delegation for this turn."`

**Tradeoff:** Strongest signal (the hook fires every turn, can't be forgotten). Requires editing the classifier output in `claude-hooks-ts`. Real work, real test surface.

## PR46 Follow-Up Runtime Backlog

- [x] **Preserve selected cwd when running queued workers:** default worker execution jobs to the supervisor / CLI queue root when the persisted payload omits `cwd`, and persist `cwd` on retry-created jobs.
- [x] **Keep native write workers blocked without a captured patch:** regression-test native write-worker completion so `changes_made` plus passed verification still blocks when no isolated patch metadata exists.
- [x] **Earlier ISA first-action directive:** `UserPromptSubmit` tells agents to write/update the ISA first instead of discovering the same requirement by tripping a blocked implementation tool.
- [x] **Shorter ISA pretool denial:** `PreToolUse` emits a compact recovery message that names the ISA path and allowed actions without the long emergency-bypass paragraph.
- [x] **ISA re-mandated on follow-up turn in same session:** `UserPromptSubmit` should detect an existing ISA at the requested path, skip "MANDATORY FIRST ACTION" wording, tell the agent to update the existing ISA, and avoid wording that semantically demotes `phase: complete` back to `phase: observe`.
- [x] **Work directories accumulate without archive:** add `SessionStart` or `Stop` cleanup that moves stale `.claude-hooks/work/<uuid>/` directories into `.claude-hooks/archive/` when older than the configured retention window or marked `phase: complete`.
- [x] **Duplicate dirty-files lists:** make `SessionStart` summarize stale work directories instead of reprinting the same untracked `.claude-hooks/work/*` list already present in the environment preamble.
- **False-positive task-tool reminders:** suppress "Task tools haven't been used recently" when background agents are active, recent `TaskCreate` exists in the parent harness, or an in-flight ISA already covers the work units.
- [x] **Subagent return-format inconsistency:** update the global general-purpose subagent prompt skeleton to require direct markdown final answers, not ad hoc JSON envelopes with `output`, `report_markdown`, `deliverable`, or `deliverable_markdown` variants.
- **ISA frontmatter telemetry:** extend mandatory ISA frontmatter with `classifier_mode`, `classifier_tier`, and `classifier_reason` so Stop can verify the artifact matches the classifier route.
- **Reminder channel layering:** emit hook reminders outside assistant tool-result `<output>` blocks so reminders cannot be mistaken for stdout/stderr from the preceding tool.
- **Stale git-status snapshot:** avoid re-presenting SessionStart-time git status snapshots on later `UserPromptSubmit` turns; either refresh explicitly or label the snapshot once.
- **Hook-reminder priority resolver:** when the ISA gate is active, suppress lower-priority nudges such as TaskCreate reminders because the ISA is the active task tracker for that run.
