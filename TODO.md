# TODO

────────────────────────────────────────

**Lever:** C. UserPromptSubmit hook nudge

**What it does:** Use the existing workflow classifier — when it tags a turn as `coding.research` / `investigation` / unknown-with-multi-file-cues, inject `additionalContext: "Prefer Agent delegation for this turn."`

**Tradeoff:** Strongest signal (the hook fires every turn, can't be forgotten). Requires editing the classifier output in `claude-hooks-ts`. Real work, real test surface.
