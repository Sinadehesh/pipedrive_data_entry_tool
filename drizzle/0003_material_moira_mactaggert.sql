CREATE TYPE "public"."intel_sentiment" AS ENUM('favored', 'neutral', 'losing');--> statement-breakpoint
ALTER TYPE "public"."extraction_status" ADD VALUE 'rejected' BEFORE 'failed';--> statement-breakpoint
CREATE TABLE "competitive_intel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"competitor" text NOT NULL,
	"raw_name" text NOT NULL,
	"context" text NOT NULL,
	"sentiment" "intel_sentiment" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token" text NOT NULL,
	"role" "membership_role" DEFAULT 'member' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competitive_intel" ADD CONSTRAINT "competitive_intel_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitive_intel" ADD CONSTRAINT "competitive_intel_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitive_intel" ADD CONSTRAINT "competitive_intel_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_user_id_users_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitive_intel_tenant_competitor_idx" ON "competitive_intel" USING btree ("tenant_id","competitor");--> statement-breakpoint
CREATE INDEX "competitive_intel_interaction_idx" ON "competitive_intel" USING btree ("interaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_uq" ON "invites" USING btree ("token");