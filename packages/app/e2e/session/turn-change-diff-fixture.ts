import type { Page } from "@playwright/test"

export const TURN_CHANGE_DIFF_FILE_PATH = "turn-change-cls-fixture.ts"
export const TURN_CHANGE_MODIFIED_DIFF_FILE_PATH = "turn-change-cls-replacement.ts"
export const TURN_CHANGE_SMALL_MODIFIED_DIFF_FILE_PATH = "turn-change-cls-small-replacement.ts"
export const TURN_CHANGE_TAIL_REPLACEMENT_FILE_PATH = "AGENTS.md"
export const TURN_CHANGE_DENSE_DIFF_FILE_PATH = "turn-change-dense-lines.ts"
export const TURN_CHANGE_DENSE_DIFF_LINES = 1_200

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

const turnChangeTailReplacementPatch = [
  `diff --git a/${TURN_CHANGE_TAIL_REPLACEMENT_FILE_PATH} b/${TURN_CHANGE_TAIL_REPLACEMENT_FILE_PATH}`,
  "index 6666666..7777777 100644",
  `--- a/${TURN_CHANGE_TAIL_REPLACEMENT_FILE_PATH}`,
  `+++ b/${TURN_CHANGE_TAIL_REPLACEMENT_FILE_PATH}`,
  "@@ -1,7 +1,7 @@",
  " - Treat `.github/workflows/` as source of truth.",
  " - Prefer targeted local verification over broad local suites.",
  " - Use squash merge by default for PawWork PRs.",
  "-- Merge closeout is not complete until local `dev` is fast-forwarded and the worktree is removed.",
  "+- Merge closeout is not complete until local `dev` is fast-forwarded and any current agent session has exited that PR's worktree.",
  " - After squash merge, do not rely on local branch ancestry.",
  " - Never skip hooks. Never force-push to `dev` or `main`.",
  " - Never commit `.env` or other secret files.",
].join("\n")

const turnChangeDenseDiffPatch = [
  `diff --git a/${TURN_CHANGE_DENSE_DIFF_FILE_PATH} b/${TURN_CHANGE_DENSE_DIFF_FILE_PATH}`,
  "new file mode 100644",
  "index 0000000..8888888",
  "--- /dev/null",
  `+++ b/${TURN_CHANGE_DENSE_DIFF_FILE_PATH}`,
  `@@ -0,0 +1,${TURN_CHANGE_DENSE_DIFF_LINES} @@`,
  ...Array.from({ length: TURN_CHANGE_DENSE_DIFF_LINES }, (_, index) => `+export const denseLine${index + 1} = ${index + 1}`),
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
        kind: "captured",
        files: [
          {
            path: TURN_CHANGE_DIFF_FILE_PATH,
            status: "added",
            additions: 12,
            deletions: 0,
            patch: turnChangeDiffPatch,
            expandable: true,
            restoreState: "applied",
          },
          {
            path: TURN_CHANGE_MODIFIED_DIFF_FILE_PATH,
            status: "modified",
            additions: 8,
            deletions: 6,
            patch: turnChangeModifiedDiffPatch,
            expandable: true,
            restoreState: "applied",
          },
          {
            path: TURN_CHANGE_SMALL_MODIFIED_DIFF_FILE_PATH,
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: turnChangeSmallModifiedDiffPatch,
            expandable: true,
            restoreState: "applied",
          },
        ],
      }),
    })
  })
}

export async function routeTailTurnChangeDiff(page: Page, input: { sessionID: string }) {
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
        kind: "captured",
        files: [
          {
            path: TURN_CHANGE_TAIL_REPLACEMENT_FILE_PATH,
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: turnChangeTailReplacementPatch,
            expandable: true,
            restoreState: "applied",
          },
        ],
      }),
    })
  })
}

export async function routeDenseTurnChangeDiff(page: Page, input: { sessionID: string }) {
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
        kind: "captured",
        files: [
          {
            path: TURN_CHANGE_DENSE_DIFF_FILE_PATH,
            status: "added",
            additions: TURN_CHANGE_DENSE_DIFF_LINES,
            deletions: 0,
            patch: turnChangeDenseDiffPatch,
            expandable: true,
            restoreState: "applied",
          },
        ],
      }),
    })
  })
}
