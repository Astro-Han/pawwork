CREATE TABLE `session_todo_revision` (
	`session_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_session_todo_revision_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `session_todo_revision` (`session_id`, `revision`)
SELECT DISTINCT `session_id`, 1
FROM `todo`
WHERE NOT EXISTS (
	SELECT 1
	FROM `session_todo_revision`
	WHERE `session_todo_revision`.`session_id` = `todo`.`session_id`
);
