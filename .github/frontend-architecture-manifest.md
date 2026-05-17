# Frontend Architecture Manifest

Canonical home for PawWork frontend architecture debt governance.

This manifest covers git-tracked, hand-written frontend files under `packages/app/src` and `packages/ui/src`. It replaces chat memory as the handoff surface for this work. GitHub issue bodies and PR bodies should summarize and link here instead of carrying a second backlog.

## Current State

- Manifest status: LOC warn-only CI slice.
- Baseline commit: `c3e931935` (`chore(release): bump desktop version to v2026.5.17`).
- Default branch: `dev`.
- Master owner: [#599 UI rewrite v2](https://github.com/Astro-Han/pawwork/issues/599).
- Historical issue [#440](https://github.com/Astro-Han/pawwork/issues/440) is closed and must not be used as a new work entry.
- Perf gate [#600](https://github.com/Astro-Han/pawwork/issues/600) is closed/completed and is required for implementation PRs.

## Inventory Command

The repeatable report command is:

```sh
bun run frontend:inventory
node script/frontend-inventory.mjs --format json
node script/frontend-inventory.mjs --check-baseline --base origin/dev --head HEAD
bun run frontend:inventory -- --format markdown --max-rows 120
```

The script is warn-only in this governance phase. It prints threshold warnings for touched production frontend files above the `>500` and `>200` LOC lines, but exits successfully unless inventory generation or git diff fails.

## Report Schema

The JSON report uses schema version `1`.

| Field | Meaning |
| --- | --- |
| `summary.schemaVersion` | Report schema version. |
| `summary.command` | Reproduction command for the JSON report. |
| `summary.locMetric` | Current line-count metric. |
| `summary.paths` | Git pathspecs included in the inventory. |
| `summary.totalTrackedTsTsx` | Total tracked `.ts` / `.tsx` frontend files. |
| `summary.production` | Files in the production ratchet set. |
| `summary.visibilityOnly` | Files visible to agents but excluded from default ratchet. |
| `summary.approvedExceptions` | Files with an approved exception entry. |
| `summary.productionOver500` | Production files above the hard warning line. |
| `summary.productionOver200` | Production files above the owner-manifest line. |
| `summary.visibilityOver500` | Visibility-only files above 500 LOC. |
| `summary.visibilityOver200` | Visibility-only files above 200 LOC. |
| `byOwnerLane` | Production counts grouped by owner lane. |
| `records[].path` | Repo-relative file path. |
| `records[].loc` | Physical LOC, including blank lines and comments. |
| `records[].setType` | `production ratchet set` or `visibility-only inventory`. |
| `records[].classifications` | `production`, `test`, `story`, `i18n`, `generated-static`, `pure-config`, `facade`, or `delivered-surface`. |
| `records[].ownerLane` | Owner lane used for planning. |
| `records[].ownerIssue` | Live issue URL when available. |
| `records[].approvedException` | Exception entry, or `null`. |
| `records[].status` | Current governance state for the file. |
| `records[].reason` | Why the status was assigned. |
| `records[].classificationReason` | Why the file entered its set. |
| `records[].ownerReason` | Why the owner lane was selected. |

If this work changes from physical LOC to logical LOC or another metric, add schema version `2` and do not mix v1 and v2 baseline numbers.

## Baseline Summary

Generated with `node script/frontend-inventory.mjs --format json` at baseline commit `c3e931935`.
This replaces the earlier `5da4d3d61` baseline after the merged UI governance and owner-extraction queue changed the tracked frontend file set.

| Metric | Count |
| --- | ---: |
| Tracked `.ts` / `.tsx` files | 727 |
| Production ratchet set | 388 |
| Visibility-only inventory | 339 |
| Approved exceptions | 0 |
| Production files `>500` LOC | 19 |
| Production files `>200` LOC | 81 |
| Visibility-only files `>500` LOC | 15 |
| Visibility-only files `>200` LOC | 56 |

Production by owner lane:

| Owner lane | Files | `>200` | `>500` |
| --- | ---: | ---: | ---: |
| other/deferred | 136 | 24 | 5 |
| #638 interface audit | 8 | 1 | 0 |
| #604 settings | 35 | 9 | 0 |
| #599 mainline | 2 | 0 | 0 |
| #606 final shell | 45 | 14 | 6 |
| #601 message flow | 66 | 10 | 1 |
| #605 visual shell | 84 | 18 | 6 |
| #595/#615 scroll-perf | 12 | 5 | 1 |

## Owner Lanes

| Lane | Scope | Current state |
| --- | --- | --- |
| [#599 mainline](https://github.com/Astro-Han/pawwork/issues/599) | UI rewrite v2 launch path and integration owner | Open. Primary sequencing source. |
| [#601 message flow](https://github.com/Astro-Han/pawwork/issues/601) | Message timeline, turn shell, message shell, markdown, tool rows | Open. First launch-path implementation lane after governance. |
| [#604 settings](https://github.com/Astro-Han/pawwork/issues/604) | Settings page and settings dialogs | Open. Can be independent, but avoid current #642 typography sweep overlap. |
| [#605 visual shell](https://github.com/Astro-Han/pawwork/issues/605) | Shared visual shell, theme, typography, tokens, motion | Open. Starts after at least two Areas A-D first behavioral PRs. |
| [#606 final shell](https://github.com/Astro-Han/pawwork/issues/606) | Layout, global shell, final assembly | Open. Last lane by issue contract. |
| [#595/#615 scroll-perf](https://github.com/Astro-Han/pawwork/issues/595) | Scroll owner, perf owner, long-session responsiveness | Open. Keep independent from visual-only splits. |
| [#638 interface audit](https://github.com/Astro-Han/pawwork/issues/638) | Cross-package public contracts and type/interface consistency | Open. Contract PRs only, not mixed with UI surface splits. |
| `other/deferred` | No active owner lane matched, or only a closed area matched | Requires a live issue before implementation. |

Closed area references are allowed as background only. [#602](https://github.com/Astro-Han/pawwork/issues/602) and [#603](https://github.com/Astro-Han/pawwork/issues/603) are closed/completed; do not reopen them by implication.

## Ratchet Stages

| Stage | Rule |
| --- | --- |
| 1. Governance | Warn only. Establish baseline, schema, owner map, report command, CI inventory job, and exception format. |
| 2. New `>500` guard | Warn when a PR adds or modifies a production file above 500 LOC. Do not hard fail in the current slice. |
| 3. New `>200` guard | Warn when a PR adds or modifies a production file above 200 LOC. Do not hard fail in the current slice. |
| 4. Tighter ratchet | Only after the launch path is stable and current exceptions are reviewed. |

## Exception Schema

An approved exception must include all fields below. An exception without a live issue and review trigger is not accepted.

| Field | Required |
| --- | --- |
| File path | Yes |
| Owner lane / issue | Yes |
| Why it is not split now | Yes |
| Risk level | Yes |
| Conditions that allow it to remain | Yes |
| Conditions that trigger review | Yes |
| Next PR boundary | Yes |

Current approved exceptions: none.

## Production Burn-down

`>500` production files at baseline:

| LOC | Owner Lane | Status | Path |
| ---: | --- | --- | --- |
| 2463 | #606 final shell | needs-over-500-resolution | `packages/app/src/pages/layout.tsx` |
| 1129 | #605 visual shell | needs-over-500-resolution | `packages/ui/src/components/file.tsx` |
| 1119 | #606 final shell | needs-over-500-resolution | `packages/app/src/context/layout.tsx` |
| 673 | other/deferred | needs-over-500-resolution | `packages/app/src/components/terminal.tsx` |
| 665 | #606 final shell | needs-over-500-resolution | `packages/app/src/context/sync.tsx` |
| 661 | #605 visual shell | needs-over-500-resolution | `packages/ui/src/components/session-review.tsx` |
| 634 | other/deferred | needs-over-500-resolution | `packages/app/src/addons/serialize.ts` |
| 596 | #605 visual shell | needs-over-500-resolution | `packages/ui/src/components/line-comment-annotations.tsx` |
| 595 | #595/#615 scroll-perf | needs-over-500-resolution | `packages/app/src/pages/session/session-timeline-scroll-controller.ts` |
| 588 | #605 visual shell | needs-over-500-resolution | `packages/ui/src/components/file-icon.tsx` |
| 568 | other/deferred | needs-over-500-resolution | `packages/app/src/utils/persist.ts` |
| 560 | #606 final shell | needs-over-500-resolution | `packages/app/src/context/local.tsx` |
| 556 | #605 visual shell | needs-over-500-resolution | `packages/ui/src/theme/resolve.ts` |
| 553 | other/deferred | needs-over-500-resolution | `packages/app/src/pages/session/session-side-panel.tsx` |
| 548 | #601 message flow | needs-over-500-resolution | `packages/app/src/pages/session/use-session-commands.tsx` |
| 543 | #606 final shell | needs-over-500-resolution | `packages/app/src/context/global-sync.tsx` |
| 527 | #605 visual shell | needs-over-500-resolution | `packages/ui/src/context/marked.tsx` |
| 511 | #606 final shell | needs-over-500-resolution | `packages/app/src/context/terminal.tsx` |
| 507 | other/deferred | needs-over-500-resolution | `packages/app/src/components/file-tree.tsx` |

`>200` files are tracked by the report command. Use:

```sh
bun run frontend:inventory -- --format markdown --max-rows 120
```

## PR Manifest

| PR | Owner lane | Base | Depends on | Boundary | Architecture effect | Verification | Status | Public write status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Governance PR | #599 mainline / governance | `dev` | None | Manifest, schema, owner map, warn-only script, baseline report command | boundary created, owner map established, ratchet command added | `bun run frontend:inventory`, `node script/frontend-inventory.mjs --format json`, `bun run frontend:inventory -- --format markdown --max-rows 120` | complete | PR body only |
| LOC warn-only CI PR | #688 governance | `dev` | None | Add CI inventory output and touched-file LOC warnings for `>500` / `>200` production frontend files | LOC governance is executable in CI; current slice warns only and does not enforce hard failure | `node script/frontend-inventory.mjs --format json`, `node script/frontend-inventory.mjs --check-baseline --base origin/dev --head HEAD`, workflow/script contract tests | in progress | PR body only |
| Contract PR | #638 interface audit | Governance branch or post-merge `dev` | Governance PR | Public contract/import boundary and compatibility checks | public contract stabilized, private import risk surfaced | typecheck plus contract-specific compatibility check | planned | PR body only |
| Message-flow PR stack | #601 message flow | post-governance `dev` unless stacked | Governance PR, maybe Contract PR if public imports move | Current launch-path message flow files only | owner extracted, LOC reduced, verification added | typecheck, unit/e2e, #600 perf gate, visual smoke | planned | PR body only |
| [#670](https://github.com/Astro-Han/pawwork/pull/670) | #601 message flow | `dev` | #667, #669 | Extract `createTimelineStaging` from `MessageTimeline` into `session-timeline-staging.ts` with browser-condition staging tests | timeline staging owner isolated; active-session message growth remains staged instead of popping to full render | focused staging/history/scroll tests, typecheck, diff check, PR CI | in review | PR body + manifest |
| Scroll/perf PR stack | #595/#615 scroll-perf | `dev` or message-flow stack if shared files force it | Governance PR | Scroll owner and perf guard work only | owner extracted, perf verification added | typecheck, targeted unit/e2e, #600 perf gate | planned | PR body only |
| Settings PR stack | #604 settings | `dev` after checking #642 overlap | Governance PR | Settings page/dialog family only | owner extracted, LOC reduced | typecheck, settings tests/e2e/manual UI check | planned | PR body only |

## Handoff Rules

- Do not call this work complete until the full completion checklist in #599 and this manifest is satisfied.
- Without merge authorization, stop at ready PRs plus handoff.
- After any stack merge, update this manifest before starting the next dependent stack.
- Keep `STATUS.md` as a local pointer only in this checkout; it is excluded from git here and is not the canonical manifest.
