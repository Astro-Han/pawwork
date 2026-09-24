// Host loader entry for the browser implementation in ./client.js. The product
// plugin contributes nothing to the DSH sidecar. It must stay importable without
// browser globals — the host loader imports the package main on every boot.
export const name = "pawwork-product"

export function apply() {}
