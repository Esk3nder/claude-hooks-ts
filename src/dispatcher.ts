import { Effect, Schema, Cause } from "effect"
import { BunRuntime } from "@effect/platform-bun"
import { HookPayload } from "./schema/payloads.ts"
import { SAFE_DEFAULT, type HookDecision } from "./schema/decisions.ts"
import { handleStub } from "./events/_stub.ts"
import { StdinParseError } from "./schema/errors.ts"

const readStdin = (): Effect.Effect<string> =>
  Effect.tryPromise({
    try: async () => {
      if (typeof Bun !== "undefined" && (Bun as { stdin?: unknown }).stdin) {
        return await (Bun as { stdin: { text: () => Promise<string> } }).stdin.text()
      }
      const chunks: Buffer[] = []
      return await new Promise<string>((resolve) => {
        process.stdin.on("data", (c: Buffer) => chunks.push(c))
        process.stdin.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        )
        process.stdin.on("error", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        )
      })
    },
    catch: () => new Error("stdin read failed"),
  }).pipe(Effect.catchAll(() => Effect.succeed("")))

const emit = (decision: HookDecision): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(JSON.stringify(decision))
  })

const parseJson = (raw: string): Effect.Effect<unknown, StdinParseError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new StdinParseError({ message: "stdin is not valid JSON", cause }),
  })

const decodePayload = Schema.decodeUnknown(HookPayload)

export const program = (argv: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const action = argv[2]
    if (!action) {
      yield* Effect.sync(() => { process.stderr.write("dispatcher: missing action argument" + "\n") })
      yield* emit(SAFE_DEFAULT)
      return
    }
    const raw = yield* readStdin()
    if (raw.trim().length === 0) {
      yield* emit(SAFE_DEFAULT)
      return
    }
    const parsedE = yield* Effect.either(parseJson(raw))
    if (parsedE._tag === "Left") {
      yield* Effect.sync(() => { process.stderr.write(`dispatcher: ${parsedE.left.message}` + "\n") })
      yield* emit(SAFE_DEFAULT)
      return
    }
    const decodedE = yield* Effect.either(decodePayload(parsedE.right))
    if (decodedE._tag === "Left") {
      yield* Effect.sync(() => { process.stderr.write("dispatcher: payload schema decode failed" + "\n") })
      yield* emit(SAFE_DEFAULT)
      return
    }
    const decision = yield* handleStub(action, decodedE.right)
    yield* emit(decision)
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          process.stderr.write(
            "dispatcher: uncaught cause: " + Cause.pretty(cause) + "\n",
          )
        })
        yield* emit(SAFE_DEFAULT)
      }),
    ),
  )

if (import.meta.main) {
  BunRuntime.runMain(program(process.argv))
}
