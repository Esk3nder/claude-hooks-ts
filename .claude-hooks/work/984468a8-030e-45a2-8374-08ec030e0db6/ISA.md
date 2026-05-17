---
effort: advanced
phase: observe
classifier_mode: ALGORITHM
classifier_tier: E3
classifier_reason: substantial single-file build with multiple dynamic calculators, scenario modeling, benchmark data, and polished UI requiring multi-step implementation
---

# ISA — Solar Underwriting Dashboard

## Problem
Underwriter needs a quick, self-contained tool to evaluate a small residential solar installer: revenue mix, margin, runway, break-even, and base/upside/downside scenarios — without spinning up a spreadsheet or web app.

## Vision
One HTML file, opened locally, with live-recalculating inputs grouped by calculator, scenario comparison side-by-side, embedded current industry benchmarks as defaults, and a sources footer.

## Out of Scope
- Server, build step, or external JS/CSS dependencies
- Persisting inputs across reloads (nice-to-have only)
- Multi-year DCF, debt modeling, tax modeling beyond ITC mention
- Mobile-first design (desktop finance-tool aesthetic)

## Constraints
- Single self-contained `.html` (inline CSS + JS, no network at runtime)
- All math must be deterministic and re-run on any input change
- Benchmarks must be real and cited (LBNL Tracking the Sun, SEIA/Wood Mackenzie, EIA, IRS ITC)

## Goal
Produce `solar-underwriting.html` with five live calculators + scenario comparison, sensible defaults from current benchmarks, and a sources footer.

## Criteria
- ISC-1: Revenue calculator combines installs (volume × system kW × price/W), maintenance MRR, and battery attach revenue
- ISC-2: Gross margin nets labor, equipment, permitting, sales commission against revenue; shows $ and %
- ISC-3: Cash runway = cash / (fixed costs + WC drag from AR delay); shown in months
- ISC-4: Break-even computes installs/month needed to cover fixed costs at current contribution margin
- ISC-5: Scenario panel shows base/upside/downside with three independently editable assumption sets
- ISC-6: All inputs trigger live recalc (input/change events) with no page reload
- ISC-7: Defaults match cited 2025 benchmarks; footer lists sources

## Features
- Input grid with grouped sections, currency/number formatting
- KPI cards (revenue, GM%, runway months, break-even installs)
- Scenario table comparing base/upside/downside outputs
- Inline "what this means" tooltips/notes
- Polished neutral UI (dark or light, finance-tool restraint)

## Test Strategy
Manual: open file in browser, edit each input, confirm KPI cards and scenario table recompute correctly. Spot-check three arithmetic cases against hand calc.

## Verification
- ISC-1..7: pending implementation + manual browser check
