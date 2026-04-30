## Summary

Describe what changed.

## Why

Explain the problem, goal, or context for this pull request.

## Related Issue

Link the issue if there is one.

## Review Focus

What should reviewers pay the most attention to?

## Risk Notes

Call out behavior, data, permissions, dependencies, platform, or migration risks. Write "None" if there are no special risks.

## How To Verify

List the targeted checks you ran and any manual checks you performed. Prefer the smallest checks that cover the changed surface.

```bash
# Examples, choose only what is relevant:
cd packages/app
bun test ...
cd ../opencode
bun test ...
```

## Screenshots or Recordings

Required for visible UI changes.

## Checklist

- [ ] I linked the related issue, or stated why there is no issue
- [ ] This PR has type, scope, and priority labels, or I requested maintainer labeling
- [ ] I described the review focus and any meaningful risks
- [ ] I listed the relevant verification steps, including tests when behavior changed
- [ ] I manually checked visible UI or copy changes when needed, with screenshots or recordings
- [ ] I considered macOS and Windows impact for desktop, packaging, updater, signing, paths, shell, or permissions changes
- [ ] I called out docs, release notes, dependencies, permissions, credentials, deletion behavior, generated content, or local file changes when relevant
- [ ] I reviewed the final diff for unrelated changes and suspicious dependency changes
- [ ] I am targeting `dev`, and my PR title and commit messages use Conventional Commits in English
