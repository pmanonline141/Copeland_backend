CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"amount_kobo" integer NOT NULL,
	"status" text DEFAULT 'initialized' NOT NULL,
	"provider_payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payments_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "payout_items" (
	"order_item_id" uuid PRIMARY KEY NOT NULL,
	"partner_id" uuid NOT NULL,
	"amount_kobo" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reference" uuid DEFAULT gen_random_uuid() NOT NULL,
	"paystack_transfer_code" text,
	"manual_reference" text,
	"payout_mode" text DEFAULT 'paystack' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payout_items_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "commission_rate_bps" integer;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "order_item_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "payout_item_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "adjustment_note" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "commission_rate_bps" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "commission_amount_kobo" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fulfillment_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "delivered_at" timestamp;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "payout_eligible_at" timestamp;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "currency" text DEFAULT 'NGN' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "requires_admin_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "admin_review_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_key_unique" ON "webhook_events" USING btree ("provider","event_key");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payout_item_id_payout_items_order_item_id_fk" FOREIGN KEY ("payout_item_id") REFERENCES "public"."payout_items"("order_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "ledger_entries"
SET "entry_type" = 'adjustment',
    "adjustment_note" = 'Legacy ledger entry migrated to typed ledger'
WHERE "entry_type" IN ('payment_received', 'payout');--> statement-breakpoint
UPDATE "order_items"
SET "commission_amount_kobo" = floor(("price_kobo_at_purchase"::numeric * "quantity" * "commission_rate_bps") / 10000)::integer;--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_commission_rate_bps_range" CHECK ("commission_rate_bps" IS NULL OR "commission_rate_bps" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_commission_rate_bps_range" CHECK ("commission_rate_bps" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_money_nonnegative" CHECK ("price_kobo_at_purchase" >= 0 AND "commission_amount_kobo" >= 0);--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_entry_type_valid" CHECK ("entry_type" IN ('item_sale', 'commission', 'payout_sent', 'payout_reversed', 'refund_clawback', 'adjustment'));--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_adjustment_requires_note" CHECK ("entry_type" <> 'adjustment' OR COALESCE(length(trim("adjustment_note")), 0) > 0);--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_status_valid" CHECK ("status" IN ('pending', 'approved', 'initiated', 'success', 'failed', 'reversed'));--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_item_sale_once" ON "ledger_entries" USING btree ("order_item_id") WHERE "entry_type" = 'item_sale';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_commission_once" ON "ledger_entries" USING btree ("order_item_id") WHERE "entry_type" = 'commission';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_payout_sent_once" ON "ledger_entries" USING btree ("payout_item_id") WHERE "entry_type" = 'payout_sent';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_payout_reversed_once" ON "ledger_entries" USING btree ("payout_item_id") WHERE "entry_type" = 'payout_reversed';--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_update
BEFORE UPDATE OR DELETE ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();