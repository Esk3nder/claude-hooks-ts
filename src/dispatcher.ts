import { Effect } from "effect"

const program = Effect.sync(() => {
  process.stderr.write("claude-hooks-ts dispatcher — not yet implemented\n")
  return 0 as const
})

const exitCode = Effect.runSync(program)
process.exit(exitCode)
