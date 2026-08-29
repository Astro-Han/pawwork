// Host loader entry for the browser implementation in ./client.js. The updater
// state machine, feed fallback, and install all live in the Electron main
// process; the DSH sidecar has nothing to contribute, so this plugin is a
// deliberate no-op here. It must stay importable without browser globals —
// the host loader imports the package main on every boot.
export function apply() {}
