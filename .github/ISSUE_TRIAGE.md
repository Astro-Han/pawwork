# Issue triage labels

Use one primary type label whenever possible:

- `bug`: existing behavior is broken, incorrect, flaky, misleading, or regressed.
- `enhancement`: a user-facing workflow or capability should improve.
- `documentation`: docs, templates, policies, or written process should change.
- `task`: narrow execution-only, audit, spike, migration, upstream follow-up, or tracking work without clearer bug, feature, docs, or tech-debt semantics.

Do not use `task` as the default label for work an agent can do. If `bug`, `enhancement`, or `documentation` describes the work more clearly, use that label instead.

Area, priority, and context labels such as `app`, `ui`, `platform`, `harness`, `ci`, `P1`, `P2`, `upstream`, and `tech-debt` are supplemental and may be combined with the primary type. Use `tech-debt` for internal cleanup, maintainability, architecture, test, or quality debt; it does not require `task`.
