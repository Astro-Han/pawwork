// Type-level assertions. Validated by `bun run typecheck`; not executed.
// Keeps RightPanelTab's union shape from silently widening or narrowing
// outside of an intentional change here.

import type { RightPanelTab, RightPanelStaticTab } from "./right-panel-tabs"

// Static slots: the three fixed panel tabs are valid.
const status: RightPanelTab = "status"
const review: RightPanelTab = "review"
const context: RightPanelTab = "context"
void status
void review
void context

// Dynamic terminal tabs: the `terminal:<id>` shape is valid.
const someTerminal: RightPanelTab = "terminal:abc123"
const anotherTerminal: RightPanelTab = `terminal:${"42-xyz"}`
void someTerminal
void anotherTerminal

// Static-only type narrows to the three fixed tabs without the terminal arm.
const fixed: RightPanelStaticTab = "status"
// @ts-expect-error a terminal:<id> string is not a static tab
const bogusFixed: RightPanelStaticTab = "terminal:abc"
void fixed
void bogusFixed

// Negative type assertions: arbitrary strings should not satisfy RightPanelTab.
// @ts-expect-error "settings" is not a known panel tab
const settings: RightPanelTab = "settings"
// @ts-expect-error legacy "terminal" without an id is no longer a valid tab value
const bareTerminal: RightPanelTab = "terminal"
// @ts-expect-error "changes" is the pre-refactor name for review; not valid anymore
const changes: RightPanelTab = "changes"
// @ts-expect-error "files" was merged into the status panel; not a valid tab anymore
const files: RightPanelTab = "files"
void settings
void bareTerminal
void changes
void files
