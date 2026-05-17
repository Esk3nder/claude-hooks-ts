import { Data } from "effect"

export class StdinParseError extends Data.TaggedError("StdinParseError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class FsError extends Data.TaggedError("FsError")<{
  readonly op: string
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class ShellError extends Data.TaggedError("ShellError")<{
  readonly command: string
  readonly exitCode: number
  readonly stderr: string
  readonly message: string
}> {}

export class GitError extends Data.TaggedError("GitError")<{
  readonly op: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class PolicyConfigError extends Data.TaggedError("PolicyConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class LedgerError extends Data.TaggedError("LedgerError")<{
  readonly op: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class EventStoreError extends Data.TaggedError("EventStoreError")<{
  readonly op: string
  readonly stream: string
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class WorkerRunError extends Data.TaggedError("WorkerRunError")<{
  readonly op: string
  readonly workerId?: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class HandlerError extends Data.TaggedError("HandlerError")<{
  readonly handler: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class BrandValidationError extends Data.TaggedError("BrandValidationError")<{
  readonly brand: string
  readonly input: string
  readonly reason: string
}> {}
