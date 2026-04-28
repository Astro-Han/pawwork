ALTER TABLE `session` ADD `created_by_agent_tool` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `session` ADD `subagent_type` text;
