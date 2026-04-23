import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { closeSettingsPanel, openSettings, withSession } from "../actions"
import { promptModelSelector, promptSelector, promptVariantSelector } from "../selectors"

const isBash = (part: unknown): part is ToolPart => {
  if (!part || typeof part !== "object") return false
  if (!("type" in part) || part.type !== "tool") return false
  if (!("tool" in part) || part.tool !== "bash") return false
  return "state" in part
}

function capturePageErrors(page: Page) {
  const pageErrors: string[] = []
  const onPageError = (err: Error & { name?: string }) => {
    const detail = [err.name, err.message, err.stack, String(err)].filter(Boolean).join("\n")
    pageErrors.push(detail)
  }
  page.on("pageerror", onPageError)
  return {
    pageErrors,
    dispose: () => page.off("pageerror", onPageError),
  }
}

test("shell mode runs a command in the project directory", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const cmd = process.platform === "win32" ? "dir" : "command ls"

  await withSession(project.sdk, `e2e shell ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)
    const dialog = await openSettings(page)
    const toggle = dialog.locator('[data-action="settings-auto-accept-permissions"]').first()
    const input = toggle.locator('[data-slot="switch-input"]').first()
    await expect(toggle).toBeVisible()
    if ((await input.getAttribute("aria-checked")) !== "true") {
      await toggle.locator('[data-slot="switch-control"]').click()
      await expect(input).toHaveAttribute("aria-checked", "true")
    }
    await closeSettingsPanel(page, dialog)
    await project.shell(cmd)

    await expect
      .poll(
        async () => {
          const list = await project.sdk.session
            .messages({ sessionID: session.id, limit: 50 })
            .then((x) => x.data ?? [])
          const msg = list.findLast(
            (item) => item.info.role === "assistant" && "path" in item.info && item.info.path.cwd === project.directory,
          )
          if (!msg) return

          const part = msg.parts
            .filter(isBash)
            .find((item) => item.state.input?.command === cmd && item.state.status === "completed")

          if (!part || part.state.status !== "completed") return
          const output =
            typeof part.state.metadata?.output === "string" ? part.state.metadata.output : part.state.output
          if (!output.includes("README.md")) return

          return { cwd: project.directory, output }
        },
        { timeout: 90_000 },
      )
      .toEqual(expect.objectContaining({ cwd: project.directory, output: expect.stringContaining("README.md") }))
  })
})

test("shell mode renders command failures without crashing the renderer", async ({ page, project }) => {
  test.setTimeout(120_000)

  const errors = capturePageErrors(page)
  const COMMAND = "definitely-not-a-command-171 --help"
  const COMMAND_FAILURE_PATTERN = /command not found|is not recognized/i

  try {
    await project.open()

    await withSession(project.sdk, `e2e shell failure ${Date.now()}`, async (session) => {
      project.trackSession(session.id)
      await project.gotoSession(session.id)
      await project.shell(COMMAND)

      await page.locator('[data-component="tool-trigger"]').last().click()
      await expect(page.locator('[data-component="bash-output"]').last()).toContainText(COMMAND)
      await expect(page.locator('[data-component="bash-output"]').last()).toContainText(COMMAND_FAILURE_PATTERN)

      await expect
        .poll(
          async () => {
            const list = await project.sdk.session
              .messages({ sessionID: session.id, limit: 50 })
              .then((x) => x.data ?? [])
            const msg = list.findLast(
              (item) => item.info.role === "assistant" && "path" in item.info && item.info.path.cwd === project.directory,
            )
            if (!msg) return

            const part = msg.parts
              .filter(isBash)
              .find((item) => item.state.input?.command === COMMAND && item.state.status === "completed")
            if (!part || part.state.status !== "completed") return

            const output =
              typeof part.state.metadata?.output === "string" ? part.state.metadata.output : part.state.output
            if (!COMMAND_FAILURE_PATTERN.test(output)) return

            return { command: part.state.input.command, output }
          },
          { timeout: 90_000 },
        )
        .toEqual(expect.objectContaining({ command: COMMAND, output: expect.stringMatching(COMMAND_FAILURE_PATTERN) }))
    })

    expect(errors.pageErrors.join("\n")).not.toContain("switchFunc(...) is not a function")
  } finally {
    errors.dispose()
  }
})

test("shell mode unmounts model and variant controls", async ({ page, project }) => {
  await project.open()

  const prompt = page.locator(promptSelector).first()
  await expect(page.locator(promptModelSelector)).toHaveCount(1)
  await expect(page.locator(promptVariantSelector)).toHaveCount(1)

  await prompt.click()
  await page.keyboard.type("!")

  await expect(prompt).toHaveAttribute("aria-label", /enter shell command/i)
  await expect(page.locator(promptModelSelector)).toHaveCount(0)
  await expect(page.locator(promptVariantSelector)).toHaveCount(0)
})
