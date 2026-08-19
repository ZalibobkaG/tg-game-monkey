ALTER TABLE "games" ADD COLUMN "action_order" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "current_round" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_members" ADD COLUMN "card_message_id" integer;--> statement-breakpoint
ALTER TABLE "room_members" ADD COLUMN "signal_message_id" integer;