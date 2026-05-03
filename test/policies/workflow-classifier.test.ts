import { describe, expect, test } from "bun:test"
import {
  classifyPrompt,
  WORKFLOW_TAGS,
  type WorkflowTag,
} from "../../src/policies/workflow-classifier.ts"

const cases: ReadonlyArray<{ readonly prompt: string; readonly expected: WorkflowTag }> = [
  { prompt: "Fix the null pointer bug in the parser", expected: "coding.fix" },
  { prompt: "There's a regression in the login flow", expected: "coding.fix" },
  { prompt: "The build is broken", expected: "coding.fix" },
  { prompt: "Implement a new endpoint for user profiles", expected: "coding.feature" },
  { prompt: "Add a feature to export PDF", expected: "coding.feature" },
  { prompt: "Refactor the auth module to remove duplication", expected: "coding.refactor" },
  { prompt: "Rename UserService to AccountService", expected: "coding.refactor" },
  { prompt: "Code review the new payment PR please", expected: "coding.review" },
  { prompt: "Add unit tests for the cache layer", expected: "coding.test" },
  { prompt: "Improve test coverage", expected: "coding.test" },
  { prompt: "Optimize the slow database query for performance", expected: "coding.perf" },
  { prompt: "Profile the request latency", expected: "coding.perf" },
  { prompt: "Audit the auth flow for security vulnerabilities", expected: "coding.security" },
  { prompt: "Sanitize the user input to prevent XSS", expected: "coding.security" },
  { prompt: "Search the web for the latest React best practices", expected: "research.web" },
  { prompt: "Look up the current state of WASM tooling", expected: "research.web" },
  { prompt: "Where in the codebase do we handle retries?", expected: "research.repo" },
  { prompt: "Find the function that parses JWTs", expected: "research.repo" },
  { prompt: "Synthesize the trade-offs between gRPC and REST", expected: "research.synthesis" },
  { prompt: "Compare the pros and cons of these two approaches", expected: "research.synthesis" },
  { prompt: "Write the README for this package", expected: "writing.doc" },
  { prompt: "Update the changelog", expected: "writing.doc" },
  { prompt: "Squash the last three commits and rebase", expected: "ops.git" },
  { prompt: "Push the branch and open a pull request", expected: "ops.git" },
  { prompt: "Deploy v1.2 to production", expected: "ops.deploy" },
  { prompt: "Ship a release tonight", expected: "ops.deploy" },
  { prompt: "Run the schema migration on the orders table", expected: "ops.migration" },
  { prompt: "Backfill the new column", expected: "ops.migration" },
  { prompt: "blah blah random sentence with no signal", expected: "unknown" },
  { prompt: "", expected: "unknown" },
]

describe("classifyPrompt", () => {
  test("contains exactly 15 workflow tags", () => {
    expect(WORKFLOW_TAGS.length).toBe(15)
    expect(new Set(WORKFLOW_TAGS).size).toBe(15)
  })

  for (const c of cases) {
    test(`"${c.prompt.slice(0, 40)}" -> ${c.expected}`, () => {
      const r = classifyPrompt(c.prompt)
      expect(r.workflow).toBe(c.expected)
      expect(r.playbook.length).toBeGreaterThan(0)
    })
  }

  test("every workflow tag has a playbook covered by classifier output", () => {
    // Smoke: at least one prompt for each non-unknown tag is exercised above.
    const exercised = new Set(cases.map((c) => c.expected))
    for (const tag of WORKFLOW_TAGS) {
      expect(exercised.has(tag)).toBe(true)
    }
  })
})
