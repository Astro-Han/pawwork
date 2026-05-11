import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

test("@mention inserts file pill token", async ({ page, project }) => {
  await project.open({
    setup: async (directory) => {
      await mkdir(join(directory, "src"), { recursive: true })
      await writeFile(join(directory, "src", "mention-target.md"), "hello")
    },
  })

  await page.locator(promptSelector).click()
  const sep = process.platform === "win32" ? "\\" : "/"
  const file = ["src", "mention-target.md"].join(sep)
  const filePattern = /src[\\/]+\s*mention-target\.md/

  await page.keyboard.type(`@${file}`)

  const suggestion = page.getByRole("button", { name: filePattern }).first()
  await expect(suggestion).toBeVisible()
  await suggestion.hover()

  await page.keyboard.press("Tab")

  const pill = page.locator(`${promptSelector} [data-type="file"]`).first()
  await expect(pill).toBeVisible()
  await expect(pill).toHaveAttribute("data-path", filePattern)

  await page.keyboard.type(" ok")
  await expect(page.locator(promptSelector)).toContainText("ok")
})
