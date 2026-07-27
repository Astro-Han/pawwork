import { expect, type Page } from "@playwright/test"
import { test } from "../fixtures"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 2 })

async function captureFooter(page: Page, name: string): Promise<Shot> {
  const turn = page.locator('[data-slot="session-turn-message-container"]').last()
  await turn.hover()

  const footer = turn.locator('[data-slot="assistant-turn-footer"]')
  await expect(footer).toBeVisible()
  await expect(footer.getByRole("button", { name: "Copy response" })).toBeVisible()
  await expect(footer.getByRole("button", { name: "Fork to new session" })).toBeVisible()

  const metrics = await footer.evaluate((element) => {
    const actions = element.querySelector<HTMLElement>('[data-slot="assistant-turn-footer-actions"]')
    return {
      height: element.getBoundingClientRect().height,
      actionGap: actions ? getComputedStyle(actions).columnGap : "",
    }
  })
  expect(metrics.height).toBe(30)
  expect(metrics.actionGap).toBe("0px")

  return { name, buf: await turn.screenshot({ animations: "disabled" }) }
}

test("session-turn-footer", async ({ page, project, llm }) => {
  await project.open()

  await llm.text("A useful answer with a natural branch point.")
  const sessionID = await project.prompt("Show me the footer actions.")

  const shots: Shot[] = [await captureFooter(page, "light")]

  await applyDarkModeForTests(page)
  await project.gotoSession(sessionID)
  shots.push(await captureFooter(page, "dark"))

  const out = snapOutputPath("session-turn-footer")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] session-turn-footer grid -> ${out}\n\n`)
})
