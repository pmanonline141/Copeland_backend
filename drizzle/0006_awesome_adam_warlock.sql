CREATE TABLE "partner_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "partner_documents_storage_path_unique" UNIQUE("storage_path")
);
--> statement-breakpoint
CREATE TABLE "moderation_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"moderator_id" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"colour" text DEFAULT '' NOT NULL,
	"quantity_available" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "company_name" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "cac_number" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "tin" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "partner_type" text DEFAULT 'supplier' NOT NULL;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "bank_account_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_copeland_label" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_documents" ADD CONSTRAINT "partner_documents_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_records" ADD CONSTRAINT "moderation_records_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory" ADD CONSTRAINT "product_inventory_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_inventory_variant_unique" ON "product_inventory" USING btree ("product_id","size","colour");--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;