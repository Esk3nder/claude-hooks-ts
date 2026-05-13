import { describe, expect, test } from "bun:test"
import {
  WORKER_CONTRACT_MARKER,
  appendWorkerContract,
  evaluateWorkerTaskPrompt,
  renderWorkerContract,
} from "../../src/policies/worker-contract.ts"

describe("worker task contract", () => {
  test("renderWorkerContract includes scope, output contract, and structured result keys", () => {
    const contract = renderWorkerContract("Explore")
    expect(contract).toContain(WORKER_CONTRACT_MARKER)
    expect(contract).toContain("read-only investigator")
    expect(contract).toContain("Output contract")
    expect(contract).toContain("files_relevant")
    expect(contract).toContain("strict JSON")
    expect(contract).toContain("diff_ref")
    expect(contract).toContain("orchestrator integration")
  })

  test("appendWorkerContract is idempotent", () => {
    const once = appendWorkerContract("Do the bounded task.", "Explore")
    const twice = appendWorkerContract(once, "Explore")
    expect(twice).toBe(once)
    expect(once.match(new RegExp(WORKER_CONTRACT_MARKER, "g"))?.length).toBe(1)
  })

  test("evaluateWorkerTaskPrompt rewrites Task prompt and preserves input keys", () => {
    const out = evaluateWorkerTaskPrompt("Task", {
      description: "inspect auth",
      prompt: "Find auth.",
      subagent_type: "Explore",
      extra: "kept",
    })
    expect(out.kind).toBe("rewrite")
    if (out.kind === "rewrite") {
      expect(out.updatedInput["extra"]).toBe("kept")
      expect(String(out.updatedInput["prompt"])).toContain(
        WORKER_CONTRACT_MARKER,
      )
    }
  })

  test("evaluateWorkerTaskPrompt accepts canonical agent_type as role hint", () => {
    const out = evaluateWorkerTaskPrompt("Agent", {
      description: "review patch",
      prompt: "Review this patch.",
      agent_type: "code-reviewer",
    })
    expect(out.kind).toBe("rewrite")
    if (out.kind === "rewrite") {
      expect(String(out.updatedInput["prompt"])).toContain("code-reviewer")
      expect(String(out.updatedInput["prompt"])).toContain("read-only")
    }
  })

  test("evaluateWorkerTaskPrompt passes through non-worker tools", () => {
    expect(evaluateWorkerTaskPrompt("Read", { file_path: "x" })).toEqual({
      kind: "passthrough",
    })
  })
})
