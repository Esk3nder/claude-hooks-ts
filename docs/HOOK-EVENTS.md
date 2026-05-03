# Claude Code Hook Events — Coverage Reference

Reference for all 29 hook events documented in the official Claude Code hook
spec (https://code.claude.com/docs/en/hooks), and the level of support
`claude-hooks-ts` provides for each.

Status legend:

- ✅ implemented — wired through the dispatcher with a real handler
- ⏳ stub — schema present (or not), no behaviour
- ❌ not yet — not present in the codebase at all

For brevity, every payload also carries the common fields `session_id`,
`transcript_path`, `cwd`. Tool-related events additionally carry
`permission_mode` and `tool_use_id`. These are omitted from per-event tables.

---

## SessionStart

- Status: ✅ implemented (`src/events/session-start-brief.ts`)
- Matcher: yes — matches against `source` (e.g. `startup`, `resume`).
- Fires for: a Claude Code session beginning (cold start or resume).
- Input:
  ```ts
  {
    hook_event_name: "SessionStart"
    source?: string                 // "startup" | "resume" | ...
    model?: string                  // model identifier
    agent_type?: string             // when the session is a sub-agent
  }
  ```
- Output: `ContextInjection` — injects branch / dirty-file / verify-command brief.

## UserPromptSubmit

- Status: ✅ implemented (`src/events/prompt-router.ts`)
- Matcher: no
- Fires for: every user prompt sent to Claude.
- Input: `{ hook_event_name: "UserPromptSubmit", prompt: string }`
- Output: classification stored in session state; default no-op.

## UserPromptExpansion

- Status: ✅ implemented (`src/events/user-prompt-expansion.ts`)
- Matcher: no
- Fires for: when Claude expands a user prompt (slash commands, etc.).
- Input: `{ hook_event_name: "UserPromptExpansion", prompt: string, expanded_prompt?: string }`
- Output: default no-op (logging hook).

## PreToolUse

- Status: ✅ implemented (`src/events/pretool-policy.ts`)
- Matcher: yes — matches on `tool_name`.
- Fires for: every tool call before execution.
- Input:
  ```ts
  {
    hook_event_name: "PreToolUse"
    tool_name: string
    tool_input: unknown
    permission_mode?: string
    tool_use_id?: string
  }
  ```
- Output: `PreToolUseDecision` — `{hookSpecificOutput:{permissionDecision:"allow"|"deny"|"ask", permissionDecisionReason, updatedInput?}}`.

## PostToolUse

- Status: ✅ implemented (`src/events/post-edit-quality.ts` for Edit/Write/MultiEdit)
- Matcher: yes — matches on `tool_name`.
- Fires for: every successful tool call.
- Input:
  ```ts
  {
    hook_event_name: "PostToolUse"
    tool_name: string
    tool_input: unknown
    tool_response: unknown
    permission_mode?: string
    tool_use_id?: string
  }
  ```
- Output: typically `ContextInjection` (formatter/lint summary) or no-op.

## PostToolUseFailure

- Status: ✅ implemented (`src/events/failure-explainer.ts`)
- Matcher: yes — matches on `tool_name`.
- Fires for: a failed tool call.
- Input:
  ```ts
  {
    hook_event_name: "PostToolUseFailure"
    tool_name: string
    tool_input: unknown
    error: unknown
    error_type?: string             // "vitest" | "tsc" | …
    permission_mode?: string
    tool_use_id?: string
  }
  ```
- Output: `ContextInjection` with parsed failure + next-action hint.

## PostToolBatch

- Status: ✅ implemented (`src/events/batch-context-governor.ts`)
- Matcher: no
- Fires for: a coalesced batch of tool calls (Claude Code-only event).
- Input: `{ hook_event_name: "PostToolBatch", tools: Array<{tool_name, tool_input, tool_response?}> }`
- Output: `ContextInjection` summary; persists ledger; extracts URLs from WebFetch/WebSearch.

## Stop

- Status: ✅ implemented (`src/events/stop-definition-of-done.ts`)
- Matcher: no
- Fires for: assistant attempts to stop responding.
- Input:
  ```ts
  {
    hook_event_name: "Stop"
    assistant_message?: string      // the model's most recent message
  }
  ```
- Output: `StopDecision` (`{decision:"block", reason}`) or no-op.
- Quirk: there is **no** `stop_hook_active` field on the payload (despite
  earlier community examples). Loop-protection must be tracked locally; we
  do this via `SessionState.stop_blocked_once`.

## StopFailure

- Status: ⏳ not implemented
- Fires for: failure inside a Stop hook.
- Input: `{ hook_event_name: "StopFailure", error?: unknown }`
- Output: n/a

## PreCompact

- Status: ✅ implemented (`src/events/precompact-snapshot.ts`)
- Matcher: yes — matches on `trigger` (`auto` | `manual`).
- Fires for: before context compaction.
- Input: `{ hook_event_name: "PreCompact", trigger?: string, custom_instructions?: string }`
- Output: side-effect (writes snapshot); default no-op.

## PostCompact

- Status: ✅ implemented (`src/events/postcompact-ledger.ts`)
- Matcher: yes — matches on `trigger`.
- Fires for: after context compaction.
- Input: `{ hook_event_name: "PostCompact", trigger?: string }`
- Output: side-effect (ledger update); default no-op.

## SessionEnd

- Status: ✅ implemented (`src/events/session-ledger.ts`)
- Matcher: yes — matches on `reason`.
- Fires for: a Claude Code session terminating.
- Input: `{ hook_event_name: "SessionEnd", reason?: string }`
- Output: append-only audit trace; default no-op.

## PermissionRequest

- Status: ✅ implemented (`src/events/permission-autopilot.ts`)
- Matcher: yes — matches on `tool_name`.
- Fires for: a tool requesting an interactive permission decision.
- Input:
  ```ts
  {
    hook_event_name: "PermissionRequest"
    tool_name: string
    tool_input: unknown
    permission_suggestions?: Array<unknown>
    permission_mode?: string
    tool_use_id?: string
  }
  ```
- Output (M11 spec-conformant):
  ```ts
  {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest"
      decision: {
        behavior: "allow" | "deny"
        message?: string
        updatedInput?: unknown
        updatedPermissions?: Array<unknown>
      }
    }
  }
  ```
- Quirk: there is no `"ask"` behavior. Emit an empty no-op (`{}`) to defer to
  the built-in Claude Code dialog (the implicit "ask").

## PermissionDenied

- Status: ⏳ not implemented (no schema yet)
- Fires for: after Claude Code rejects a permission request.
- Input: `{ hook_event_name: "PermissionDenied", tool_name, tool_input, reason? }`
- Output: n/a

## ConfigChange

- Status: ✅ implemented (`src/events/config-guard.ts`)
- Matcher: yes — matches on `scope`.
- Fires for: changes to Claude Code settings.
- Input: `{ hook_event_name: "ConfigChange", scope?: string, changes?: unknown }`
- Output: `ContextInjection` warning when permissions/hooks weakened.

## FileChanged

- Status: ✅ implemented (`src/events/filechanged-env-guard.ts`)
- Matcher: yes — matches on `file_path`.
- Fires for: an externally-changed file noticed by Claude Code.
- Input: `{ hook_event_name: "FileChanged", file_path: string, change_type?: string }`
- Output: `ContextInjection` when sensitive files (`.env`, lockfiles, manifests) change.

## SubagentStart

- Status: ✅ implemented (`src/events/subagent-scope-gate.ts`)
- Matcher: yes — matches on `agent_type`.
- Fires for: a sub-agent task starting.
- Input:
  ```ts
  {
    hook_event_name: "SubagentStart"
    agent_type?: string             // canonical (was: subagent_type)
    agent_id?: string               // canonical correlation token
    prompt?: string
    // legacy compatibility:
    subagent_type?: string
    task_id?: string
  }
  ```
- Output: `ContextInjection` with role-specific scope rule.

## SubagentStop

- Status: ✅ implemented (`src/events/subagent-scope-gate.ts`)
- Matcher: yes — matches on `agent_type`.
- Fires for: a sub-agent task ending.
- Input:
  ```ts
  {
    hook_event_name: "SubagentStop"
    agent_type?: string
    agent_id?: string
    output?: string                 // canonical (was: result)
    // legacy compatibility:
    subagent_type?: string
    task_id?: string
    result?: string
  }
  ```
- Output: `StopDecision` block when an investigative role returns no evidence.

## TaskCreated

- Status: ✅ implemented (`src/events/task-integrity.ts`)
- Matcher: no
- Fires for: a TodoWrite-style task being created.
- Input: `{ hook_event_name: "TaskCreated", task_id: string, description?: string }`
- Output: side-effect (acceptance-criteria tracking); default no-op.

## TaskCompleted

- Status: ✅ implemented (`src/events/task-integrity.ts`)
- Matcher: no
- Fires for: a task being marked complete.
- Input: `{ hook_event_name: "TaskCompleted", task_id, status?, acceptance_criteria?, evidence? }`
- Output: `StopDecision` block when evidence is missing.

## Setup

- Status: ⏳ not implemented
- Fires for: first-time project setup.

## TeammateIdle

- Status: ⏳ not implemented
- Fires for: a sub-agent has been idle for a configured threshold.

## Notification

- Status: ⏳ not implemented
- Fires for: Claude Code surfacing a UI notification.

## InstructionsLoaded

- Status: ⏳ not implemented
- Fires for: CLAUDE.md / instructions file finished loading.

## CwdChanged

- Status: ⏳ not implemented
- Fires for: working directory change inside the session.

## WorktreeCreate

- Status: ⏳ not implemented
- Fires for: git worktree creation.

## WorktreeRemove

- Status: ⏳ not implemented
- Fires for: git worktree removal.

## Elicitation

- Status: ⏳ not implemented
- Fires for: an elicitation request to the user (structured ask).

## ElicitationResult

- Status: ⏳ not implemented
- Fires for: result of an elicitation.

---

## Summary

| Category | Count |
|---|---|
| ✅ implemented | 18 |
| ⏳ not implemented (stubs / future) | 11 |
| **Total spec events** | **29** |

The 11 unimplemented events are non-blocking and are tracked for follow-up
work. None of the currently-implemented behaviours depend on them.
