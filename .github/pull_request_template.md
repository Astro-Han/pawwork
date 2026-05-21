<!-- Checklist policy: the Checklist section below is policy. Do not edit, add, or remove items. Tick boxes only by replacing [ ] with [x]. -->

## Summary

Describe what changed.

## Why

Explain the problem, goal, or context for this pull request.

## Related Issue

Link the issue if there is one.

## Human Review Status

Replace this paragraph with exactly one of the following lines:

- `Pending` — waiting for a human reviewer to approve.
- `Approved by @<reviewer>` — name the human reviewer who signed off after the final diff and verification evidence were ready.
- `Not required: <reason>` — only for automated release bumps, dependency updates, or other low-risk bot-authored PRs. State the reason. Do not select this for any change an agent authored on behalf of a human request.

## Review Focus

What should reviewers pay the most attention to?

## Risk Notes

Call out behavior, data, permissions, dependencies, platform, or migration risks. If you left any **(conditional)** checklist item below unticked, list each skipped item here with a one-line reason. Write "None" only when there are no risks AND no skipped items.

## How To Verify

List the targeted checks you ran and the key result for each one. Prefer the smallest checks that cover the changed surface. Include the result, not just the command.

<!-- replace-before-submit: delete this comment AND the example block below, then paste your actual verification results in their place -->

```text
# EXAMPLE — delete this block and replace with your real verification results
YAML parse: ok for both issue forms
Diff check: no whitespace errors
Focused tests: 47 passed
```

## Screenshots or Recordings

Required for visible UI changes.

## Checklist

> **How to use this checklist:**
>
> - Tick a box by replacing `[ ]` with `[x]`. Do not edit, add, or remove items.
> - The bot-applied label items can only be honestly ticked AFTER the PR is opened and the labeler / priority-triage bots have run — return to the PR description and tick them then.
> - Most items are required. The few that are conditional are explicitly marked **(conditional)**; for those, leave unticked if they truly do not apply and explain why in Risk Notes. All other items must be ticked before requesting human review.

- [ ] **Type label** — this PR carries exactly one of `bug`, `enhancement`, `task`, `documentation`. Type labels are author-added; the labeler bot does NOT assign them. Add the label in the GitHub UI, then tick this.
- [ ] **Routing labels** — this PR carries at least one of `app`, `ui`, `platform`, `harness`, `ci`. The labeler bot assigns these on PR open based on changed paths. Confirm the bot's choice (or override if wrong), then tick this.
- [ ] **Priority label** — this PR carries exactly one of `P0`, `P1`, `P2`, `P3`. The priority-triage bot suggests one on PR open. Confirm or override, then tick this.
- [ ] Human Review Status above is set to `Pending`, `Approved by @<reviewer>`, or `Not required: <reason>` (default is `Pending`; "not required" is restricted to bot-authored low-risk PRs).
- [ ] I linked the related issue, or stated in Summary why there is no issue.
- [ ] I described the review focus and any meaningful risks.
- [ ] I replaced the example block in How To Verify with the real verification steps and the key result for each.
- [ ] I did not introduce unrelated refactors, dependencies, generated files, or file changes beyond the stated scope.
- [ ] **(conditional)** I manually checked visible UI or copy changes when needed, with screenshots or recordings. Leave unticked only if no visible UI or copy changed.
- [ ] **(conditional)** I considered macOS and Windows impact for platform, packaging, updater, signing, paths, shell, or permissions changes. Leave unticked only if no platform/packaging surface was touched.
- [ ] **(conditional)** I called out docs, release notes, dependencies, permissions, credentials, deletion behavior, generated content, or local file changes when relevant. Leave unticked only if none of those surfaces was touched.
- [ ] I reviewed the final diff for unrelated changes and suspicious dependency changes.
- [ ] I am targeting `dev`, and my PR title and commit messages use Conventional Commits in English.
