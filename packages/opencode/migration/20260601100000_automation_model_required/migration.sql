-- Automation definitions and runs persisted before PR5.5 lack the now-required
-- `model` field on AutomationDefinition. Since automations are still gated
-- behind the env-flagged `automate` tool and no UI entry exists yet, any rows
-- in these tables are pre-release dev/QA data. Drop them so the new schema
-- parses cleanly without per-row backfill.
DELETE FROM `automation_run`;--> statement-breakpoint
DELETE FROM `automation_definition`;
