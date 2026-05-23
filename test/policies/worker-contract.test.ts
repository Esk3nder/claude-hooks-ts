import { describe, expect, test } from "bun:test"
import {
  CURRENT_WORKER_CONTRACT_HASH,
  CURRENT_WORKER_CONTRACT_VERSION,
  WORKER_CONTRACT_END_MARKER,
  WORKER_CONTRACT_MARKER,
  appendWorkerContract,
  evaluateWorkerTaskPrompt,
  hasCurrentWorkerContract,
  parseWorkerContractMetadata,
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

  test("renderWorkerContract includes the canonical contract version and hash", () => {
    const contract = renderWorkerContract("Explore")
    expect(CURRENT_WORKER_CONTRACT_VERSION).toBe("1")
    expect(CURRENT_WORKER_CONTRACT_HASH).toBe("1d8d23104a3b6936")
    expect(contract).toContain(`Contract version: ${CURRENT_WORKER_CONTRACT_VERSION}`)
    expect(contract).toContain(`Contract hash: ${CURRENT_WORKER_CONTRACT_HASH}`)
  })

  test("parses current contract metadata only from complete contract blocks", () => {
    const contract = renderWorkerContract("Explore")

    expect(parseWorkerContractMetadata(contract)).toEqual({
      contract_version: CURRENT_WORKER_CONTRACT_VERSION,
      contract_hash: CURRENT_WORKER_CONTRACT_HASH,
    })
    expect(hasCurrentWorkerContract(contract)).toBe(true)
    expect(parseWorkerContractMetadata("Do the bounded task.")).toBeNull()
    expect(hasCurrentWorkerContract("Do the bounded task.")).toBe(false)
    expect(
      hasCurrentWorkerContract(
        contract.replace(
          `Contract hash: ${CURRENT_WORKER_CONTRACT_HASH}`,
          "Contract hash: stale-hash",
        ),
      ),
    ).toBe(false)
    expect(
      parseWorkerContractMetadata(
        contract.replace(`\n${WORKER_CONTRACT_END_MARKER}`, ""),
      ),
    ).toBeNull()
  })

  test("appendWorkerContract is idempotent", () => {
    const once = appendWorkerContract("Do the bounded task.", "Explore")
    const twice = appendWorkerContract(once, "Explore")
    expect(twice).toBe(once)
    expect(once.match(new RegExp(WORKER_CONTRACT_MARKER, "g"))?.length).toBe(1)
  })

  test("appendWorkerContract replaces stale marker-only contracts with current metadata", () => {
    const stale = [
      "Do the bounded task.",
      "",
      WORKER_CONTRACT_MARKER,
      "contract already here",
      "</claude-hooks-worker-contract>",
    ].join("\n")

    const updated = appendWorkerContract(stale, "Explore")

    expect(updated.match(new RegExp(WORKER_CONTRACT_MARKER, "g"))?.length).toBe(1)
    expect(updated).toContain(`Contract version: ${CURRENT_WORKER_CONTRACT_VERSION}`)
    expect(updated).toContain(`Contract hash: ${CURRENT_WORKER_CONTRACT_HASH}`)
    expect(updated).not.toContain("contract already here")
  })

  test("appendWorkerContract preserves trailing task text after an unterminated marker", () => {
    const malformed = [
      "Do the bounded task.",
      "",
      WORKER_CONTRACT_MARKER,
      "Trailing user instruction that must survive.",
    ].join("\n")

    const updated = appendWorkerContract(malformed, "Explore")
    const inlineUpdated = appendWorkerContract(
      `Do the bounded task. ${WORKER_CONTRACT_MARKER} inline instruction survives.`,
      "Explore",
    )

    expect(updated).toContain(`Contract version: ${CURRENT_WORKER_CONTRACT_VERSION}`)
    expect(updated).toContain(`Contract hash: ${CURRENT_WORKER_CONTRACT_HASH}`)
    expect(updated).toContain("Trailing user instruction that must survive.")
    expect(inlineUpdated).toContain("inline instruction survives.")
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
