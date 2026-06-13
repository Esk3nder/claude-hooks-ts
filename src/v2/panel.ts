/** Skeptic panel verdict (BUILD-SPEC §7). Pure: majority refute ⇒ refuted; gates the orchestrator's judgment, never a spine flip. */
export type SkVerdict = "confirmed" | "refuted" | "inconclusive"

export interface PanelMember { lens: string; verdict: SkVerdict }
export interface PanelOutcome { verdict: SkVerdict; refuters: number; dissent: PanelMember[] }

export function panelVerdict(members: PanelMember[], majority: number): PanelOutcome {
  const refuters = members.filter((m) => m.verdict === "refuted").length
  if (refuters >= majority) {
    return { verdict: "refuted", refuters, dissent: members.filter((m) => m.verdict !== "refuted") }
  }
  const nonInconclusive = members.filter((m) => m.verdict !== "inconclusive")
  if (nonInconclusive.length > 0 && nonInconclusive.every((m) => m.verdict === "confirmed")) {
    return { verdict: "confirmed", refuters, dissent: members.filter((m) => m.verdict !== "confirmed") }
  }
  return { verdict: "inconclusive", refuters, dissent: members.filter((m) => m.verdict === "refuted") }
}
