CREATE TABLE `snapshot_objects` (
	`owner_id` text NOT NULL,
	`hash` text NOT NULL,
	`byte_size` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `hash`)
);
