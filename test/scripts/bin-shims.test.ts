/**
 * P0-2 — Shape pins for `bin/*` cross-platform Node shims.
 *
 * The shims replaced the prior bash versions so Windows installs work
 * without WSL/Git-Bash. These tests pin: (1) every shim starts with
 * `#!/usr/bin/env node`, (2) the file parses as valid JS, (3) the shim
 * declares its TARGET path and PROGRAM name (the only per-shim deltas).
 *
 * Why: a future refactor could re-bash one of these without breaking
 * macOS/Linux CI, silently re-introducing the Windows install gap.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..", "..")

interface ShimSpec {
  readonly file: string
  readonly target: string
  readonly program: string
}

const SHIMS: ReadonlyArray<ShimSpec> = [
  { file: "bin/claude-hook", target: "../src/dispatcher.ts", program: "claude-hook" },
  { file: "bin/claude-hooks-install", target: "../scripts/install.ts", program: "claude-hooks-install" },
  { file: "bin/claude-hooks-init", target: "../scripts/init.ts", program: "claude-hooks-init" },
  { file: "bin/claude-hooks-doctor", target: "../scripts/doctor.ts", program: "claude-hooks-doctor" },
  { file: "bin/claude-hooks-tail", target: "../scripts/tail.ts", program: "claude-hooks-tail" },
  { file: "bin/claude-hooks-workers", target: "../scripts/workers.ts", program: "claude-hooks-workers" },
]

describe("bin/* shims are cross-platform Node (P0-2)", () => {
  for (const spec of SHIMS) {
    test(`${spec.file} starts with #!/usr/bin/env node`, () => {
      const body = readFileSync(resolve(REPO_ROOT, spec.file), "utf8")
      expect(body.split("\n")[0]).toBe("#!/usr/bin/env node")
    })

    test(`${spec.file} declares TARGET = "${spec.target}"`, () => {
      const body = readFileSync(resolve(REPO_ROOT, spec.file), "utf8")
      expect(body).toContain(`const TARGET = "${spec.target}"`)
    })

    test(`${spec.file} declares PROGRAM = "${spec.program}"`, () => {
      const body = readFileSync(resolve(REPO_ROOT, spec.file), "utf8")
      expect(body).toContain(`const PROGRAM = "${spec.program}"`)
    })

    test(`${spec.file} contains cross-platform bun-finder`, () => {
      const body = readFileSync(resolve(REPO_ROOT, spec.file), "utf8")
      // The four probe surfaces that make this shim work on macOS,
      // Linux, and Windows. Any future refactor that drops one of
      // these breaks a platform — this test pins the contract.
      expect(body).toContain("env.BUN")
      expect(body).toContain("env.HOME")
      expect(body).toContain("env.USERPROFILE")
      expect(body).toContain("where")
      expect(body).toContain("which")
    })
  }

  test("no shim references bash idioms (set -e, $HOME, exec, readlink)", () => {
    // Pin the regression. If any future change reintroduces a bash
    // shim, this test catches it without needing Windows CI.
    for (const { file } of SHIMS) {
      const body = readFileSync(resolve(REPO_ROOT, file), "utf8")
      expect(body).not.toContain("set -e")
      expect(body).not.toContain("readlink")
      // `$HOME` is referenced inside the bun lookup path string — only
      // catch the bash-y `"$HOME"` form, not the `env.HOME` JS access.
      expect(body).not.toContain('"$HOME"')
    }
  })
})
