import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectAndParse,
  parseFailure,
  type FailureCategory,
} from "../../src/policies/failure-parsers.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "failures");

const loadFixture = (name: string): string =>
  readFileSync(join(FIXTURES_DIR, name), "utf8");

describe("parseFailure (inline)", () => {
  test("pytest", () => {
    const text = `============================= FAILURES =============================
test/test_foo.py::test_add FAILED
E       AssertionError: assert 2 == 3
test/test_foo.py:14: AssertionError
FAILED test/test_foo.py::test_add - AssertionError: assert 2 == 3
`;
    const r = parseFailure(text);
    expect(r.category).toBe("pytest");
    expect(r.likelyPath).toContain("test_foo.py");
    expect(r.topLines.length).toBeLessThanOrEqual(3);
  });

  test("jest", () => {
    const text = `FAIL src/sum.test.ts
  ✕ adds two numbers (5 ms)
  Expected: 5
  Received: 4
    at Object.<anonymous> (src/sum.test.ts:10:5)
`;
    const r = parseFailure(text);
    expect(r.category).toBe("jest");
    expect(r.likelyPath).toContain("sum.test.ts");
  });

  test("vitest", () => {
    const text = ` RUN  v1.6.0
⎯ Failed Tests 1 ⎯
FAIL src/foo.test.ts > sums
Error: Expected 1 to equal 2
  at src/foo.test.ts:8:3
`;
    const r = parseFailure(text);
    expect(r.category).toBe("vitest");
  });

  test("cargo", () => {
    const text = `error[E0308]: mismatched types
 --> src/main.rs:7:9
  |
7 |     let x: u32 = "hello";
  |            ---   ^^^^^^^ expected u32
`;
    const r = parseFailure(text);
    expect(r.category).toBe("cargo");
    expect(r.likelyPath).toContain("main.rs");
  });

  test("go test", () => {
    const text = `--- FAIL: TestSum (0.00s)
    sum_test.go:14: Expected 4 got 5
FAIL
exit status 1
`;
    const r = parseFailure(text);
    expect(r.category).toBe("go-test");
    expect(r.likelyPath).toContain("sum_test.go");
  });

  test("eslint", () => {
    const text = `/repo/src/x.ts
  10:1  error  Unexpected console statement  no-console
  12:5  error  'foo' is defined but never used  no-unused-vars
`;
    const r = parseFailure(text);
    expect(r.category).toBe("eslint");
  });

  test("tsc", () => {
    const text = `src/x.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/y.ts(3,1): error TS2304: Cannot find name 'foo'.
`;
    const r = parseFailure(text);
    expect(r.category).toBe("tsc");
    expect(r.likelyPath).toContain("x.ts");
  });

  test("generic", () => {
    const text = `something exploded\nstack trace here\nidk what\n`;
    const r = parseFailure(text);
    expect(r.category).toBe("generic");
    expect(r.topLines.length).toBeLessThanOrEqual(3);
  });
});

describe("detectAndParse fixtures", () => {
  const cases: ReadonlyArray<{ file: string; expected: FailureCategory }> = [
    { file: "pytest-typical.txt", expected: "pytest" },
    { file: "jest-typical.txt", expected: "jest" },
    { file: "vitest-typical.txt", expected: "vitest" },
    { file: "go-test-typical.txt", expected: "go-test" },
    { file: "cargo-typical.txt", expected: "cargo" },
    { file: "eslint-typical.txt", expected: "eslint" },
    { file: "tsc-typical.txt", expected: "tsc" },
  ];

  for (const c of cases) {
    test(`${c.file} -> ${c.expected}`, () => {
      const raw = loadFixture(c.file);
      const hit = detectAndParse(raw);
      expect(hit).not.toBeNull();
      expect(hit?.parser).toBe(c.expected);
      expect(hit?.result.category).toBe(c.expected);
    });
  }

  test("pytest-and-warnings.txt detects as pytest (not jest)", () => {
    const raw = loadFixture("pytest-and-warnings.txt");
    const hit = detectAndParse(raw);
    expect(hit?.parser).toBe("pytest");
  });

  test("vitest-with-jest-import.txt detects as vitest (not jest)", () => {
    const raw = loadFixture("vitest-with-jest-import.txt");
    const hit = detectAndParse(raw);
    expect(hit?.parser).toBe("vitest");
  });
});
