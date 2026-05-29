import { describe, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseWorkflow } from "./workflow-parser"

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url))
const workflowsRoot = path.join(repoRoot, ".github", "workflows")

const pinned = {
  checkout: "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
  dependencyReview: "actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294",
  setupBun: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  setupNode: "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
}

describe("dependency review workflow", () => {
  test("uses the required dependency-review check name and fails high runtime advisories", () => {
    const parsed = parseWorkflow(path.join(workflowsRoot, "dependency-review.yml"))
    const job = parsed.jobs?.["dependency-review"]
    const steps = job?.steps ?? []
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const review = steps.find((step) => step.uses?.startsWith("actions/dependency-review-action@"))

    expect(parsed.name).toBe("dependency-review")
    expect(parsed.permissions).toEqual({ contents: "read", "pull-requests": "read" })
    expect(Object.keys(parsed.jobs ?? {})).toEqual(["dependency-review"])
    expect(job?.["runs-on"]).toBe("ubuntu-latest")
    expect(job?.["timeout-minutes"]).toBe(10)
    expect(checkout?.uses).toBe(pinned.checkout)
    expect(checkout?.with?.["persist-credentials"]).toBe(false)
    expect(review?.uses).toBe(pinned.dependencyReview)
    expect(review?.with).toEqual({
      "comment-summary-in-pr": "never",
      "fail-on-scopes": "runtime,unknown",
      "fail-on-severity": "high",
    })
  })

  test("runs the dev dependency audit check on every pull request", () => {
    const parsed = parseWorkflow(path.join(workflowsRoot, "dev-dep-audit.yml"))
    const job = parsed.jobs?.["dev-dep-audit"]
    const steps = job?.steps ?? []
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const setupNode = steps.find((step) => step.uses?.startsWith("actions/setup-node@"))
    const setupBun = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
    const install = steps.find((step) => step.name === "Install dependencies")
    const audit = steps.find((step) => step.name === "Run Bun audit")

    expect(parsed.name).toBe("dev-dep-audit")
    expect(parsed.on?.pull_request).toEqual({ branches: ["dev"] })
    expect(parsed.permissions).toEqual({ contents: "read" })
    expect(Object.keys(parsed.jobs ?? {})).toEqual(["dev-dep-audit"])
    expect(job?.["runs-on"]).toBe("ubuntu-latest")
    expect(job?.["timeout-minutes"]).toBe(10)
    expect(checkout?.uses).toBe(pinned.checkout)
    expect(checkout?.with?.["persist-credentials"]).toBe(false)
    expect(setupNode?.uses).toBe(pinned.setupNode)
    expect(setupNode?.with).toEqual({ "node-version": "24" })
    expect(setupBun?.uses).toBe(pinned.setupBun)
    expect(setupBun?.with).toEqual({ "bun-version": "1.3.14" })
    expect(install?.run).toBe("bun install --frozen-lockfile")
    expect(audit?.run).toBe("bun audit --audit-level=high")
  })
})
