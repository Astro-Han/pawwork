CREATE TABLE `turn_change_uncaptured` (
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`count` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_turn_change_uncaptured_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_turn_change_uncaptured_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_change_uncaptured_session_id_message_id_idx` ON `turn_change_uncaptured` (`session_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `turn_change_uncaptured_session_id_idx` ON `turn_change_uncaptured` (`session_id`);
