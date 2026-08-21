import { readFileSync } from "node:fs"
import { join } from "node:path"
import { load } from "js-yaml"
import { describe, expect, test } from "vitest"

const root = join(import.meta.dirname, "..", "..", "..")
const workflow = load(
  readFileSync(join(root, ".github", "workflows", "deploy-site.yml"), "utf8"),
) as {
  jobs: {
    "build-and-deploy": {
      steps: Array<{ run?: string; uses?: string; if?: string; env?: Record<string, string> }>
    }
  }
}
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>
}

describe("site deploy workflow", () => {
  test("deploys with the locked workspace Wrangler only from main", () => {
    const steps = workflow.jobs["build-and-deploy"].steps
    const install = steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile")
    const deploy = steps.findIndex(
      (step) => step.run === "pnpm exec wrangler pages deploy site/dist --project-name=pawwork --branch=main",
    )

    expect(install).toBeGreaterThanOrEqual(0)
    expect(deploy).toBeGreaterThan(install)
    expect(packageJson.devDependencies?.wrangler).toMatch(/^\d+\.\d+\.\d+$/)
    expect(steps[deploy]).toMatchObject({
      if: "github.ref == 'refs/heads/main'",
      env: {
        CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
        CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
      },
    })
    expect(steps.some((step) => step.uses?.startsWith("cloudflare/wrangler-action@"))).toBe(false)
  })
})
