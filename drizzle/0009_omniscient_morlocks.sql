ALTER TABLE "partners" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "application_token_hash" text;