import { describe, expect, test } from "bun:test"
import {
  shellQuote,
  splitShellWords,
} from "../../src/services/shell-words.ts"

describe("shellQuote / splitShellWords", () => {
  test("round-trips spaces and apostrophes in dispatcher paths", () => {
    const dispatcher = "/tmp/claude hooks/owner's bin/claude-hook"
    const command = `${shellQuote(dispatcher)} SessionStart`

    expect(splitShellWords(command)).toEqual([dispatcher, "SessionStart"])
  })

  test("keeps compatibility with unquoted existing hook commands", () => {
    expect(splitShellWords("/tmp/claude-hook Stop")).toEqual([
      "/tmp/claude-hook",
      "Stop",
    ])
  })
})
