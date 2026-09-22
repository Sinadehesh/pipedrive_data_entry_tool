CREATE TABLE "sandbox_writes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_body" jsonb,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_writes" ADD CONSTRAINT "sandbox_writes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_writes_tenant_idx" ON "sandbox_writes" USING btree ("tenant_id","created_at");--> statement-breakpoint
-- sandbox_writes is tenant-scoped, so it joins the isolation regime from
-- migration 0005. Sandbox data is synthetic, but it is derived from a
-- tenant's real transcripts and emails — the note bodies quote prospects
-- verbatim — so it is exactly as confidential as sync_log.
ALTER TABLE "sandbox_writes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sandbox_writes"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);
