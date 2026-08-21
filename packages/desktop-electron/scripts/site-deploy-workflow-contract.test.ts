import { readFileSync } from "node:fs"
import { join } from "node:path"
import { JSON_SCHEMA, load } from "js-yaml"
import { describe, expect, test } from "vitest"

const root = join(import.meta.dirname, "..", "..", "..")
const workflow = load(
  readFileSync(join(root, ".github", "workflows", "deploy-site.yml"), "utf8"),
  { schema: JSON_SCHEMA },
) as {
  on: {
    push: { paths: string[] }
    pull_request: { paths: string[] }
  }
  jobs: {
    "build-and-deploy": {
      steps: Array<{ run?: string; uses?: string; with?: { wranglerVersion?: string } }>
    }
  }
}
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>
}

describe("site deploy workflow", () => {
  test("uses the workspace's preinstalled Wrangler before the deploy action", () => {
    const steps = workflow.jobs["build-and-deploy"].steps
    const install = steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile")
    const deploy = steps.findIndex((step) => step.uses?.startsWith("cloudflare/wrangler-action@"))

    expect(install).toBeGreaterThanOrEqual(0)
    expect(deploy).toBeGreaterThan(install)
    expect(packageJson.devDependencies?.wrangler).toMatch(/^\d+\.\d+\.\d+$/)
    expect(steps[deploy]?.with?.wranglerVersion).toBeUndefined()
  })

  test("build-checks every file that controls the site deployment", () => {
    const deploymentInputs = [
      ".github/workflows/deploy-site.yml",
      "package.json",
      "site/**",
    ]

    expect(workflow.on.push.paths).toEqual(deploymentInputs)
    expect(workflow.on.pull_request.paths).toEqual(deploymentInputs)
  })
})
