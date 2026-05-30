CREATE TABLE `automation_definition` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`owner_directory` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_automation_definition_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `automation_definition_project_owner_updated_idx` ON `automation_definition` (`project_id`,`owner_directory`,`time_updated`,`id`);--> statement-breakpoint
CREATE TABLE `automation_run` (
	`id` text PRIMARY KEY,
	`automation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`owner_directory` text NOT NULL,
	`triggered_at` integer NOT NULL,
	`data` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_automation_run_automation_id_automation_definition_id_fk` FOREIGN KEY (`automation_id`) REFERENCES `automation_definition`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_automation_run_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `automation_run_automation_triggered_idx` ON `automation_run` (`automation_id`,`triggered_at`,`id`);--> statement-breakpoint
CREATE INDEX `automation_run_project_owner_idx` ON `automation_run` (`project_id`,`owner_directory`);
