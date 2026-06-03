# PawWork Release Checklist

Use this checklist for stable PawWork desktop releases.

## 1. Prepare

- Confirm the release PR targets `dev` and all required CI checks are green.
- Confirm the version bump is merged into `dev`.
- Confirm `dev` is up to date locally:

```bash
git switch dev
git pull --ff-only
```

- Confirm the release tag does not already exist:

```bash
git fetch origin --tags
git tag -l vX.Y.Z
gh release view vX.Y.Z --repo Astro-Han/pawwork
```

## 2. Draft Release Notes Before Publishing

Create or update the GitHub Release body before publishing the release. Use English first, direct user download links, then a short Chinese section.

```md
## Downloads

- [macOS Apple Silicon](https://github.com/Astro-Han/pawwork/releases/download/vX.Y.Z/pawwork-mac-arm64-X.Y.Z.dmg)
- [macOS Intel](https://github.com/Astro-Han/pawwork/releases/download/vX.Y.Z/pawwork-mac-x64-X.Y.Z.dmg)
- [Windows](https://github.com/Astro-Han/pawwork/releases/download/vX.Y.Z/pawwork-win-x64-X.Y.Z.exe)

## App Update Notice

- Short product-facing sentence for the in-app post-update modal. Do not include download links, PR numbers, verification details, or maintenance-only notes.

## Highlights

- User-facing changes, bug fixes, or packaging fixes.

## Runtime And Maintenance

- Build, updater, notarization, dependency, or CI maintenance.

## Verification

- macOS Apple Silicon submit/finalize completed successfully, including notarization.
- macOS Intel submit/finalize completed successfully, including notarization.
- Windows x64 release build completed successfully.
- vX.Y.Z is published as the latest stable release.

## 中文版本

### 下载

- [macOS Apple 芯片](https://github.com/Astro-Han/pawwork/releases/download/vX.Y.Z/pawwork-mac-arm64-X.Y.Z.dmg)
- [macOS Intel 芯片](https://github.com/Astro-Han/pawwork/releases/download/vX.Y.Z/pawwork-mac-x64-X.Y.Z.dmg)
- [Windows](https://github.com/Astro-Han/pawwork/releases/download/vX.Y.Z/pawwork-win-x64-X.Y.Z.exe)

### 主要更新

- 用一句话概括主要变化。
```

Do not rely on the GitHub Assets list as the primary download UI. It mixes user installers with updater metadata, so direct links make the intended downloads clear.

## 3. Build Release Artifacts

Submit macOS notarization for both architectures:

```bash
gh workflow run build.yml --repo Astro-Han/pawwork --ref dev -f phase=submit -f channel=prod -f target=macos -f arch=arm64
gh workflow run build.yml --repo Astro-Han/pawwork --ref dev -f phase=submit -f channel=prod -f target=macos -f arch=x64
```

Record each submit run's source run ID, source run attempt, source ref, source sha, workflow ref, workflow sha, and Apple submission ID from the workflow summary.

The submit workflow summary should include values like this:

```text
source_run_id: 123456789
source_run_attempt: 1
source_ref: dev
source_sha: 0123456789abcdef0123456789abcdef01234567
source_workflow_ref: workflow-snapshot-123456789-1-macos-arm64
source_workflow_sha: 0123456789abcdef0123456789abcdef01234567
submission_id: 00000000-0000-0000-0000-000000000000
```

Finalize each macOS architecture with the exact command emitted by its submit workflow summary. If writing the commands manually, keep the arm64 and x64 values separate:

For arm64, replace `ARM64_SOURCE_RUN_ID` with the `source_run_id` value from the arm64 submit summary, and apply the same mapping for the other `ARM64_` placeholders. Repeat with the x64 submit summary for the `X64_` placeholders.

```bash
gh workflow run build.yml --repo Astro-Han/pawwork --ref ARM64_SOURCE_WORKFLOW_REF -f phase=finalize -f channel=prod -f arch=arm64 -f source_run_id=ARM64_SOURCE_RUN_ID -f source_run_attempt=ARM64_SOURCE_RUN_ATTEMPT -f source_ref=ARM64_SOURCE_REF -f source_sha=ARM64_SOURCE_SHA -f source_workflow_ref=ARM64_SOURCE_WORKFLOW_REF -f source_workflow_sha=ARM64_SOURCE_WORKFLOW_SHA -f submission_id=ARM64_SUBMISSION_ID
gh workflow run build.yml --repo Astro-Han/pawwork --ref X64_SOURCE_WORKFLOW_REF -f phase=finalize -f channel=prod -f arch=x64 -f source_run_id=X64_SOURCE_RUN_ID -f source_run_attempt=X64_SOURCE_RUN_ATTEMPT -f source_ref=X64_SOURCE_REF -f source_sha=X64_SOURCE_SHA -f source_workflow_ref=X64_SOURCE_WORKFLOW_REF -f source_workflow_sha=X64_SOURCE_WORKFLOW_SHA -f submission_id=X64_SUBMISSION_ID
```

Build and publish the Windows installer:

```bash
gh workflow run build.yml --repo Astro-Han/pawwork --ref dev -f phase=full -f channel=prod -f target=windows -f arch=x64
```

> **All three final targets must be the same build commit.** mac finalize rebuilds from the commit pinned by its submit snapshot tag (`source_sha`), while the Windows `full` build uses the current `dev` HEAD (`github.sha`). If `dev` moves between the macOS submits and the Windows build, the targets disagree and the auto-publisher (Step 4) refuses to publish — by design. Freeze `dev` for the duration of the release, or confirm the Windows build's commit matches the macOS `source_sha` before expecting auto-publish to fire.

## 4. Publish

**A prod release publishes itself (PR #1119).** The tail `publish-when-complete` step of the last target's finalize/full build flips the draft to published — pinning the tag to the build commit and marking it latest — then dispatches the R2 mirror. It only does so once every target's installers and updater metadata are present AND all targets agree on a single build commit. So for a normal prod release you do **not** run `gh release edit` by hand; you confirm the auto-publish outcome.

Check the "Publish release when all targets are complete" step in the last build run, then the release state:

```bash
gh release view vX.Y.Z --repo Astro-Han/pawwork --json isDraft,isPrerelease,targetCommitish,assets,url
```

- **Published** (`isDraft: false`, `targetCommitish` = the build commit) → done, go to Step 6.
- **Still a draft, a target missing** (the step logged `wait`) → finish or re-run the missing target; its own tail step will publish. Do not publish by hand.
- **The step failed** (mixed-source, updater-metadata drift, or a missing/empty provenance marker) → **do not publish.** The guard is refusing a release built from more than one commit or with mismatched metadata. Rebuild all three targets from a single commit (see the same-commit note in Step 3) and let auto-publish run.

Manual publish is a **last resort** — e.g. a non-prod channel that has no auto-publish, or recovering a release the pipeline genuinely cannot finish. It bypasses every guard (completeness, single-source markers, the updater-metadata hash anchor, seal/re-read), so only after you have confirmed the draft holds all three installers AND they were built from the same commit, publish and pin the tag to that commit:

```bash
# LAST RESORT — bypasses the auto-publisher's safety checks.
gh release edit vX.Y.Z --repo Astro-Han/pawwork --draft=false --latest --prerelease=false --target <build-commit-sha>
```

Never publish a non-prod (beta/dev) build as `--latest --prerelease=false`, and never hand-publish a partial draft.

## 5. Mirror Downloads to Cloudflare R2

The China-accessible landing page (dl.pawwork.ai) serves downloads from the R2 mirror, not GitHub. The mirror is gated by `verify-release` and only runs against a published (non-draft) release, so it runs after the release is published in Step 4.

On the normal path the auto-publisher (Step 4) dispatches `.github/workflows/mirror-release-to-r2.yml` itself, immediately after publishing: a release published with the built-in `GITHUB_TOKEN` does NOT emit a `release: published` event, so the auto-publisher triggers the mirror explicitly. (A manual last-resort publish with your own credentials *does* emit `release: published`, which also triggers the mirror.) Either way, confirm a run started, and dispatch it manually if none did:

```bash
gh run list --workflow mirror-release-to-r2.yml --repo Astro-Han/pawwork --limit 3
# If no run was triggered for this tag, dispatch it manually:
gh workflow run mirror-release-to-r2.yml --repo Astro-Han/pawwork --ref dev -f tag=vX.Y.Z
```

Then confirm the landing page points at the new version on R2:

```bash
curl -fsSL https://dl.pawwork.ai/latest.json            # "version" should read X.Y.Z
curl -fsI https://dl.pawwork.ai/pawwork-mac-arm64-X.Y.Z.dmg | head -1   # expect HTTP/2 200
```

If `latest.json` still shows the previous version, the mirror has not finished — do not announce the release until it does. The mirror fails closed, so a failed run leaves the site pointing at the previous good release.

## 6. Post-Release Verification

Run the verification helper:

```bash
export GH_TOKEN="$(gh auth token)"
bun packages/desktop-electron/scripts/verify-release.ts vX.Y.Z
```

`GH_TOKEN` is recommended so GitHub API requests use the authenticated rate limit.

The helper verifies:

- The GitHub Release is not a draft.
- The GitHub Release is not a prerelease.
- `pawwork-mac-arm64-X.Y.Z.dmg` exists.
- `pawwork-mac-x64-X.Y.Z.dmg` exists.
- `pawwork-win-x64-X.Y.Z.exe` exists.
- versioned updater `.zip` and `.blockmap` assets exist.
- `latest.yml` points to `pawwork-win-x64-X.Y.Z.exe`.
- `latest-mac.yml` includes both `pawwork-mac-arm64-X.Y.Z.zip` and `pawwork-mac-x64-X.Y.Z.zip`.

Also verify a fresh packaged startup before closing startup-blocking issues. The command below is for macOS; override `PAWWORK_RELEASE_APP_PATH` and `PAWWORK_RELEASE_STARTUP_LOG` if the app or log is in a custom location.

```bash
set -euo pipefail
smoke_home=/tmp/pawwork-release-smoke/user-data
smoke_user_data="$smoke_home/ai.pawwork.desktop"
ready_file="$smoke_user_data/ci-smoke-ready.json"
app_path=${PAWWORK_RELEASE_APP_PATH:-/Applications/PawWork.app/Contents/MacOS/PawWork}
startup_log=${PAWWORK_RELEASE_STARTUP_LOG:-$smoke_user_data/logs/main.log}
app_pid=""
cleanup() {
  if [ -n "$app_pid" ]; then
    kill "$app_pid" 2>/dev/null || true
  fi
  rm -rf "$smoke_home"
}
trap cleanup EXIT
rm -rf "$smoke_home"
PAWWORK_CI_SMOKE=true PAWWORK_CI_SMOKE_HOME="$smoke_home" "$app_path" &
app_pid=$!
i=0
while [ "$i" -lt 60 ]; do
  test -f "$ready_file" && break
  sleep 1
  i=$((i + 1))
done
if [ ! -f "$ready_file" ]; then
  echo "Timed out waiting for $ready_file"
  exit 1
fi
sleep 1
PAWWORK_RELEASE_STARTUP_LOG="$startup_log" bun packages/desktop-electron/scripts/verify-release.ts vX.Y.Z
```

The startup log check reads the latest `app starting` block and verifies it reaches `server ready`, `loading task finished`, and `init step done`. This catches first-launch hangs where the sidecar becomes reachable but the desktop shell never opens the main window.

For Windows releases, run the same fresh-user-data check from PowerShell:

```powershell
$ErrorActionPreference = "Stop"
$smokeHome = "$env:TEMP\pawwork-release-smoke\user-data"
$smokeUserData = "$smokeHome\ai.pawwork.desktop"
$readyFile = "$smokeUserData\ci-smoke-ready.json"
$appPath = if ($env:PAWWORK_RELEASE_APP_PATH) { $env:PAWWORK_RELEASE_APP_PATH } else { "$env:LOCALAPPDATA\Programs\PawWork\PawWork.exe" }
$startupLog = if ($env:PAWWORK_RELEASE_STARTUP_LOG) { $env:PAWWORK_RELEASE_STARTUP_LOG } else { "$smokeUserData\logs\main.log" }
Remove-Item -Recurse -Force $smokeHome -ErrorAction SilentlyContinue
$previousCiSmoke = $env:PAWWORK_CI_SMOKE
$previousCiSmokeHome = $env:PAWWORK_CI_SMOKE_HOME
$previousStartupLog = $env:PAWWORK_RELEASE_STARTUP_LOG
$env:PAWWORK_CI_SMOKE = "true"
$env:PAWWORK_CI_SMOKE_HOME = $smokeHome
$app = Start-Process -FilePath $appPath -PassThru
try {
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $readyFile) {
      $ready = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "Timed out waiting for $readyFile" }
  Start-Sleep -Seconds 1
  $env:PAWWORK_RELEASE_STARTUP_LOG = $startupLog
  bun packages/desktop-electron/scripts/verify-release.ts vX.Y.Z
} finally {
  if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force }
  if ($null -eq $previousCiSmoke) { Remove-Item Env:PAWWORK_CI_SMOKE -ErrorAction SilentlyContinue } else { $env:PAWWORK_CI_SMOKE = $previousCiSmoke }
  if ($null -eq $previousCiSmokeHome) { Remove-Item Env:PAWWORK_CI_SMOKE_HOME -ErrorAction SilentlyContinue } else { $env:PAWWORK_CI_SMOKE_HOME = $previousCiSmokeHome }
  if ($null -eq $previousStartupLog) { Remove-Item Env:PAWWORK_RELEASE_STARTUP_LOG -ErrorAction SilentlyContinue } else { $env:PAWWORK_RELEASE_STARTUP_LOG = $previousStartupLog }
  Remove-Item -Recurse -Force $smokeHome -ErrorAction SilentlyContinue
}
```

For Windows installer shortcut verification, record the minimum matrix:

- English Windows fresh install, `Just me`, desktop shortcut checked: current user desktop shortcut exists and launches PawWork
- English Windows fresh install, `All users`, desktop shortcut checked: public desktop shortcut exists and launches PawWork
- Chinese Windows fresh install, `Just me`, desktop shortcut checked: current user desktop shortcut is `爪印.lnk` and launches PawWork
- Chinese Windows fresh install, `All users`, desktop shortcut checked: public desktop shortcut is `爪印.lnk` and launches PawWork
- unchecked install: no desktop shortcut is created and the Start Menu entry still launches PawWork
- reinstall with desktop shortcut checked: missing standard desktop shortcut is repaired
- reinstall with desktop shortcut unchecked: existing desktop shortcut state is left unchanged
- scope switch between `Just me` and `All users`: standard desktop shortcut only exists in the selected install scope
- Chinese reinstall over an older standard `PawWork.lnk`: standard desktop shortcut migrates to `爪印.lnk`
- app language change after install: desktop shortcut name is not changed
- auto-update from the previous affected version: existing desktop shortcut state is left unchanged, including the no-desktop-shortcut state

Do not close the Windows desktop shortcut issue until this real Windows installer evidence is recorded.

Keep `.zip`, `.blockmap`, and `latest*.yml` assets unless updater requirements are proven safe without them.

If verification fails, check the reported missing or malformed asset first, rerun only the affected build phase, and publish the release only after the verification helper passes.

## 7. Close Release Issues

Only close release-blocking issues after post-release verification passes. Leave a short comment with the release link and the verified artifact names.
