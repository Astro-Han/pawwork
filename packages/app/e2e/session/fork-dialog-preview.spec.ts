/**
 * Fork dialog preview for attachment-only messages (post-merge review of
 * #1247): a message submitted with only an attachment chip carries an empty
 * text part and used to render as a blank row in the fork list. The preview
 * now falls back to the same [file:path] placeholder the revert banner uses.
 */
import { writeFileSync } from "node:fs"
import path from "node:path"
import { test, expect } from "../fixtures"
import { withSession, openPalette } from "../actions"

test("fork dialog previews an attachment-only message as a file placeholder", async ({ page, project }) => {
  await project.open()
  const sdk = project.sdk

  await withSession(sdk, "fork attachment preview", async (session) => {
    project.trackSession(session.id)

    const filename = "fork-preview-attachment.txt"
    const filePath = path.join(project.directory, filename)
    writeFileSync(filePath, "attachment body\n")

    await sdk.session.prompt({
      sessionID: session.id,
      noReply: true,
      parts: [{ type: "text", text: "regular question" }],
    })
    await sdk.session.prompt({
      sessionID: session.id,
      noReply: true,
      parts: [
        { type: "text", text: "" },
        {
          type: "file",
          mime: "text/plain",
          url: `file://${filePath}`,
          filename,
          metadata: { attachment: true },
        },
      ],
    })

    await project.gotoSession(session.id)

    const palette = await openPalette(page)
    await palette.getByRole("textbox").first().fill("fork")
    const forkRow = palette.locator('[data-slot="list-item"][data-key="command:session.fork"]')
    await expect(forkRow).toBeVisible()
    await forkRow.click()

    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("regular question")).toBeVisible()
    await expect(dialog.getByText(`[file:${filePath}]`)).toBeVisible()
  })
})
