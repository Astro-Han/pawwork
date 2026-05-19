/**
 * Build the comment lookup map used by historyComments().
 *
 * When `portableActive` is true the target route's useComments() store belongs
 * to a different workspace; returning an empty map forces historyComments() to
 * fall through to the self-contained data on each context item (item.selection,
 * Date.now()), preventing cross-workspace comment metadata from leaking.
 *
 * Lives in its own module so the unit test can import it without pulling the
 * full history-navigation graph (useSDK / usePortableDraft → Solid router).
 */
export function buildCommentByIDMap<T extends { file: string; id: string }>(
  comments: T[],
  portableActive: boolean,
): Map<string, T> {
  if (portableActive) return new Map()
  return new Map(comments.map((item) => [`${item.file}\n${item.id}`, item] as const))
}
