CREATE TABLE `login_rate_limits` (
	`client_key` text NOT NULL,
	`window_start` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`client_key`, `window_start`)
);
