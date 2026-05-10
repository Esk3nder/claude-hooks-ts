---
workflow: UpdateModels
mode: loop-compatible
---

# Update World Models

Refresh or create world model documents using deep research and user-provided analysis.

## When to Use

- User says "update world models," "refresh models," "new analysis for models"
- User provides new information/analysis to incorporate into models
- Models are stale (>30 days since last update)
- Initial model population (no models exist yet)

## Prerequisites

- Model template at `~/.claude/skills/WorldThreatModel/ModelTemplate.md`
- Research skill available for web research

## Workflow Steps

### Step 0: Check Existing State

```
Read <your-claude-dir>/skills/WorldThreatModel/Models/INDEX.md (if exists)
Inventory which models exist and their last_updated dates
Determine: full creation vs. targeted update
```

### Step 1: Voice Notification

```bash
