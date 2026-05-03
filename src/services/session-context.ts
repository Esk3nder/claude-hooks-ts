import { Effect, FiberRef } from "effect"

/**
 * Fiber-local current session id.
 *
 * Set at the dispatcher entry point via {@link withSession}; handlers and
 * services can call {@link getCurrentSession} to retrieve it without
 * threading the id through every function signature.
 */
export const currentSessionId: FiberRef.FiberRef<string | null> =
  FiberRef.unsafeMake<string | null>(null)

export const withSession = <A, E, R>(
  sessionId: string,
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.locally(currentSessionId, sessionId)(eff)

export const getCurrentSession = (): Effect.Effect<string | null> =>
  FiberRef.get(currentSessionId)
