-- Row Level Security: the database-level fail-safe against cross-tenant
-- bugs in application code.
--
-- Model (see src/lib/db/client.ts):
--   * Policies match rows where tenant_id equals the transaction-local GUC
--     app.tenant_id, set via set_config('app.tenant_id', $1, true) inside a
--     transaction. `true` (missing_ok) means an UNSET GUC yields NULL,
--     which matches no rows — fail closed.
--   * RLS is ENABLEd but not FORCEd: the table OWNER (migrations, the
--     trusted pipeline pool whose tenant ids come from verified events)
--     bypasses policies. Enforcement applies to the dedicated non-owner
--     role used by the request-path pool, where session-derived input
--     lives. One-time role setup per environment:
--
--       CREATE ROLE app_rls LOGIN PASSWORD '...';
--       GRANT USAGE ON SCHEMA public TO app_rls;
--       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls;
--       ALTER DEFAULT PRIVILEGES IN SCHEMA public
--         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rls;
--
--     ...and point DATABASE_URL_RLS at that role.
--
-- Deliberately NOT under RLS:
--   * users / accounts / sessions / verification_tokens — Auth.js tables,
--     keyed by user not tenant.
--   * memberships — must be readable BEFORE tenant context exists (it is
--     how a session's tenant gets resolved); joins in the jwt callback run
--     on the owner pool.
--   * watch_channels — carries no tenant_id (tenant derives through
--     connection_id); only touched by the pipeline pool.
--   * tenants — the row itself is the tenant; request paths read it only
--     through tenant-scoped joins.

ALTER TABLE "raw_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "raw_events"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "interactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "interactions"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "extractions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "extractions"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "sync_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sync_outbox"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "sync_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sync_log"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "identity_map" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "identity_map"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connections"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "field_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "field_mappings"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "competitive_intel" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "competitive_intel"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invites"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);
