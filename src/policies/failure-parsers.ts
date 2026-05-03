/**
 * Failure parsers for PostToolUseFailure handler.
 *
 * Each parser exports both a cheap `detect(input)` predicate and a `parse(input)`
 * structurer. `detectAndParse` walks parsers in a deliberate most-specific-first
 * order so that ambiguous inputs (e.g. a Vitest run that mentions "jest" in a
 * compatibility-shim message) get classified by the more specific tool first.
 *
 * Detection ordering (see PARSER_PIPELINE below):
 *   1. vitest   - distinct headers ` RUN  v` and ` Test Files ` and `Failed Tests` rule
 *                 banners that jest never emits. Must run before jest because vitest
 *                 output frequently mentions "jest" (compat shims, migration notes).
 *   2. jest     - jest-specific banners: `Test Suites:` summary, `Jest exited with code`
 *                 footer, leading `PASS|FAIL` with a `.test|spec` path, `● Suite > test`.
 *   3. pytest   - `FAILED path::test` lines and `=== short test summary ===` banner.
 *                 Robust against stray "jest" mentions in captured stderr.
 *   4. go-test  - `--- FAIL: TestName` and the trailing `FAIL\tpkg` summary lines.
 *   5. cargo    - `error[E####]` or `error: ` paired with `-->` source pointer and
 *                 a `.rs` path. Distinct from tsc which uses parens for line/col.
 *   6. tsc      - `error TS####` plus `path(line,col):` location format.
 *   7. eslint   - rule-id-tail format `  L:C  error  message  rule/sub-rule`.
 *   8. generic  - fallback for anything else.
 */

export type FailureCategory =
  | "pytest"
  | "jest"
  | "vitest"
  | "cargo"
  | "go-test"
  | "eslint"
  | "tsc"
  | "generic";

export interface ParsedFailure {
  readonly category: FailureCategory;
  readonly topLines: ReadonlyArray<string>;
  readonly likelyPath: string | null;
}

export interface FailureParser {
  readonly name: FailureCategory;
  detect(input: string): boolean;
  parse(input: string): ParsedFailure | null;
}

const PATH_LINE_COL = /([\/.\w-]+\.[a-zA-Z]+):(\d+)(?::(\d+))?/;

const findLikelyPath = (lines: ReadonlyArray<string>): string | null => {
  for (const line of lines) {
    const m = line.match(PATH_LINE_COL);
    if (m && m[0]) return m[0];
  }
  for (const line of lines) {
    const m = line.match(/([\/.\w-]+\.[a-zA-Z]+)/);
    if (m && m[1]) return m[1];
  }
  return null;
};

const splitLines = (s: string): string[] =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

const top3 = (lines: string[]): string[] => lines.slice(0, 3);

// ---- vitest --------------------------------------------------------------
const vitestParser: FailureParser = {
  name: "vitest",
  detect(text) {
    if (/\bRUN\s+v\d/.test(text)) return true;
    if (/⎯+\s*Failed Tests/.test(text)) return true;
    if (/^\s*Test Files\s+\d/m.test(text)) return true;
    if (/\bVitest\b/.test(text)) return true;
    return false;
  },
  parse(text) {
    if (!vitestParser.detect(text)) return null;
    const lines = splitLines(text).filter((l) =>
      /✗|✕|FAIL|Error:|AssertionError|Expected|Received/.test(l),
    );
    return {
      category: "vitest",
      topLines: top3(lines.length > 0 ? lines : splitLines(text)),
      likelyPath: findLikelyPath(splitLines(text)),
    };
  },
};

// ---- jest ----------------------------------------------------------------
const jestParser: FailureParser = {
  name: "jest",
  detect(text) {
    if (/⎯+\s*Failed Tests/.test(text)) return false;
    if (/\bRUN\s+v\d/.test(text)) return false;
    if (/^Test Suites:\s/m.test(text)) return true;
    if (/Jest exited with code/.test(text)) return true;
    if (/^\s*●\s+\S+\s+›\s+/m.test(text)) return true;
    if (/^(PASS|FAIL)\s+\S+\.(test|spec)\.[jt]sx?\b/m.test(text)) return true;
    return false;
  },
  parse(text) {
    if (!jestParser.detect(text)) return null;
    const lines = splitLines(text).filter(
      (l) =>
        /^✕/.test(l) ||
        /^(PASS|FAIL)\s+/.test(l) ||
        /Expected/.test(l) ||
        /Received/.test(l) ||
        /^●\s/.test(l),
    );
    return {
      category: "jest",
      topLines: top3(lines.length > 0 ? lines : splitLines(text)),
      likelyPath: findLikelyPath(splitLines(text)),
    };
  },
};

// ---- pytest --------------------------------------------------------------
const pytestParser: FailureParser = {
  name: "pytest",
  detect(text) {
    if (/^FAILED\s+\S+::/m.test(text)) return true;
    if (/short test summary info/.test(text)) return true;
    if (/={3,}\s*FAILURES\s*={3,}/.test(text)) return true;
    if (/^E\s{2,}/m.test(text)) return true;
    return false;
  },
  parse(text) {
    if (!pytestParser.detect(text)) return null;
    const lines = splitLines(text).filter(
      (l) => /^E\s+/.test(l) || /^FAILED\s+/.test(l) || /assert/i.test(l),
    );
    return {
      category: "pytest",
      topLines: top3(lines.length > 0 ? lines : splitLines(text)),
      likelyPath: findLikelyPath(splitLines(text)),
    };
  },
};

// ---- go-test -------------------------------------------------------------
const goTestParser: FailureParser = {
  name: "go-test",
  detect(text) {
    if (/^---\s+FAIL:\s/m.test(text)) return true;
    if (/^FAIL\t\S+/m.test(text)) return true;
    return false;
  },
  parse(text) {
    if (!goTestParser.detect(text)) return null;
    const lines = splitLines(text).filter(
      (l) => /---\s+FAIL:/.test(l) || /\.go:\d+/.test(l) || /^FAIL\t/.test(l),
    );
    return {
      category: "go-test",
      topLines: top3(lines.length > 0 ? lines : splitLines(text)),
      likelyPath: findLikelyPath(splitLines(text)),
    };
  },
};

// ---- cargo ---------------------------------------------------------------
const cargoParser: FailureParser = {
  name: "cargo",
  detect(text) {
    const hasErrorBanner = /error\[E\d+\]|^error:/m.test(text);
    const hasRustPointer = /-->\s+\S+\.rs:\d+/.test(text);
    return hasErrorBanner && hasRustPointer;
  },
  parse(text) {
    if (!cargoParser.detect(text)) return null;
    const lines = splitLines(text).filter(
      (l) => /^error/.test(l) || /-->/.test(l),
    );
    return {
      category: "cargo",
      topLines: top3(lines.length > 0 ? lines : splitLines(text)),
      likelyPath: findLikelyPath(splitLines(text)),
    };
  },
};

// ---- tsc -----------------------------------------------------------------
const tscParser: FailureParser = {
  name: "tsc",
  detect(text) {
    return /error TS\d+/.test(text);
  },
  parse(text) {
    if (!tscParser.detect(text)) return null;
    const lines = splitLines(text).filter((l) => /error TS\d+/.test(l));
    return {
      category: "tsc",
      topLines: top3(lines.length > 0 ? lines : splitLines(text)),
      likelyPath: findLikelyPath(splitLines(text)),
    };
  },
};

// ---- eslint --------------------------------------------------------------
const eslintParser: FailureParser = {
  name: "eslint",
  detect(text) {
    return /^\s+\d+:\d+\s+(error|warning)\s+.+\s+[@a-z][@\/a-z0-9-]*\s*$/m.test(
      text,
    );
  },
  parse(text) {
    if (!eslintParser.detect(text)) return null;
    const lines = splitLines(text).filter((l) => /\s(error|warning)\s/.test(l));
    return {
      category: "eslint",
      topLines: top3(lines.length > 0 ? lines : splitLines(text)),
      likelyPath: findLikelyPath(splitLines(text)),
    };
  },
};

// ---- generic fallback ----------------------------------------------------
const genericParser: FailureParser = {
  name: "generic",
  detect() {
    return true;
  },
  parse(text) {
    const lines = splitLines(text);
    return {
      category: "generic",
      topLines: top3(lines),
      likelyPath: findLikelyPath(lines),
    };
  },
};

/**
 * Ordered pipeline. Order is load-bearing: see file header for rationale.
 * vitest MUST come before jest because vitest output often mentions "jest"
 * (migration shims, helper names) but jest output never emits vitest's
 * `RUN  v` / `Test Files` / `Failed Tests` banners.
 */
const PARSER_PIPELINE: ReadonlyArray<FailureParser> = [
  vitestParser,
  jestParser,
  pytestParser,
  goTestParser,
  cargoParser,
  tscParser,
  eslintParser,
];

export const PARSERS: Readonly<
  Record<Exclude<FailureCategory, "generic">, FailureParser>
> = {
  vitest: vitestParser,
  jest: jestParser,
  pytest: pytestParser,
  "go-test": goTestParser,
  cargo: cargoParser,
  tsc: tscParser,
  eslint: eslintParser,
};

export const detectAndParse = (
  raw: string,
): { parser: FailureCategory; result: ParsedFailure } | null => {
  for (const p of PARSER_PIPELINE) {
    if (p.detect(raw)) {
      const result = p.parse(raw);
      if (result !== null) return { parser: p.name, result };
    }
  }
  return null;
};

export const parseFailure = (raw: string): ParsedFailure => {
  const hit = detectAndParse(raw);
  if (hit !== null) return hit.result;
  const fallback = genericParser.parse(raw);
  if (fallback !== null) return fallback;
  return { category: "generic", topLines: [], likelyPath: null };
};
