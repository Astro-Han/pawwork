import type { Page } from "@playwright/test"

export const TURN_CHANGE_DIFF_FILE_PATH = "turn-change-cls-fixture.ts"
export const TURN_CHANGE_MODIFIED_DIFF_FILE_PATH = "turn-change-cls-replacement.ts"
export const TURN_CHANGE_SMALL_MODIFIED_DIFF_FILE_PATH = "turn-change-cls-small-replacement.ts"

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

const turnChangeModifiedDiffPatch = [
  `diff --git a/${TURN_CHANGE_MODIFIED_DIFF_FILE_PATH} b/${TURN_CHANGE_MODIFIED_DIFF_FILE_PATH}`,
  "index 2222222..3333333 100644",
  `--- a/${TURN_CHANGE_MODIFIED_DIFF_FILE_PATH}`,
  `+++ b/${TURN_CHANGE_MODIFIED_DIFF_FILE_PATH}`,
  "@@ -1,8 +1,10 @@",
  " export const rows = [",
  '-  "alpha",',
  '-  "beta",',
  '-  "gamma",',
  '-  "delta",',
  '-  "epsilon",',
  '-  "zeta",',
  '+  "alpha replacement",',
  '+  "beta replacement",',
  '+  "gamma replacement",',
  '+  "delta replacement",',
  '+  "epsilon replacement",',
  '+  "zeta replacement",',
  '+  "eta replacement",',
  '+  "theta replacement",',
  " ]",
].join("\n")

const turnChangeSmallModifiedDiffPatch = [
  `diff --git a/${TURN_CHANGE_SMALL_MODIFIED_DIFF_FILE_PATH} b/${TURN_CHANGE_SMALL_MODIFIED_DIFF_FILE_PATH}`,
  "index 4444444..5555555 100644",
  `--- a/${TURN_CHANGE_SMALL_MODIFIED_DIFF_FILE_PATH}`,
  `+++ b/${TURN_CHANGE_SMALL_MODIFIED_DIFF_FILE_PATH}`,
  "@@ -1,9 +1,9 @@",
  " export const rows = [",
  '   "alpha",',
  '   "beta",',
  '   "gamma",',
  '-  "delta",',
  '+  "delta replacement",',
  '   "epsilon",',
  '   "zeta",',
  '   "eta",',
  " ]",
].join("\n")

export async function routeTurnChangeDiff(page: Page, input: { sessionID: string }) {
  await page.route(/\/session\/[^/]+\/turn\/[^/]+\/changes(?:\?.*)?$/, async (route) => {
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
          {
            path: TURN_CHANGE_MODIFIED_DIFF_FILE_PATH,
            status: "modified",
            additions: 8,
            deletions: 6,
            patch: turnChangeModifiedDiffPatch,
            expandable: true,
          },
          {
            path: TURN_CHANGE_SMALL_MODIFIED_DIFF_FILE_PATH,
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: turnChangeSmallModifiedDiffPatch,
            expandable: true,
          },
        ],
      }),
    })
  })
}
