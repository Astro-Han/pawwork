import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parseWorkflow, readWorkflow } from "./workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "officecli-bump.yml")

describe("officecli bump workflow", () => {
  test("keeps the expected triggers, permissions, and pinned actions", () => {
    const workflow = readWorkflow(workflowPath)
    const parsed = parseWorkflow(workflowPath)
    const steps = parsed.jobs?.["officecli-bump"]?.steps ?? []
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const setupNode = steps.find((step) => step.uses?.startsWith("actions/setup-node@"))
    const setupBun = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
    const validateToken = steps.find((step) => step.name === "Validate bump pull request token")
    const createPr = steps.find((step) => step.name === "Create bump pull request")

    expect(parsed.name).toBe("officecli-bump")
    expect(parsed.on?.workflow_dispatch).toEqual({
      inputs: {
        dry_run: {
          default: true,
          description: "Validate the bump path without opening a pull request",
          required: false,
          type: "boolean",
        },
      },
    })
    expect(parsed.on?.schedule).toEqual([{ cron: "17 3 * * 1" }])
    expect(parsed.permissions).toEqual({
      contents: "read",
    })

    expect(checkout?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")
    expect(checkout?.with?.["persist-credentials"]).toBe(false)
    expect(setupNode?.uses).toBe("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e")
    expect(setupNode?.with).toEqual({ "node-version": "24" })
    expect(setupBun?.uses).toBe("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")
    expect(setupBun?.with).toEqual({ "bun-version": "1.3.13" })

    expect(workflow).not.toContain("persist-credentials: true")
    expect(workflow).toContain("gh api repos/iOfficeAI/OfficeCLI/releases/latest")
    expect(workflow).toContain("packages/desktop-electron/bundled-tools.json")
    expect(workflow).toContain(
      "bun packages/desktop-electron/scripts/prepare-officecli.ts --platform \"$platform\" --arch \"$arch\"",
    )
    expect(validateToken?.if).toBe(
      "${{ steps.versions.outputs.current_version != steps.versions.outputs.latest_version && inputs.dry_run != true }}",
    )
    expect(validateToken?.env?.OFFICECLI_BUMP_TOKEN).toBe("${{ secrets.OFFICECLI_BUMP_TOKEN }}")
    expect(validateToken?.run).toContain("Missing OFFICECLI_BUMP_TOKEN")
    expect(createPr?.env?.OFFICECLI_BUMP_TOKEN).toBe("${{ secrets.OFFICECLI_BUMP_TOKEN }}")
    expect(createPr?.env).not.toHaveProperty("GH_TOKEN")
    expect(workflow).toContain("Dry run requested; skipping branch push and PR creation.")
    expect(workflow).toContain("gh auth setup-git")
    expect(workflow).toContain('git ls-remote --exit-code --heads origin "$branch"')
    expect(workflow).toContain('git fetch origin "refs/heads/$branch:refs/remotes/origin/$branch"')
    expect(workflow).toContain('git push --force-with-lease=refs/heads/"$branch" --set-upstream origin "$branch"')
    expect(workflow).toContain(
      'existing_pr="$(gh pr list --state open --base dev --head "$branch" --json url --jq \'.[0].url // empty\')"',
    )
    expect(workflow).not.toContain('if existing_pr="$(gh pr list')
    expect(workflow).toContain("gh pr edit")
    expect(workflow).toContain("--add-label enhancement")
    expect(workflow).toContain("--add-label ci")
    expect(workflow).toContain("--add-label upstream")
    expect(workflow).toContain("--label enhancement")
    expect(workflow).toContain("--label ci")
    expect(workflow).toContain("--label upstream")
    expect(workflow).toContain("Follow-up to #330.")
    expect(workflow).not.toContain("Closes #330.")
  })
})
