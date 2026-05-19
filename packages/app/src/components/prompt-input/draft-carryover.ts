// Backwards-compat shim: route-aware portable homepage owner.
// The previous broad cross-directory carry-over is removed (PR #750, design v7).
// New consumers should use `usePortableDraft()` from `./portable-draft`.

export { usePortableDraft } from "./portable-draft"
