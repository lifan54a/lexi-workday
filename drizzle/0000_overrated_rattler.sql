CREATE TABLE `app_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`tasks` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL
);
