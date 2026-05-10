---
workflow: TestIdea
mode: single-run
---

# Test Idea Against World Threat Models

Test any idea, strategy, investment, brand, or concept against all 11 persistent world models
to assess viability across time horizons.

## When to Use

- User says "test this idea," "how will this hold up," "test my strategy," "stress test this"
- User provides an idea/strategy/investment and wants temporal viability analysis
- User wants to understand when an idea breaks or thrives

## Prerequisites

- World models must exist at `<your-claude-dir>/skills/WorldThreatModel/Models/`
- If models don't exist, prompt user to run UpdateModels workflow first

## Tier Detection

Detect from user prompt:
- **"fast"** or **"quick"** → Fast tier
- **"deep"** or **"thorough"** or **"comprehensive"** → Deep tier
- **No modifier** → Standard tier (default)

## Workflow Steps

### Step 0: Validate Models Exist

```
Check <your-claude-dir>/skills/WorldThreatModel/Models/ for all 11 model files.
If any missing: "World models incomplete. Run 'update world models' first."
If models older than 30 days: warn user but proceed.
```

### Step 1: Voice Notification

```bash
