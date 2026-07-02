-- The `continue` automation model no longer mints a dedicated per-automation
-- session. Continue automations now run inside the conversation they were
-- created in (sourceSessionID), so the old `automationSessionID` field has been
-- dropped from the AutomationDefinition schema. That schema parses with
-- `.strict()`, which rejects unknown keys, so any leftover `automationSessionID`
-- on a stored row would fail to parse. Strip it. `continueSession` shipped to
-- the dev channel only (no release), so this touches pre-release dev/QA data.
UPDATE `automation_definition`
SET `data` = json_remove(`data`, '$.automationSessionID')
WHERE json_extract(`data`, '$.automationSessionID') IS NOT NULL;
