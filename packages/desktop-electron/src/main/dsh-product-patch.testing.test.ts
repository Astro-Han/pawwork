import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"

import { installedHarnessPackages } from "./dsh-product-patch.testing"

// pnpm leaves a store directory behind for every resolution a package has had, so a
// patch bump puts two copies of the same package in the store. A reader that walks the
// store can then name a copy nobody installed — and a test that reads it asserts
// against code the app will never run. The link farm under `node_modules` names the
// copy the workspace uses, which is why the resolver answers from there.
test("names the copy the link farm points at, not a superseded one", () => {
  const store = mkdtempSync(join(tmpdir(), "pawwork-store-"))
  try {
    const linked = join(store, "@deepseek-ai+dsh-example@1.0.0_patch_hash=new/node_modules/@deepseek-ai/dsh-example")
    const stale = join(store, "@deepseek-ai+dsh-example@1.0.0_patch_hash=old/node_modules/@deepseek-ai/dsh-example")
    for (const directory of [linked, stale]) {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "package.json"), "{}\n")
    }
    const farm = join(store, "node_modules", "@deepseek-ai")
    mkdirSync(farm, { recursive: true })
    symlinkSync(linked, join(farm, "dsh-example"), "dir")

    expect(installedHarnessPackages(store).get("@deepseek-ai/dsh-example")).toBe(join(farm, "dsh-example"))
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})
