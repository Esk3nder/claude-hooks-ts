import { Effect, Layer } from "effect"
import { makeAppLive } from "../../../src/layers/live.ts"
import { WorkerRuns, scopedWorkerRunId } from "../../../src/services/worker-runs.ts"

const root = process.cwd()
const sessionId = "pr46-live-subagent-stop"
const agentId = "agent-write-no-patch"
const workerId = scopedWorkerRunId(sessionId, agentId)

const program = Effect.gen(function* () {
  const runs = yield* WorkerRuns
  const existing = yield* runs.get(workerId)
  if (existing === null) {
    yield* runs.createQueued({
      worker_id: workerId,
      session_id: sessionId,
      agent_id: agentId,
      agent_type: "general-purpose",
      mode: "write-allowed",
      prompt_hash: "pr46livesubagentstopnopatch",
      scope: "",
    })
  }
  yield* runs.markRunning(workerId)
  const after = yield* runs.get(workerId)
  console.log(JSON.stringify(after))
})

await Effect.runPromise(program.pipe(Effect.provide(makeAppLive(root))) as Effect.Effect<void>)
