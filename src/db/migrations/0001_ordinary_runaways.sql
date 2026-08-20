DROP INDEX "rooms_code_uq";--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "code_custom" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_code_active_uq" ON "rooms" USING btree ("code") WHERE state <> 'closed';--> statement-breakpoint
CREATE INDEX "rooms_code_idx" ON "rooms" USING btree ("code");