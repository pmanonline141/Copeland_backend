CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfq_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" text,
	"requester_name" text NOT NULL,
	"requester_email" text NOT NULL,
	"requester_phone" text,
	"items" jsonb NOT NULL,
	"details" text,
	"status" text DEFAULT 'new' NOT NULL,
	"quote_amount_kobo" integer,
	"quote_message" text,
	"reviewed_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"shipping_partner_id" uuid NOT NULL,
	"tracking_number" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_tracking_number_unique" UNIQUE("tracking_number")
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_partner_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_requests" ADD CONSTRAINT "rfq_requests_requester_id_user_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_requests" ADD CONSTRAINT "rfq_requests_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_updates" ADD CONSTRAINT "shipment_updates_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_shipping_partner_id_partners_id_fk" FOREIGN KEY ("shipping_partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipping_partner_id_partners_id_fk" FOREIGN KEY ("shipping_partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
UPDATE "products" SET "status" = 'approved' WHERE "status" = 'live';--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_status_valid" CHECK ("status" IN ('pending', 'approved', 'rejected', 'suspended'));--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_type_valid" CHECK ("partner_type" IN ('supplier', 'shipping'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_status_valid" CHECK ("status" IN ('draft', 'submitted', 'approved', 'rejected', 'changes_requested', 'paused'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_money_and_moq_valid" CHECK ("price_kobo" >= 0 AND "moq" > 0 AND "quantity_available" >= 0);--> statement-breakpoint
ALTER TABLE "product_inventory" ADD CONSTRAINT "product_inventory_quantity_nonnegative" CHECK ("quantity_available" >= 0);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_fulfillment_status_valid" CHECK ("fulfillment_status" IN ('pending', 'packed', 'shipped', 'delivered'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_valid" CHECK ("status" IN ('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'completed', 'cancelled', 'disputed'));--> statement-breakpoint
ALTER TABLE "rfq_requests" ADD CONSTRAINT "rfq_requests_status_valid" CHECK ("status" IN ('new', 'in_review', 'quoted', 'accepted', 'declined', 'closed'));--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_status_valid" CHECK ("status" IN ('created', 'picked_up', 'in_transit', 'delivered'));--> statement-breakpoint
CREATE INDEX "products_search_idx" ON "products" USING gin (to_tsvector('simple', "name" || ' ' || "description" || ' ' || "category"));--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_log_no_update
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
--> statement-breakpoint
ALTER TABLE public."user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."partners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."partner_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."product_inventory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."moderation_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."payouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."payout_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."ledger_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."rfq_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."shipments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."shipment_updates" ENABLE ROW LEVEL SECURITY;