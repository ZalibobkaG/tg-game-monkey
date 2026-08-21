CREATE TYPE "public"."ledger_reason" AS ENUM('topup', 'purchase', 'refund', 'referral_bonus', 'signup_bonus', 'admin_adjust');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('deck', 'topup');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('stars', 'yookassa', 'cryptobot', 'wallet', 'manual');--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'canceled' BEFORE 'failed';--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"invitee_id" integer PRIMARY KEY NOT NULL,
	"referrer_id" integer NOT NULL,
	"source" text DEFAULT 'deeplink' NOT NULL,
	"signup_rewarded" boolean DEFAULT false NOT NULL,
	"earned" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" "ledger_reason" NOT NULL,
	"ref_id" integer,
	"comment" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"total_earned" integer DEFAULT 0 NOT NULL,
	"total_spent" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "deck_id" DROP NOT NULL;--> statement-breakpoint
-- drizzle-kit генерирует смену типа без USING, а Postgres так text в enum не приводит
-- («cannot be cast automatically»). Неизвестные значения складываем в manual:
-- до этой миграции приёма платежей не было, но падать на чужих данных незачем.
ALTER TABLE "payments" ALTER COLUMN "provider" SET DATA TYPE payment_provider
	USING (CASE WHEN "provider" IN ('stars', 'yookassa', 'cryptobot', 'wallet', 'manual')
		THEN "provider" ELSE 'manual' END)::payment_provider;--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "price_stars" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "price_coins" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Уже заведённым платным колодам проставляем звёзды и 🍌 по рублёвой цене:
-- иначе после миграции они остались бы с нулём, то есть непокупаемыми.
-- 100 ⭐ ≈ 100 ₽ после вывода через Fragment, так что курс 1:1 честный.
UPDATE "decks" SET "price_stars" = "price_rub", "price_coins" = "price_rub"
	WHERE "is_premium" = true AND "price_stars" = 0 AND "price_coins" = 0;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "kind" "payment_kind" DEFAULT 'deck' NOT NULL;--> statement-breakpoint
-- NOT NULL без значения по умолчанию упал бы на таблице со старыми
-- платежами, поэтому в три шага: добавить, заполнить, запретить NULL.
ALTER TABLE "payments" ADD COLUMN "order_id" text;--> statement-breakpoint
UPDATE "payments" SET "order_id" = 'legacy-' || "id" WHERE "order_id" IS NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "order_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "coins_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "pay_url" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "telegram_charge_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_invitee_id_users_id_fk" FOREIGN KEY ("invitee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_users_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_code_uq" ON "referral_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_id");--> statement-breakpoint
CREATE INDEX "wallet_ledger_user_idx" ON "wallet_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_order_uq" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","created_at");