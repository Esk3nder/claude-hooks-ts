/** Speculative parallelism selector (BUILD-SPEC §10, resolves Q12). World-fact: winner = pinned replay exit 0. */
export interface SpecCandidate {
  agent_id: string
  replay_exit: number | null // null = did not run / could not replay
  changed_files: number
  finished_seq: number // earlier = smaller
}

export interface SpecOutcome {
  winner: string | null
  rejected: string[] // passed-selection losers
  soft_failed: string[] // never passed
}

/** Winner = passes replay (exit 0); ties broken by fewest changed_files then earliest finish. */
export function selectSpeculative(cands: SpecCandidate[]): SpecOutcome {
  const passed = cands.filter((c) => c.replay_exit === 0)
  if (passed.length === 0) {
    return { winner: null, rejected: [], soft_failed: cands.map((c) => c.agent_id) }
  }
  passed.sort((a, b) => a.changed_files - b.changed_files || a.finished_seq - b.finished_seq)
  const winner = passed[0]!.agent_id
  const rejected = cands.filter((c) => c.agent_id !== winner && c.replay_exit === 0).map((c) => c.agent_id)
  const soft = cands.filter((c) => c.replay_exit !== 0).map((c) => c.agent_id)
  return { winner, rejected, soft_failed: soft }
}
