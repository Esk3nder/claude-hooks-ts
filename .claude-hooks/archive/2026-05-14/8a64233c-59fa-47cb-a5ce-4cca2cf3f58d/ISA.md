# ISA: Naming Consistency Audit

## Goal
Read-only audit of /Users/eskender_archetype/code/claude-hooks-ts for naming inconsistencies across code, configs, and docs. Produce a categorized report with file:line citations. No edits.

## Definition of Done
- Categories covered: terminology synonyms (worker/job/task/agent/subagent), casing drift (camelCase vs snake_case vs kebab-case vs PascalCase), identifier-vs-doc mismatches, config key drift, constant naming.
- Findings include file:line citations.
- No files modified outside this ISA.

## Approach
1. Enumerate top-level layout (src, bin, docs, config schemas).
2. Grep for known synonym clusters: worker|job|task|agent|subagent; isa|plan|spec; hook|trigger; orchestrator|coordinator|controller.
3. Compare exported symbol names vs how docs reference them.
4. Look at settings/config keys for casing drift.
5. Group findings.

## Assumptions
- "Repo" excludes .claude-hooks/work/* sandboxes and node_modules/.git.
- Read-only: only Read/Grep/Glob/limited Bash for listing.
