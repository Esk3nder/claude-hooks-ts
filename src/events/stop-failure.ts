import { Effect } from "effect";
import * as path from "node:path";
import type { HookPayload } from "../schema/payloads.ts";
import type { HookDecision } from "../schema/decisions.ts";
import { SAFE_DEFAULT } from "../schema/decisions.ts";
import { FileSystem } from "../services/filesystem.ts";
import { Project } from "../services/project.ts";

interface StopFailureLedgerEntry {
  readonly session_id: string;
  readonly error_type: string;
  readonly error_message: string;
  readonly ts: string;
}

/**
 * StopFailure — appends to <cwd>/.claude-hooks/state/failures.jsonl.
 * Best-effort, returns SAFE_DEFAULT. The read-modify-write block is
 * wrapped in `FileSystem.withLock` to prevent concurrent dispatcher
 * processes from interleaving partial JSON lines.
 */
export const handleStopFailure = (
  payload: HookPayload,
): Effect.Effect<HookDecision, never, FileSystem | Project> =>
  Effect.gen(function* () {
    if (payload._tag !== "StopFailure") return SAFE_DEFAULT;
    const fs = yield* FileSystem;
    const project = yield* Project;
    const root = yield* project.root();
    const ledgerPath = path.join(
      root,
      ".claude-hooks",
      "state",
      "failures.jsonl",
    );
    const entry: StopFailureLedgerEntry = {
      session_id: payload.session_id,
      error_type: payload.error_type,
      error_message: payload.error_message,
      ts: new Date().toISOString(),
    };
    const append = Effect.gen(function* () {
      const existsE = yield* Effect.either(fs.exists(ledgerPath));
      const prior =
        existsE._tag === "Right" && existsE.right
          ? yield* fs
              .readFile(ledgerPath)
              .pipe(Effect.catchAll(() => Effect.succeed("")))
          : "";
      const next =
        (prior.length === 0 || prior.endsWith("\n") ? prior : prior + "\n") +
        JSON.stringify(entry) +
        "\n";
      yield* fs.writeFile(ledgerPath, next);
    });
    yield* fs
      .withLock(ledgerPath, append)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    return SAFE_DEFAULT;
  });
