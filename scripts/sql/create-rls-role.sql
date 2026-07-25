-- Creates the non-owner role that Postgres RLS actually enforces against.
--
-- WHY THIS EXISTS: a table's OWNER bypasses row level security. If the app
-- talked to Postgres as the owner, migration 0005's policies would be
-- decoration. Request-path queries therefore run as `app_rls`, which owns
-- nothing and is subject to every policy.
--
-- HOW TO RUN (as the database owner / superuser):
--   psql "$DATABASE_URL" -v pw="'<pick-a-strong-password>'" \
--        -f scripts/sql/create-rls-role.sql
--
-- Then set, in Vercel and your local .env:
--   DATABASE_URL_RLS=postgres://app_rls:<that-password>@<same-host>/<same-db>
--
-- Verify with:  npm run doctor
-- It connects as app_rls and proves two things: with no tenant context set
-- the tables return zero rows, and a cross-tenant INSERT is rejected.

\set ON_ERROR_STOP on

-- 1. The role. Login-capable, owns nothing, inherits nothing special.
CREATE ROLE app_rls LOGIN PASSWORD :pw;

-- 2. Read the schema.
GRANT USAGE ON SCHEMA public TO app_rls;

-- 3. Data access on existing tables. Note: NO ownership, and no
--    GRANT ALL — app_rls must never be able to ALTER a policy away.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls;

-- 4. Sequences, for any serial/identity defaults.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rls;

-- 5. Same grants for tables created by FUTURE migrations, so a new
--    tenant-scoped table doesn't silently become unreadable.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rls;

-- 6. Belt and braces: make sure this role can never be mistaken for a
--    superuser and quietly bypass RLS.
ALTER ROLE app_rls NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
