# Deferred methodology fixture tests

The end-to-end confirmation plan in [`docs/USER_STORIES.md`](../../../docs/USER_STORIES.md) names 9 fixture tests. This directory ships **8** of them. The remaining one is deferred because it depends on a story not yet on `main`.

| Test | Depends on | Reason |
| --- | --- | --- |
| `e2e-spec-drift.test.ts` | **US-15** (not yet implemented) | The spec-vs-implementation drift check at Stop doesn't exist yet. Will ship in the same PR as US-15. |

Adding it earlier would land a TODO/skip test, which the suite avoids by convention (a test exists when it asserts a real behavior).

## Coverage today

| Pillar | Fixture | Tests |
| --- | --- | --- |
| RPI engagement | `e2e-rpi.test.ts` | 2 |
| TDD | `e2e-tdd.test.ts` | 3 |
| Workers — mandatory | `e2e-worker-mandatory.test.ts` | 4 |
| Workers — verification replay | `e2e-worker-verification.test.ts` | 2 |
| ISC probe-provenance | `e2e-isc-provenance.test.ts` | 2 |
| Classifier inflation | `e2e-classifier-inflation.test.ts` | 3 |
| Classifier deflation | `e2e-classifier-deflation.test.ts` | 5 |
| Source-ledger scoping | `e2e-source-ledger-scoping.test.ts` | 3 |
| **Total** | 8 files | **24 tests** |
