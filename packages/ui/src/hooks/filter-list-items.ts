import fuzzysort from "fuzzysort"

export function filterListItems<T>(
  items: T[],
  needle: string,
  filterKeys?: string[],
  skipFilter?: (item: T) => boolean,
) {
  if (!needle) return items

  const filterable = skipFilter ? items.filter((item) => !skipFilter(item)) : items
  const skipped = skipFilter ? items.filter(skipFilter) : []
  const filtered =
    !filterKeys && Array.isArray(filterable) && filterable.every((item) => typeof item === "string")
      ? (fuzzysort.go(needle, filterable).map((item) => item.target) as T[])
      : fuzzysort.go(needle, filterable, { keys: filterKeys! }).map((item) => item.obj)

  return skipped.length ? [...filtered, ...skipped] : filtered
}
