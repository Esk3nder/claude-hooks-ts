/**
 * Pure regex/keyword-based classifier mapping a free-form prompt to one of
 * exactly 15 workflow tags. Returns the tag and a one-sentence playbook.
 */

export type WorkflowTag =
  | "coding.fix"
  | "coding.feature"
  | "coding.refactor"
  | "coding.review"
  | "coding.test"
  | "coding.perf"
  | "coding.security"
  | "research.web"
  | "research.repo"
  | "research.synthesis"
  | "writing.doc"
  | "ops.git"
  | "ops.deploy"
  | "ops.migration"
  | "unknown"

export interface ClassifierResult {
  readonly workflow: WorkflowTag
  readonly playbook: string
}

export const WORKFLOW_TAGS: ReadonlyArray<WorkflowTag> = [
  "coding.fix",
  "coding.feature",
  "coding.refactor",
  "coding.review",
  "coding.test",
  "coding.perf",
  "coding.security",
  "research.web",
  "research.repo",
  "research.synthesis",
  "writing.doc",
  "ops.git",
  "ops.deploy",
  "ops.migration",
  "unknown",
]

const PLAYBOOKS: Record<WorkflowTag, string> = {
  "coding.fix":
    "Reproduce the bug with a failing test, locate the root cause, fix narrowly, then re-run the test to confirm.",
  "coding.feature":
    "Sketch the contract, add tests for the new behaviour, implement minimally, then verify with typecheck and tests.",
  "coding.refactor":
    "Keep behaviour identical: lock in tests first, refactor in small steps, re-run the full test suite after each change.",
  "coding.review":
    "Read the diff end-to-end; flag correctness, safety, and clarity issues; suggest concrete fixes, not vague concerns.",
  "coding.test":
    "Identify uncovered branches, write the smallest assertions that pin the behaviour, run only the affected suite.",
  "coding.perf":
    "Measure before changing: profile a real workload, fix the hottest path, re-measure to confirm a real win.",
  "coding.security":
    "Threat-model first; treat all inputs as hostile; never log secrets; verify with deny-by-default tests.",
  "research.web":
    "Use web search for authoritative sources, capture URLs in the ledger, and synthesise a short answer with citations.",
  "research.repo":
    "Search the local codebase first; read entry points and tests before touching code; cite file paths and line numbers.",
  "research.synthesis":
    "Reconcile multiple sources into a single conclusion, flag disagreements, and end with an actionable recommendation.",
  "writing.doc":
    "Write for the reader who has the problem now: lead with the answer, then the why, then the example.",
  "ops.git":
    "State the intended end state before running git; prefer non-destructive commands; never force-push without confirmation.",
  "ops.deploy":
    "Verify the build artefact, dry-run the deploy if possible, and watch the post-deploy signals before declaring done.",
  "ops.migration":
    "Back up first, run the migration on a copy, verify reversibility, only then apply to the real target.",
  unknown:
    "Restate the goal in one sentence, then choose the most direct path; ask the user if the goal is genuinely ambiguous.",
}

export const playbookFor = (tag: WorkflowTag): string => PLAYBOOKS[tag]

interface Rule {
  readonly tag: WorkflowTag
  readonly pattern: RegExp
}

// Order matters: more specific patterns first.
const RULES: ReadonlyArray<Rule> = [
  // Security before generic fix/feature
  {
    tag: "coding.security",
    pattern:
      /\b(security|vulnerab|cve|exploit|sanitiz|xss|sqli|csrf|authentication|authorization|secret|credential|leak)\b/i,
  },
  // Performance
  {
    tag: "coding.perf",
    pattern:
      /\b(perf(ormance)?|optimi[sz]e|optimi[sz]ation|latency|throughput|slow|profile|benchmark|memory leak|cpu)\b/i,
  },
  // Tests
  {
    tag: "coding.test",
    pattern:
      /\b(test|tests|unit test|integration test|spec|coverage|jest|vitest|bun test|pytest|rspec)\b/i,
  },
  // Review
  {
    tag: "coding.review",
    pattern: /\b(review|code review|pr review|critique|audit code|look over)\b/i,
  },
  // Refactor
  {
    tag: "coding.refactor",
    pattern:
      /\b(refactor|rename|extract (method|function|module)|restructure|clean up|cleanup|tidy)\b/i,
  },
  // Fix / bug
  {
    tag: "coding.fix",
    pattern:
      /\b(fix|bug|broken|error|crash|regression|hotfix|patch|stack ?trace|exception|failing test|fail(s|ed|ing)?)\b/i,
  },
  // Feature / implement
  {
    tag: "coding.feature",
    pattern:
      /\b(implement|build|add (a |an |the )?(feature|endpoint|button|page|method|function|class|module|hook)|new feature|create (a |an |the )?(component|service|handler))\b/i,
  },
  // Ops: deploy
  // Tightened to require a true deploy verb context. Excludes documentation
  // phrases like "release notes", "release notes for", "changelog",
  // "release history" so they fall through to writing.doc / ops.git.
  {
    tag: "ops.deploy",
    pattern:
      /\b(?:deploy(?:ing|ed|ment)?|ship(?:ping|ped)?|rollout|cut a release|publish (?:to|the) (?:npm|registry|production|prod)|release(?: v?\d|(?: the| a)?(?: hot ?fix| candidate| build)?(?: (?:to|on|into) (?:prod|production|staging|preview|canary)))|release tonight|release today)\b/i,
  },
  // Ops: migration
  {
    tag: "ops.migration",
    pattern:
      /\b(migration|migrate|schema change|alter table|backfill|upgrade (database|db)|data move)\b/i,
  },
  // Ops: git
  {
    tag: "ops.git",
    pattern:
      /\b(git|commit|rebase|merge|branch|cherry-?pick|stash|push|pull request|pr|squash|revert)\b/i,
  },
  // Writing / docs
  {
    tag: "writing.doc",
    pattern:
      /\b(docs?|documentation|readme|changelog|release notes?|release history|tutorial|guide|write up|write-up|blog post|explainer)\b/i,
  },
  // Research: synthesis
  {
    tag: "research.synthesis",
    pattern:
      /\b(synthesi[sz]e|compare|trade-?offs?|pros and cons|reconcile|summari[sz]e (the )?(findings|sources|results))\b/i,
  },
  // Research: repo
  {
    tag: "research.repo",
    pattern:
      /\b(where (in|is) (the |this )?(code|codebase|repo)|find (the )?(function|class|module|usage)|how does .* work in (this|the) (codebase|repo))\b/i,
  },
  // Research: web
  //
  // `latest` standalone was a frequent false-positive trigger ("are we on the
  // latest", "pull the latest", "is X the latest version") because it's a
  // bare English adjective. We require a disambiguating noun phrase. The
  // multi-word web-research signals upstream (`search the web`, `google`,
  // `look up`, `state of the art`, …) still carry their own meaning.
  {
    tag: "research.web",
    pattern:
      /\b(search( the)? web|google|look up|latest (news|research|version of|release of)|latest in (the )?|current best practice|state of the art|recent (news|update)|web research)\b/i,
  },
]

/**
 * Patterns that signal the user genuinely wants web-research-style sources
 * (citable URLs). Intentionally a STRICT subset of `research.web`'s priming
 * alternatives — false positives here cause the Stop research-mode gate to
 * block the turn until `source_urls` has at least one entry, so the cost
 * of an over-eager match is much higher than a wrong priming playbook.
 *
 * Tested deny-by-default in workflow-classifier.test.ts.
 */
const WEB_SOURCES_REQUIRED: ReadonlyArray<RegExp> = [
  /\bsearch (?:the )?web\b/i,
  /\bweb research\b/i,
  /\b(?:google|duckduckgo|bing)\s+(?:for|the)\s+\S+/i,
  /\bcite (?:authoritative|external|primary|web) sources?\b/i,
  /\bonline (?:research|sources?|references?)\b/i,
  /\bwhat'?s the latest (?:news|on|in)\b/i,
  /\blatest news (?:on|about|in)\b/i,
  /\bcurrent best practices?\b/i,
  /\bstate of the art\b/i,
  /\brecent (?:news|update)s?\b/i,
]

/**
 * True when the prompt explicitly asks for web research. Used by the Stop
 * research-mode gate instead of the priming workflow tag, so that loose
 * single-word matches in the priming regex (e.g. bare "latest") cannot
 * force a turn into a source-ledger requirement.
 *
 * Deliberately deny-by-default for short / common-English prompts.
 */
export const requiresWebSources = (rawPrompt: string): boolean => {
  const prompt = (rawPrompt ?? "").trim()
  if (prompt.length === 0) return false
  return WEB_SOURCES_REQUIRED.some((re) => re.test(prompt))
}

export const classifyPrompt = (rawPrompt: string): ClassifierResult => {
  const prompt = (rawPrompt ?? "").trim()
  if (prompt.length === 0) {
    return { workflow: "unknown", playbook: PLAYBOOKS.unknown }
  }
  for (const rule of RULES) {
    if (rule.pattern.test(prompt)) {
      return { workflow: rule.tag, playbook: PLAYBOOKS[rule.tag] }
    }
  }
  return { workflow: "unknown", playbook: PLAYBOOKS.unknown }
}
