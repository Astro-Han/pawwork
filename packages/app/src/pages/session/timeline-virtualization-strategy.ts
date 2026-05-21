export type TimelineRowRenderMode = "plain" | "virtualized"

export const TIMELINE_PLAIN_RENDER_ROW_LIMIT = 48

export function chooseTimelineRowRenderMode(input: { rowCount: number }): TimelineRowRenderMode {
  return input.rowCount <= TIMELINE_PLAIN_RENDER_ROW_LIMIT ? "plain" : "virtualized"
}
