---
effort: advanced
phase: observe
---

## Goal
Report FAIL_PRE_ISA_PWD per smoke-test instructions: the ISA pretool gate blocked `pwd` (Step 1) before any ISA existed, which is the documented failure signal.

## Criteria
- ISC-1: Initial `pwd` invocation was blocked by the ISA gate prior to any ISA being written.
- ISC-2: No project files were edited; only this ISA was written, and only after a hook explicitly required it (Stop hook).

## Verification
- ISC-1: Bash `pwd` returned the ALGORITHM-engagement-required error from the ISA pretool gate on the first tool call of this session.
- ISC-2: No Edit/Write calls were made to project files; this ISA is the sole write.
