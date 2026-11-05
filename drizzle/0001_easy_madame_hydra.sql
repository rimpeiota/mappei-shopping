CREATE TABLE `shopping_commerce_connections` (
	`user_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`ledger_json` text NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`last_operation_id` text NOT NULL,
	`last_synced_at` text NOT NULL,
	`has_more` integer DEFAULT 0 NOT NULL,
	`source_last_success_at` text,
	`source_limited` integer DEFAULT 0 NOT NULL,
	`auth_blocked` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `integration_id`)
);
