ALTER TYPE "public"."mappable_signal" ADD VALUE 'deal_risk';--> statement-breakpoint
ALTER TYPE "public"."outbox_op" ADD VALUE 'flag_deal_risk';--> statement-breakpoint
ALTER TABLE "sync_outbox" ALTER COLUMN "interaction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_outbox" ALTER COLUMN "extraction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "staleness_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "watch_channels" ADD COLUMN "external_channel_id" text;--> statement-breakpoint
ALTER TABLE "watch_channels" ADD COLUMN "external_resource_id" text;