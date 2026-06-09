/**
 * Build the comment lookup map used by historyComments().
 *
 * Lives in its own module so the unit test can import it without pulling the
 * full history-navigation graph (useSDK / Solid router).
 */
export function buildCommentByIDMap<T extends { file: string; id: string }>(
  comments: T[],
): Map<string, T> {
  return new Map(comments.map((item) => [`${item.file}\n${item.id}`, item] as const))
}
