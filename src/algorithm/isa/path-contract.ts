import { safeResolvePath } from "../../services/path-resolution.ts"
import { normalizeExpectedIsaPath } from "./tier-policy.ts"

export const resolveExpectedIsaAbsolute = (
  sessionRoot: string,
  record: {
    readonly expected_isa_path: string | null
    readonly expected_isa_path_absolute?: string | null
  },
): string | null => {
  const expectedRelative = normalizeExpectedIsaPath(record.expected_isa_path)
  if (expectedRelative === null) return null

  const relativeResolved = safeResolvePath(sessionRoot, expectedRelative)
  if (relativeResolved === null) return null

  const storedAbsolute =
    record.expected_isa_path_absolute === undefined ||
    record.expected_isa_path_absolute === null
      ? null
      : safeResolvePath(sessionRoot, record.expected_isa_path_absolute)

  return storedAbsolute === relativeResolved ? storedAbsolute : relativeResolved
}
