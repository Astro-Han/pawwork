import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { JSON_SCHEMA, Type, load } from "js-yaml"

// Loader entry lists — the product patch, and the agent compositions presets
// are made of — carry `!!js` rows: expressions the harness evaluates against
// its own composition context, not values a test can resolve. They load as
// their source text so a test can assert which expression a row uses without
// pretending to know what it evaluates to.
//
// `resolve` is deliberately looser than the harness's own (`dsh-app-boot`
// requires a string): a reader that accepted fewer documents than the app does
// would fail tests on rows the app loads fine.
const jsExpression = new Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  construct: (data: string) => data,
  resolve: () => true,
})

const ENTRY_LIST_SCHEMA = JSON_SCHEMA.extend([jsExpression])

export type EntryRow = {
  id?: string
  name?: string
  disabled?: boolean
  inject?: string[]
  config?: Record<string, unknown>
  // An inserted row is a row: the loader reads the same fields on it, `disabled`
  // included, so narrowing this to id/name would hide a real state from callers.
  insert?: EntryRow[]
}

export const productPatchFile = resolve(
  import.meta.dirname,
  "../../resources/dsh/home/product.cordis.patch.yml",
)

/** One entry list's rows, with `!!js` expressions kept as their source text. */
export function readEntryList(file: string): EntryRow[] {
  return load(readFileSync(file, "utf8"), { schema: ENTRY_LIST_SCHEMA }) as EntryRow[]
}

/** The product overlay's rows. */
export function readProductPatch() {
  return readEntryList(productPatchFile)
}
