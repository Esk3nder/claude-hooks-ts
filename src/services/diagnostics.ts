import { Effect, Logger } from "effect"

const trimTrailingNewline = (message: string): string =>
  message.endsWith("\n") ? message.slice(0, -1) : message

export const logWarning = (message: string): Effect.Effect<void> =>
  Effect.logWarning(trimTrailingNewline(message))

const SyncWarningLoggerLive = Logger.replace(
  Logger.defaultLogger,
  Logger.withConsoleError(Logger.logfmtLogger),
)

export const logWarningSync = (message: string): void => {
  Effect.runSync(logWarning(message).pipe(Effect.provide(SyncWarningLoggerLive)))
}
