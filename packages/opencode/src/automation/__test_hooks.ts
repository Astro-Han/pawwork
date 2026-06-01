import type { Automation } from "./index"

/**
 * @internal Test-only injection points for the automation module.
 *
 * Production code MUST NOT import or write to this module — the only reader
 * is `recordRunOutcome` in `./index`, which checks `beforeReplaceDefinition`
 * to support a deterministic ConflictError retry test. By living outside the
 * `Automation` namespace, this seam is invisible to anyone consuming the
 * public `Automation.*` API surface.
 *
 * Tests assign hooks here and MUST clear them in a `finally` block so a
 * failing test cannot leak state to a sibling test.
 */
export const internalTestHooks: {
  beforeReplaceDefinition?: (previous: Automation.Definition) => void
} = {}
