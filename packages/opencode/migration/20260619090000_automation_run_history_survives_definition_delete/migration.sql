CREATE TABLE `automation_run_next` (
	`id` text PRIMARY KEY,
	`automation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`owner_directory` text NOT NULL,
	`triggered_at` integer NOT NULL,
	`data` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_automation_run_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `automation_run_next` (
	`id`,
	`automation_id`,
	`project_id`,
	`owner_directory`,
	`triggered_at`,
	`data`,
	`time_created`,
	`time_updated`
)
SELECT
	`id`,
	`automation_id`,
	`project_id`,
	`owner_directory`,
	`triggered_at`,
	`data`,
	`time_created`,
	`time_updated`
FROM `automation_run`;
--> statement-breakpoint
DROP TABLE `automation_run`;
--> statement-breakpoint
ALTER TABLE `automation_run_next` RENAME TO `automation_run`;
--> statement-breakpoint
CREATE INDEX `automation_run_automation_triggered_idx` ON `automation_run` (`automation_id`,`triggered_at`,`id`);
--> statement-breakpoint
CREATE INDEX `automation_run_project_owner_idx` ON `automation_run` (`project_id`,`owner_directory`);
