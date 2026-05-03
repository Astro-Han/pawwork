CREATE TABLE `turn_change_display` (
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`data` text NOT NULL,
	`state` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_turn_change_display_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_turn_change_display_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_change_display_session_id_message_id_idx` ON `turn_change_display` (`session_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `turn_change_display_session_id_idx` ON `turn_change_display` (`session_id`);--> statement-breakpoint
CREATE TABLE `turn_change_restore` (
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`file_path` text NOT NULL,
	`position` integer NOT NULL,
	`data` text NOT NULL,
	`finalized` integer DEFAULT false NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_turn_change_restore_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_turn_change_restore_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_change_restore_session_id_message_id_file_path_idx` ON `turn_change_restore` (`session_id`,`message_id`,`file_path`);--> statement-breakpoint
CREATE INDEX `turn_change_restore_session_id_message_id_idx` ON `turn_change_restore` (`session_id`,`message_id`);
