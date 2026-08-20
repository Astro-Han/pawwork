import { readFileSync } from "node:fs"
import vm from "node:vm"

// Every PawWork client bundle registers itself the same way: DSH's loader shim
// calls window.__ModuleLoader__.load with an id and a factory that takes the
// host's require. Six copies of this scaffold, with four different inline
// spellings of the same contract, used to live across the client tests.
export type DshClientModule = {
  id: string
  factory: (require: (name: string) => unknown) => {
    apply(ctx: unknown): void
    inject: string[]
  }
}

export type DshClientGlobals = Record<string, unknown> & { window?: Record<string, unknown> }

// Anything a caller puts on `window` (the PawWork file-picker bridge, say) is
// kept; only the loader shim is supplied here.
export function loadDshClientModule(file: string, globals: DshClientGlobals = {}): DshClientModule {
  let loaded: DshClientModule | undefined
  const { window: hostWindow, ...rest } = globals
  const window = {
    ...hostWindow,
    __ModuleLoader__: { load: (value: DshClientModule) => { loaded = value } },
  }
  vm.runInNewContext(readFileSync(file, "utf8"), { window, ...rest })
  if (loaded === undefined) throw new Error(`${file} did not register a DSH client module`)
  return loaded
}
