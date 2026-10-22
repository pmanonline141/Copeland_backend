ALTER TABLE "order_items" ALTER COLUMN "commission_rate_bps" SET DEFAULT 1000;--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "commission_amount_kobo" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'pending_payment';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_phone" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
UPDATE "orders" SET "order_number" = 'LEGACY-' || replace("id"::text, '-', '') WHERE "order_number" IS NULL;--> statement-breakpoint
UPDATE "orders" SET "status" = 'pending_payment' WHERE "status" = 'pending';--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "order_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_order_number_unique" UNIQUE("order_number");