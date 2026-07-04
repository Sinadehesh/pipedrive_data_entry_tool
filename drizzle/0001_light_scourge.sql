CREATE TYPE "public"."connection_status" AS ENUM('active', 'error', 'revoked');--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"email" text NOT NULL,
	"refresh_token_ciphertext" text NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
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
ALTER TABLE "watch_channels" ADD CONSTRAINT "watch_channels_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_provider_email_uq" ON "connections" USING btree ("provider","email");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_channels_connection_kind_uq" ON "watch_channels" USING btree ("connection_id","kind");--> statement-breakpoint
CREATE INDEX "watch_channels_expires_at_idx" ON "watch_channels" USING btree ("expires_at");