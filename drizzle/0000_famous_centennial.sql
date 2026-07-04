CREATE TYPE "public"."connection_provider" AS ENUM('google', 'pipedrive', 'claap');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'error', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('auto_approved', 'needs_review', 'failed');--> statement-breakpoint
CREATE TYPE "public"."interaction_kind" AS ENUM('call', 'email', 'meeting');--> statement-breakpoint
CREATE TYPE "public"."interaction_source" AS ENUM('claap', 'zoom', 'gmail', 'gcal');--> statement-breakpoint
CREATE TYPE "public"."mappable_signal" AS ENUM('bant_budget', 'bant_authority', 'bant_need', 'bant_timeline');--> statement-breakpoint
CREATE TYPE "public"."outbox_op" AS ENUM('create_note', 'create_activity', 'update_deal_fields');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'in_flight', 'completed', 'deferred', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "connection_provider" NOT NULL,
	"account_ref" text NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"model" text NOT NULL,
	"payload" jsonb,
	"overall_confidence" real,
	"status" "extraction_status" NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"signal" "mappable_signal" NOT NULL,
	"pipedrive_field_key" text NOT NULL,
	"min_confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"person_id" integer,
	"org_id" integer,
	"deal_id" integer,
	"resolution" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" "interaction_source" NOT NULL,
	"external_id" text NOT NULL,
	"kind" "interaction_kind" NOT NULL,
	"title" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"participants" jsonb NOT NULL,
	"content" text NOT NULL,
	"raw_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" "interaction_source" NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outbox_id" uuid NOT NULL,
	"op" "outbox_op" NOT NULL,
	"pipedrive_entity" text NOT NULL,
	"pipedrive_id" integer,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"op" "outbox_op" NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"internal_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"cursor" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_notified_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_mappings" ADD CONSTRAINT "field_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_map" ADD CONSTRAINT "identity_map_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_raw_event_id_raw_events_id_fk" FOREIGN KEY ("raw_event_id") REFERENCES "public"."raw_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_events" ADD CONSTRAINT "raw_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_outbox_id_sync_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."sync_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_channels" ADD CONSTRAINT "watch_channels_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_provider_account_uq" ON "connections" USING btree ("provider","account_ref");--> statement-breakpoint
CREATE INDEX "connections_tenant_idx" ON "connections" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "extractions_interaction_version_uq" ON "extractions" USING btree ("interaction_id","version");--> statement-breakpoint
CREATE INDEX "extractions_tenant_idx" ON "extractions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "field_mappings_tenant_signal_uq" ON "field_mappings" USING btree ("tenant_id","signal");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_map_tenant_email_uq" ON "identity_map" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_tenant_source_external_uq" ON "interactions" USING btree ("tenant_id","source","external_id");--> statement-breakpoint
CREATE INDEX "interactions_tenant_occurred_idx" ON "interactions" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_events_tenant_source_external_uq" ON "raw_events" USING btree ("tenant_id","source","external_id");--> statement-breakpoint
CREATE INDEX "sync_log_tenant_idx" ON "sync_log" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_outbox_idempotency_key_uq" ON "sync_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "sync_outbox_tenant_status_idx" ON "sync_outbox" USING btree ("tenant_id","status","not_before");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_channels_connection_kind_uq" ON "watch_channels" USING btree ("connection_id","kind");--> statement-breakpoint
CREATE INDEX "watch_channels_expires_at_idx" ON "watch_channels" USING btree ("expires_at");