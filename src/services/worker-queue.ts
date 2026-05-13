import { Context, Effect, Layer, Queue, Ref, Schema, Stream } from "effect"
import * as crypto from "node:crypto"
import * as path from "node:path"
import { EventStoreError } from "../schema/errors.ts"
import {
  eventStream,
  WorkerJobClaimSchema,
  WorkerJobSchema,
  type WorkerJob,
  type WorkerJobClaim,
} from "../schema/events.ts"
import { WorkerJobPayload } from "../schema/worker-run.ts"
import { collectStream, containsRedactedPersistenceMarker, EventStore, redactForPersistence } from "./event-store.ts"
import { durationMillis, RuntimeConfigService } from "./runtime-config.ts"
import { logWarning } from "./diagnostics.ts"
import { DEFAULT_POLICY } from "./policy-config.ts"

export interface WorkerQueueApi {
  readonly offer: (job: WorkerJob) => Effect.Effect<void, EventStoreError>
  readonly take: Effect.Effect<WorkerJob, EventStoreError>
  readonly complete: (jobId: string) => Effect.Effect<void, EventStoreError>
  readonly stream: Stream.Stream<WorkerJob, EventStoreError>
}

export class WorkerQueue extends Context.Tag("WorkerQueue")<WorkerQueue, WorkerQueueApi>() {}

const WORKER_PAYLOAD_KEYS = new Set([
  "tool_input",
  "toolinput",
  "prompt",
  "prompttext",
  "elicitation",
  "content",
])
const RAW_PAYLOAD_KEYS = new Set(["payload"])
const JOB_RECORD_LIMIT = 1_000
const CLAIM_RECORD_LIMIT = JOB_RECORD_LIMIT * 4
const MAX_PROMPT_SECRET_SCAN_CHARS = 64_000

const secretValuePatterns = DEFAULT_POLICY.secretValuePatterns.map(
  (pattern) =>
    new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    ),
)

const hashPrompt = (prompt: string): string =>
  crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16)

const sanitizeReplayablePrompt = (prompt: string): string => {
  let scanned = prompt.slice(0, MAX_PROMPT_SECRET_SCAN_CHARS)
  let secretRedacted = false
  for (const pattern of secretValuePatterns) {
    pattern.lastIndex = 0
    const next = scanned.replace(pattern, "[REDACTED]")
    if (next !== scanned) secretRedacted = true
    scanned = next
  }
  const bytes = Buffer.byteLength(prompt, "utf8")
  return [
    "[redacted worker prompt",
    `sha256=${hashPrompt(prompt)}`,
    `bytes=${bytes}`,
    `chars=${prompt.length}`,
    secretRedacted ? "secret_redacted=true" : "",
    "]",
  ].filter((part) => part.length > 0).join(" ")
}

const sanitizeWorkerPayload = (payload: unknown): unknown => {
  if (typeof payload === "string") {
    return redactForPersistence(payload, "payload", 0, { sensitiveKeys: RAW_PAYLOAD_KEYS })
  }
  const decoded = Schema.decodeUnknownEither(WorkerJobPayload)(payload)
  if (decoded._tag === "Right") {
    return {
      ...decoded.right,
      prompt: sanitizeReplayablePrompt(decoded.right.prompt),
      prompt_hash: decoded.right.prompt_hash ?? hashPrompt(decoded.right.prompt),
      prompt_redacted: true,
    }
  }
  return redactForPersistence(payload, undefined, 0, { sensitiveKeys: WORKER_PAYLOAD_KEYS })
}

export const workerJobsStream = (root: string, queueName: string = "default") =>
  eventStream(
    `worker-jobs:${queueName}`,
    path.join(root, ".claude-hooks", "state", "workers", `${queueName}.jsonl`),
    WorkerJobSchema,
    {
      maxRecords: JOB_RECORD_LIMIT,
      maxLineBytes: 256 * 1024,
      strictTail: true,
      redact: (job) => ({
        ...job,
        payload: sanitizeWorkerPayload(job.payload),
      }),
    },
  )

export const workerJobClaimsStream = (root: string, queueName: string = "default") =>
  eventStream(
    `worker-job-claims:${queueName}`,
    path.join(root, ".claude-hooks", "state", "workers", `${queueName}.claims.jsonl`),
    WorkerJobClaimSchema,
    { maxRecords: CLAIM_RECORD_LIMIT, maxTailBytes: 4 * 1024 * 1024, strictTail: true },
  )

const replayableJob = (job: WorkerJob): boolean =>
  Schema.decodeUnknownEither(WorkerJobSchema)(job)._tag === "Right" && !containsRedactedPersistenceMarker(job.payload)

const queueWarning = (message: string): Effect.Effect<void> =>
  logWarning(`[worker-queue] ${message}`)

const readLedger = <A>(
  label: string,
  effect: Effect.Effect<ReadonlyArray<A>, EventStoreError>,
): Effect.Effect<{
  readonly records: ReadonlyArray<A>
  readonly failed: boolean
  readonly message?: string
}> =>
  effect.pipe(
    Effect.map((records) => ({ records, failed: false as const })),
    Effect.catchAll((cause) =>
      queueWarning(`${label} read failed; starting from in-memory queue only: ${cause.message}`).pipe(
        Effect.as({ records: [] as ReadonlyArray<A>, failed: true as const, message: cause.message }),
      ),
    ),
  )

const latestClaimState = (
  claims: ReadonlyArray<WorkerJobClaim>,
  now: number,
  defaultLeaseMs: number,
): {
  readonly completed: ReadonlySet<string>
  readonly leased: ReadonlyMap<string, number>
  readonly stale: ReadonlySet<string>
} => {
  const completed = new Set<string>()
  const leased = new Map<string, number>()
  for (const claim of claims) {
    if (claim.completedAt !== undefined) {
      completed.add(claim.id)
      leased.delete(claim.id)
      continue
    }
    if (completed.has(claim.id)) continue
    const leaseUntil = claim.leaseUntil ?? claim.claimedAt + defaultLeaseMs
    leased.set(claim.id, Math.max(leased.get(claim.id) ?? 0, leaseUntil))
  }
  const stale = new Set(
    [...leased.entries()]
      .filter(([, leaseUntil]) => leaseUntil <= now)
      .map(([id]) => id),
  )
  return { completed, leased, stale }
}

const positiveInt = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback

const jobLeaseMs = (job: WorkerJob, defaultMs: number, defaultMaxAttempts: number): number => {
  const decoded = Schema.decodeUnknownEither(WorkerJobPayload)(job.payload)
  const requested = decoded._tag === "Right" ? decoded.right.timeout_ms : undefined
  const requestedAttempts = decoded._tag === "Right" ? decoded.right.max_attempts : undefined
  const timeoutMs = typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? requested
    : defaultMs
  const maxAttempts = positiveInt(requestedAttempts, defaultMaxAttempts)
  return Math.max(timeoutMs * maxAttempts + 60_000, 60_000)
}

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
      const runtimeConfig = yield* RuntimeConfigService.pipe(Effect.flatMap((config) => config.load()))
      const defaultLeaseMs = durationMillis(runtimeConfig.workerDefaultTimeoutMs)
      const defaultMaxAttempts = Math.max(1, runtimeConfig.workerRetryLimit + 1)
      const queue = yield* Queue.bounded<WorkerJob>(Math.max(1, Math.floor(resolvedCapacity)))
      const gate = yield* Effect.makeSemaphore(1)
      const store = yield* EventStore
      const stream = workerJobsStream(root, queueName)
      const claims = workerJobClaimsStream(root, queueName)
      const offerError = (message: string) =>
        new EventStoreError({
          op: "worker-queue.offer",
          stream: stream.name,
          path: stream.path,
          message,
        })
      const claimError = (message: string, cause?: unknown) =>
        new EventStoreError({
          op: "worker-queue.take",
          stream: claims.name,
          path: claims.path,
          message,
          ...(cause === undefined ? {} : { cause }),
        })
      const startupError = (message: string) =>
        new EventStoreError({
          op: "worker-queue.recover",
          stream: stream.name,
          path: stream.path,
          message,
        })
      const now = Date.now()
      const claimRead = yield* readLedger("claim ledger", collectStream(store.tail(claims, CLAIM_RECORD_LIMIT)))
      const claimState = latestClaimState(
        claimRead.records,
        now,
        defaultLeaseMs,
      )
      const jobRead = yield* readLedger("job ledger", collectStream(store.tail(stream, Math.max(resolvedCapacity, JOB_RECORD_LIMIT))))
      const activePersistedJobs = jobRead.records
        .filter((job) => job.queue === queueName)
        .filter((job) =>
          !claimState.completed.has(job.id) &&
          (!claimState.leased.has(job.id) || claimState.stale.has(job.id)),
        )
      const unreplayableJobs = activePersistedJobs.filter((job) => !replayableJob(job))
      const cleanupFailures: string[] = []
      if (unreplayableJobs.length > 0) {
        yield* queueWarning(
          `dropping unreplayable redacted worker job(s): ${unreplayableJobs.map((job) => job.id).join(",")}`,
        )
        for (const job of unreplayableJobs) {
          const cleanup = yield* store.append(claims, {
            id: job.id,
            queue: job.queue,
            claimedAt: now,
            completedAt: now,
          }).pipe(Effect.either)
          if (cleanup._tag === "Left") cleanupFailures.push(cleanup.left.message)
        }
      }
      const startupFailure =
        claimRead.failed || jobRead.failed || cleanupFailures.length > 0
          ? startupError(
              [
                claimRead.failed ? `claim ledger: ${claimRead.message ?? "read failed"}` : "",
                jobRead.failed ? `job ledger: ${jobRead.message ?? "read failed"}` : "",
                cleanupFailures.length > 0 ? `unreplayable cleanup: ${cleanupFailures.join("; ")}` : "",
              ].filter((part) => part.length > 0).join("; "),
            )
          : null
      const replayablePersistedJobs = activePersistedJobs
        .filter(replayableJob)
      const replayed = replayablePersistedJobs.slice(0, resolvedCapacity)
      const replayBacklog = yield* Ref.make<ReadonlyArray<WorkerJob>>(
        replayablePersistedJobs.slice(resolvedCapacity),
      )
      for (const job of replayed) {
        yield* Queue.offer(queue, job)
      }
      const refillReplayBacklog = Effect.gen(function* () {
        const next = yield* Ref.modify(replayBacklog, (jobs) => {
          const [head, ...tail] = jobs
          return [head, tail] as const
        })
        if (next === undefined) return
        const full = yield* Queue.isFull(queue)
        if (full) {
          yield* Ref.update(replayBacklog, (jobs) => [next, ...jobs])
          return
        }
        const offered = yield* Queue.offer(queue, next)
        if (!offered) {
          yield* Ref.update(replayBacklog, (jobs) => [next, ...jobs])
        }
      })
      const ensureRecovered = startupFailure === null
        ? Effect.void
        : Effect.fail(startupFailure)
      const activePersistedJobCount = Effect.gen(function* () {
        const activeClaimState = latestClaimState(
          yield* collectStream(store.tail(claims, CLAIM_RECORD_LIMIT)),
          Date.now(),
          defaultLeaseMs,
        )
        const jobs = yield* collectStream(store.tail(stream, Math.max(resolvedCapacity, JOB_RECORD_LIMIT)))
        const active = new Set<string>()
        for (const job of jobs) {
          if (job.queue !== queueName) continue
          if (activeClaimState.completed.has(job.id)) continue
          if (!replayableJob(job)) continue
          active.add(job.id)
        }
        return active.size
      })
      const take = ensureRecovered.pipe(Effect.zipRight(Queue.take(queue))).pipe(
        Effect.flatMap((job) =>
              store.append(claims, {
                id: job.id,
                queue: job.queue,
                claimedAt: Date.now(),
                leaseUntil: Date.now() + jobLeaseMs(job, defaultLeaseMs, defaultMaxAttempts),
              }).pipe(
                Effect.zipRight(refillReplayBacklog),
                Effect.as(job),
            Effect.catchAll((cause) =>
              Queue.offer(queue, job).pipe(
                Effect.catchAll(() => Effect.void),
                Effect.zipRight(Effect.fail(claimError("failed to claim worker job", cause))),
              ),
            ),
          ),
        ),
      )
      const complete = (jobId: string) =>
        store.append(claims, {
          id: jobId,
          queue: queueName,
          claimedAt: Date.now(),
          completedAt: Date.now(),
        })
      return WorkerQueue.of({
        offer: (job) =>
          gate.withPermits(1)(
            Effect.uninterruptible(
              ensureRecovered.pipe(
                Effect.zipRight(
                  job.queue !== queueName
                    ? Effect.fail(offerError(`worker job queue mismatch: expected ${queueName}, got ${job.queue}`))
                    : activePersistedJobCount,
                ),
                Effect.flatMap((activeCount) =>
                  activeCount >= resolvedCapacity
                    ? Effect.fail(offerError("worker queue is full"))
                    : Queue.isFull(queue),
                ),
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
        take,
        complete,
        stream: Stream.repeatEffect(take),
      })
    }),
  )
