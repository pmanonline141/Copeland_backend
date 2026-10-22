ALTER TABLE "orders" ALTER COLUMN "buyer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_email" text NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paystack_reference" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_paystack_reference_unique" UNIQUE("paystack_reference");