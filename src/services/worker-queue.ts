import { Context, Effect, Layer, Queue, Stream } from "effect"
import * as path from "node:path"
import { EventStoreError } from "../schema/errors.ts"
import { eventStream, WorkerJobSchema, type WorkerJob } from "../schema/events.ts"
import { EventStore, redactForPersistence } from "./event-store.ts"
import { RuntimeConfigService } from "./runtime-config.ts"

export interface WorkerQueueApi {
  readonly offer: (job: WorkerJob) => Effect.Effect<void, EventStoreError>
  readonly take: Effect.Effect<WorkerJob>
  readonly stream: Stream.Stream<WorkerJob>
}

export class WorkerQueue extends Context.Tag("WorkerQueue")<WorkerQueue, WorkerQueueApi>() {}

const WORKER_PAYLOAD_KEYS = new Set(["payload"])

export const workerJobsStream = (root: string, queueName: string = "default") =>
  eventStream(
    `worker-jobs:${queueName}`,
    path.join(root, ".claude-hooks", "state", "workers", `${queueName}.jsonl`),
    WorkerJobSchema,
    {
      maxRecords: 1_000,
      redact: (job) => ({
        ...job,
        payload: redactForPersistence(job.payload, "payload", 0, { sensitiveKeys: WORKER_PAYLOAD_KEYS }),
      }),
    },
  )

export const WorkerQueueLive = (
  root: string = process.cwd(),
  queueName: string = "default",
  capacity?: number,
): Layer.Layer<WorkerQueue, never, EventStore | RuntimeConfigService> =>
  Layer.effect(
    WorkerQueue,
    Effect.gen(function* () {
      const resolvedCapacity = capacity === undefined
        ? yield* RuntimeConfigService.pipe(
            Effect.flatMap((config) => config.load()),
            Effect.map((config) => config.workerQueueCapacity),
          )
        : capacity
      const queue = yield* Queue.bounded<WorkerJob>(Math.max(1, Math.floor(resolvedCapacity)))
      const gate = yield* Effect.makeSemaphore(1)
      const store = yield* EventStore
      const stream = workerJobsStream(root, queueName)
      const offerError = (message: string) =>
        new EventStoreError({
          op: "worker-queue.offer",
          stream: stream.name,
          path: stream.path,
          message,
        })
      return WorkerQueue.of({
        offer: (job) =>
          gate.withPermits(1)(
            Effect.uninterruptible(
              Queue.isFull(queue).pipe(
                Effect.flatMap((full) =>
                  full
                    ? Effect.fail(offerError("worker queue is full"))
                    : store.append(stream, job).pipe(
                        Effect.zipRight(Queue.offer(queue, job)),
                        Effect.flatMap((offered) =>
                          offered
                            ? Effect.void
                            : Effect.fail(offerError("worker queue is shutdown")),
                        ),
                      ),
                ),
              ),
            ),
          ),
        take: Queue.take(queue),
        stream: Stream.fromQueue(queue),
      })
    }),
  )
