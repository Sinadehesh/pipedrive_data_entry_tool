ALTER TYPE "public"."connection_provider" ADD VALUE 'zoom';--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "thread_key" text;--> statement-breakpoint
CREATE INDEX "interactions_tenant_thread_idx" ON "interactions" USING btree ("tenant_id","thread_key");