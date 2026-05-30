// Site-level constants. Download links currently point at the GitHub Releases
// page, where users pick the installer themselves. Once China-hosted storage
// (R2 / COS) and the updater fallback (issue #219) land, swap mac / macIntel /
// win for the per-platform direct links — nothing else on the page changes.

export const REPO_URL = "https://github.com/Astro-Han/pawwork";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;

export const DOWNLOAD = {
  mac: RELEASES_URL,
  macIntel: RELEASES_URL,
  win: RELEASES_URL,
};
