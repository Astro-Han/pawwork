type TimelineProject = {
  sdk: {
    session: {
      promptAsync(input: { sessionID: string; noReply: true; parts: Array<{ type: "text"; text: string }> }): Promise<unknown>
    }
  }
}

export const TIMELINE_RECOMPUTE_SEED_TURN_COUNT = 36

const MIXED_CONTENT_CHUNK = "mixed session content ".repeat(7)
const TOOL_OUTPUT_CHUNK = "tool output chunk ".repeat(10)
const COMPLETED_OUTPUT_CHUNK = "completed output ".repeat(8)
const EXPANDED_TOOL_BODY_CHUNK = "expanded tool body ".repeat(8)
const ACTIVE_DOCK_STATE_CHUNK = "active dock state ".repeat(6)

export function buildHeterogeneousScrollSeedText(input: { run: number; turn: number }) {
  const { run, turn } = input
  const chineseText = turn % 4 === 0 ? "中文混排 " : ""
  const body = Array.from(
    { length: 12 + (turn % 5) },
    (_, line) => `paragraph ${line}: ${MIXED_CONTENT_CHUNK}${chineseText}run ${run} turn ${turn}`,
  ).join("\n")
  let mixedBlock: string
  switch (turn % 6) {
    case 0:
      mixedBlock = [
        "## Markdown status",
        "",
        "| phase | status |",
        "| --- | --- |",
        `| scan-${turn} | running |`,
        `| review-${turn} | waiting |`,
      ].join("\n")
      break
    case 1:
      mixedBlock = ["```ts", `export const scrollCase${turn} = { run: ${run}, turn: ${turn}, ok: true }`, "```"].join("\n")
      break
    case 2:
      mixedBlock = ["```diff", `- stale row ${turn}`, `+ stable row ${turn}`, "```"].join("\n")
      break
    case 3:
      mixedBlock = ["```json", JSON.stringify({ run, turn, kind: "scroll-fixture", active: true }, null, 2), "```"].join("\n")
      break
    case 4:
      mixedBlock = [
        "```text",
        `$ pawwork perf probe --run=${run} --turn=${turn}`,
        `stdout: ${TOOL_OUTPUT_CHUNK}`,
        `stderr: ${turn % 2 === 0 ? "none" : "retryable warning"}`,
        "```",
      ].join("\n")
      break
    default:
      mixedBlock = [
        "Reasoning summary",
        `- compared dock pressure for turn ${turn}`,
        `- checked scroll anchor for run ${run}`,
        `- kept this as rendered text, not hidden test metadata`,
      ].join("\n")
      break
  }

  const toolTranscript = [
    "Tool transcript",
    `command: bash scroll-fixture-${turn}`,
    `stdout chunk 1: ${COMPLETED_OUTPUT_CHUNK}`,
    `stdout chunk 2: ${EXPANDED_TOOL_BODY_CHUNK}`,
    `todo pressure ${turn % 4}: ${ACTIVE_DOCK_STATE_CHUNK}`,
  ].join("\n")

  return [`scroll fixture run ${run} turn ${turn}`, body, mixedBlock, toolTranscript].join("\n\n")
}

export async function seedTimelineRecomputeSession(project: TimelineProject, sessionID: string) {
  for (let turn = 0; turn < TIMELINE_RECOMPUTE_SEED_TURN_COUNT; turn += 1) {
    await project.sdk.session.promptAsync({
      sessionID,
      noReply: true,
      parts: [
        {
          type: "text",
          text: [
            `timeline recompute seed turn ${turn}`,
            `owner user-${turn % 4}`,
            `plain text payload ${"content ".repeat(18)}`,
            `status line ${turn % 3}`,
          ].join("\n"),
        },
      ],
    })
  }
}
