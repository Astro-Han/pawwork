import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const workflowPath = path.resolve(import.meta.dir, "../../../../.github/workflows/e2e-artifacts.yml")

async function readWorkflow() {
  return await fs.readFile(workflowPath, "utf8")
}

describe("e2e artifacts workflow", () => {
  test("exists as a dedicated non-blocking PR diagnostics workflow", async () => {
    const workflow = await readWorkflow()

    expect(workflow).toContain("name: e2e-artifacts")
    expect(workflow).toContain("pull_request:")
    expect(workflow).toContain("branches: [dev]")
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("permissions:")
    expect(workflow).toContain("contents: read")
    expect(workflow).not.toContain("pull_request_target:")
    expect(workflow).not.toContain("/Users/yuhan/")
    expect(workflow).toContain("runs-on: ubuntu-latest")
    expect(workflow).toContain("continue-on-error: true")
    expect(workflow).toContain("persist-credentials: false")
    expect(workflow).toContain("bun install --frozen-lockfile")
    expect(workflow).toContain("bunx playwright install --with-deps chromium")
    expect(workflow).toContain("bun --cwd packages/app test:e2e:local")
    expect(workflow).toContain("if: always()")
    expect(workflow).toContain("actions/upload-artifact@v4")
    expect(workflow).toContain("retention-days: 7")
    expect(workflow).toContain("packages/app/e2e/playwright-report")
    expect(workflow).toContain("packages/app/e2e/test-results")
    expect(workflow).toContain("packages/app/e2e/junit-linux.xml")
  })
})
