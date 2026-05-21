import type { Page } from "@playwright/test"

export const TURN_CHANGE_DIFF_FILE_PATH = "turn-change-cls-fixture.ts"

const turnChangeDiffPatch = [
  `diff --git a/${TURN_CHANGE_DIFF_FILE_PATH} b/${TURN_CHANGE_DIFF_FILE_PATH}`,
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  `+++ b/${TURN_CHANGE_DIFF_FILE_PATH}`,
  "@@ -0,0 +1,12 @@",
  "+export const rows = [",
  '+  "alpha",',
  '+  "beta",',
  '+  "gamma",',
  '+  "delta",',
  '+  "epsilon",',
  '+  "zeta",',
  '+  "eta",',
  '+  "theta",',
  '+  "iota",',
  '+  "kappa",',
  "+]",
].join("\n")

export async function routeTurnChangeDiff(page: Page, input: { sessionID: string }) {
  await page.route(/\/session\/[^/]+\/turn\/[^/]+\/changes$/, async (route) => {
    const url = new URL(route.request().url())
    const parts = url.pathname.split("/")
    const turnID = parts.at(-2) ?? "turn"
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionID: input.sessionID,
        turnID,
        messageID: turnID,
        undoAvailable: true,
        redoAvailable: false,
        files: [
          {
            path: TURN_CHANGE_DIFF_FILE_PATH,
            status: "added",
            additions: 12,
            deletions: 0,
            patch: turnChangeDiffPatch,
            expandable: true,
          },
        ],
      }),
    })
  })
}
