import { describe, expect, test } from "bun:test"
import {
  classifyPrompt,
  requiresWebSources,
  WORKFLOW_TAGS,
  type WorkflowTag,
} from "../../src/policies/workflow-classifier.ts"

const cases: ReadonlyArray<{ readonly prompt: string; readonly expected: WorkflowTag }> = [
  { prompt: "Fix the null pointer bug in the parser", expected: "coding.fix" },
  { prompt: "There's a regression in the login flow", expected: "coding.fix" },
  { prompt: "The build is broken", expected: "coding.fix" },
  { prompt: "Implement a new endpoint for user profiles", expected: "coding.feature" },
  { prompt: "Add a feature to export PDF", expected: "coding.feature" },
  { prompt: "Create a single-page HTML dashboard for solar underwriting", expected: "coding.feature" },
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
  // M6: ops.deploy false-positive cases — must NOT classify as deploy
  { prompt: "write release notes for v2.3", expected: "writing.doc" },
  { prompt: "draft the changelog", expected: "writing.doc" },
  { prompt: "update the release notes", expected: "writing.doc" },
  { prompt: "document our release history", expected: "writing.doc" },
  // M6: ops.deploy true-positive cases — must classify as deploy
  { prompt: "deploy to staging", expected: "ops.deploy" },
  { prompt: "ship the v2.3 release", expected: "ops.deploy" },
  { prompt: "release v2.3 to production", expected: "ops.deploy" },
  { prompt: "blah blah random sentence with no signal", expected: "unknown" },
  { prompt: "", expected: "unknown" },
  // Anti-cases for the bare-`latest` priming false-positive that caused
  // research.web Stop blocks on git-sync questions. Tightened to require a
  // disambiguating noun (latest news / version / release / in the ...).
  { prompt: "are we on the latest?", expected: "unknown" },
  { prompt: "is this the latest commit", expected: "ops.git" },
  // Affirmative cases that must still classify as research.web after the
  // tighten — the priming playbook is still useful for these.
  { prompt: "what's the latest news on bun", expected: "research.web" },
  { prompt: "latest research on prompt caching", expected: "research.web" },
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

  test("solar dashboard benchmark-data task stays feature-shaped, not perf-shaped", () => {
    const prompt = `Create a single-page HTML dashboard for underwriting a small solar-installation business.

Pull real current benchmark data where useful, such as average residential solar install cost per watt,
battery storage attach-rate or cost ranges, current federal tax credit, and recent residential
electricity price trends. Cite the sources in the page footer.`
    expect(classifyPrompt(prompt).workflow).toBe("coding.feature")
  })
})

/**
 * `requiresWebSources` is the STRICT predicate the Stop research-mode gate
 * keys off. False positives here block Stop until source_urls is populated,
 * so it must deny-by-default for ambiguous prompts.
 */
describe("requiresWebSources", () => {
  // Affirmative — must trigger
  const positive = [
    "search the web for the latest React best practices",
    "do some web research on this",
    "google for tokio runtime benchmarks",
    "cite authoritative sources",
    "what's the latest news on bun",
    "latest news on bun",
    "what's the state of the art in retrieval models",
    "current best practice for prompt caching",
    "any recent news about claude code",
    "find some online research on the topic",
    "cite the sources in the page footer",
    "Pull real current benchmark data where useful",
  ]
  for (const p of positive) {
    test(`positive: "${p}"`, () => {
      expect(requiresWebSources(p)).toBe(true)
    })
  }

  // Negative — must NOT trigger. These are the false-positive class that
  // motivated the priming-vs-gating split.
  const negative = [
    "",
    "ok",
    "are we on the latest?",
    "pull the latest",
    "is this the latest commit",
    "is this the latest version of the package",
    "merge these arrays",
    "push this button on the UI",
    "the else branch needs simplification",
    "fix the slow login bug",
    "memory leak in the request handler",
    "test this in the browser",
    "the secret sauce of this module",
    "release notes for v2.3",
  ]
  for (const p of negative) {
    test(`negative: "${p}"`, () => {
      expect(requiresWebSources(p)).toBe(false)
    })
  }

  test("property: prompts under 40 chars built only from common English do not trigger", () => {
    const commonWords = [
      "ok",
      "yes",
      "the",
      "this",
      "we",
      "are",
      "on",
      "is",
      "it",
      "do",
      "you",
      "and",
      "or",
      "but",
      "to",
      "a",
      "an",
      "in",
      "of",
      "for",
      "with",
      "be",
      "have",
      "go",
      "make",
      "see",
      "know",
      "get",
      "give",
      "take",
      "fine",
      "good",
      "bad",
      "now",
      "then",
    ]
    // Cartesian sample: 3-word phrases
    let triggered: string | null = null
    outer: for (const a of commonWords) {
      for (const b of commonWords) {
        for (const c of commonWords) {
          const p = `${a} ${b} ${c}`
          if (p.length >= 40) continue
          if (requiresWebSources(p)) {
            triggered = p
            break outer
          }
        }
      }
    }
    expect(triggered).toBeNull()
  })
})
