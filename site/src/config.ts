// Site-level constants.
//
// DOWNLOAD holds the fallback download targets: the GitHub Releases page, where
// users pick the installer themselves. On load the client fetches
// DOWNLOAD_MANIFEST_URL — a tiny JSON pointer in Cloudflare R2 that the release
// workflow rewrites every release — and, if reachable, swaps the buttons for
// per-platform direct links on the China-accessible Cloudflare CDN. If the
// manifest is unreachable (R2 down, offline, blocked), the GitHub fallback
// stands, so the buttons always work.

export const REPO_URL = "https://github.com/Astro-Han/pawwork";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;

export const DOWNLOAD = {
  mac: RELEASES_URL,
  macIntel: RELEASES_URL,
  win: RELEASES_URL,
};

// Pointer object mirrored to R2 by .github/workflows/mirror-release-to-r2.yml.
// Shape: { version, macArm64, macX64, winX64 } where each value is a direct URL.
// Keys match the data-dl attributes on the download buttons in index.astro.
export const DOWNLOAD_MANIFEST_URL = "https://dl.pawwork.ai/latest.json";
