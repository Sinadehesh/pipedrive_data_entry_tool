/**
 * Event-sourced, multi-tenant core.
 *
 * The pipeline is append-only up to the sync boundary:
 *
 *   raw_events     — verbatim webhook payloads (replay source of last resort)
 *   interactions   — the immutable ledger; one row per call/email/meeting
 *   extractions    — versioned LLM output derived from an interaction
 *   sync_outbox    — desired Pipedrive mutations (the only mutable queue)
 *   sync_log       — append-only audit of every Pipedrive write
 *   identity_map   — email -> Pipedrive person/org/deal cache
 *
 * `raw_events`, `interactions`, `extractions`, and `sync_log` must never be
 * UPDATEd or DELETEd by application code. Reprocessing means inserting a new
 * extraction version, never rewriting history.
 *
 * TENANT ISOLATION RULES (every reviewer enforces these):
 *   1. Every tenant-owned table carries a non-null `tenant_id` FK.
 *   2. Every natural key is scoped by tenant — (tenant_id, source,
 *      external_id), (tenant_id, email), etc. Two tenants ingesting the
 *      same Claap recording or caching the same prospect email never
 *      collide and never see each other's rows.
 *   3. Every query in application code filters by tenant_id, always taken
 *      from server-side state (the ledger row, the connection row, the
 *      session) — NEVER from client input.
 *   4. Defense in depth: enable Postgres RLS on these tables in production
 *      (see ARCHITECTURE.md §10) so a missed WHERE clause fails closed.
 */
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  index,
  uuid,
} from "drizzle-orm/pg-core";

import type { CallExtraction } from "@/lib/ai/schemas";
import { users } from "./auth-schema";

export * from "./auth-schema";

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

export const tenantStatus = pgEnum("tenant_status", ["active", "suspended"]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /**
   * The tenant's own email domains. Drives "internal-only thread" filtering
   * and identity resolution (participants on these domains are never
   * prospects). Replaces the old INTERNAL_EMAIL_DOMAINS env var.
   */
  internalDomains: jsonb("internal_domains").$type<string[]>().notNull().default([]),
  /** Days without any interaction before an open deal is flagged stale. */
  stalenessDays: integer("staleness_days").notNull().default(14),
  status: tenantStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const membershipRole = pgEnum("membership_role", ["owner", "member"]);

/**
 * Users (Auth.js, auth-schema.ts) belong to tenants through memberships.
 * The session JWT carries the active tenantId resolved from here — it is
 * the ONLY place a request's tenant may come from.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    role: membershipRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("memberships_user_tenant_uq").on(t.userId, t.tenantId)],
);

// ---------------------------------------------------------------------------
// Connections — per-tenant third-party credentials
// ---------------------------------------------------------------------------

export const connectionProvider = pgEnum("connection_provider", [
  "google",
  "pipedrive",
  "claap",
  "zoom",
]);

export const connectionStatus = pgEnum("connection_status", [
  "active",
  "error", // last renewal / refresh / call failed; needs attention
  "revoked", // user disconnected or the provider revoked the grant
]);

/**
 * Decrypted shapes of `credential_ciphertext` (AES-256-GCM encrypted JSON,
 * src/lib/crypto.ts — never logged, never returned from an Inngest step,
 * since step returns are persisted in Inngest run state).
 */
export type GoogleCredential = { refreshToken: string };
/**
 * Two auth shapes: Marketplace OAuth (Bearer tokens, refreshed by
 * src/lib/pipedrive/account.ts) is the commercial path; a pasted API token
 * (x-api-token, never expires) remains the pilot fallback.
 */
export type PipedriveCredential =
  | { kind: "api_token"; domain: string; apiToken: string }
  | {
      kind: "oauth";
      domain: string;
      accessToken: string;
      refreshToken: string;
      /** ISO timestamp when accessToken expires. */
      expiresAt: string;
    };
export type ClaapCredential = { apiKey: string; webhookSecret: string };
/**
 * Zoom needs only the webhook secret token: transcript downloads use the
 * short-lived download_token Zoom includes in each webhook delivery (kept
 * in raw_events with the verbatim payload, never in Inngest state), so no
 * server-to-server OAuth app is required.
 */
export type ZoomCredential = { webhookSecretToken: string };

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    provider: connectionProvider("provider").notNull(),
    /**
     * Provider-side account identity: mailbox address (google), company
     * domain (pipedrive), workspace id (claap). Webhook routing joins on it.
     */
    accountRef: text("account_ref").notNull(),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    status: connectionStatus("status").notNull().default("active"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Globally unique, not just per tenant: a Pub/Sub notification carries
    // only the mailbox address, so provider-account -> tenant routing must
    // be unambiguous. Connecting an account a second tenant already claimed
    // is rejected at connect time.
    uniqueIndex("connections_provider_account_uq").on(t.provider, t.accountRef),
    index("connections_tenant_idx").on(t.tenantId, t.provider),
  ],
);

/**
 * Watch lifecycle state (tenant derived through connection_id). Google push
 * channels expire SILENTLY (Gmail after 7 days) — without the renewal cron
 * acting on `expiresAt`, ingestion just stops with no error anywhere.
 * `cursor` is the delta position (Gmail historyId; Calendar syncToken in
 * Phase 3) and only advances after the corresponding ledger writes commit.
 */
export const watchChannels = pgTable(
  "watch_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    kind: text("kind", { enum: ["gmail", "gcal"] }).notNull(),
    cursor: text("cursor"),
    /**
     * Calendar channels only: the channel id WE generated for
     * channels.watch (unguessable uuid — doubles as the webhook's
     * authenticity token) and Google's resourceId (needed to stop the old
     * channel on renewal). Gmail watches have neither.
     */
    externalChannelId: text("external_channel_id"),
    externalResourceId: text("external_resource_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("watch_channels_connection_kind_uq").on(t.connectionId, t.kind),
    index("watch_channels_expires_at_idx").on(t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// Field mappings — tenant-specific Pipedrive custom-field wiring
// ---------------------------------------------------------------------------

/** Standard AI outputs a tenant can map to their Pipedrive custom fields. */
export const mappableSignal = pgEnum("mappable_signal", [
  "bant_budget",
  "bant_authority",
  "bant_need",
  "bant_timeline",
  /** Risk flags (stale deal, cancelled meeting) — written to the mapped
   *  field when configured, appended as a note otherwise. */
  "deal_risk",
]);

/**
 * Replaces the hardcoded PIPEDRIVE_FIELD_* env vars: each tenant maps our
 * standard signals to their own Pipedrive custom field keys (the long hash
 * keys from GET /v1/dealFields). No mapping row = that signal is never
 * auto-written for that tenant (it still appears in notes and Postgres).
 */
export const fieldMappings = pgTable(
  "field_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    signal: mappableSignal("signal").notNull(),
    /** Pipedrive deal custom-field key, e.g. "dcf55ac6…" or "cf_12345". */
    pipedriveFieldKey: text("pipedrive_field_key").notNull(),
    /**
     * Optional per-field override of the global 0.8 auto-write floor —
     * e.g. a tenant may accept 0.6 for `need` but demand 0.9 for `budget`.
     */
    minConfidence: real("min_confidence"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("field_mappings_tenant_signal_uq").on(t.tenantId, t.signal)],
);

// ---------------------------------------------------------------------------
// The event-sourced pipeline (all tenant-scoped)
// ---------------------------------------------------------------------------

export const interactionSource = pgEnum("interaction_source", [
  "claap",
  "zoom",
  "gmail",
  "gcal",
]);

export const interactionKind = pgEnum("interaction_kind", [
  "call",
  "email",
  "meeting",
]);

export const extractionStatus = pgEnum("extraction_status", [
  "auto_approved", // confidence cleared the bar; eligible for field writes
  "needs_review", // low confidence; notes only until a human approves
  "rejected", // reviewer declined (or superseded by an edited version)
  "failed", // extraction pipeline exhausted retries
]);

export const outboxOp = pgEnum("outbox_op", [
  "create_note",
  "create_activity",
  "update_deal_fields",
  "flag_deal_risk",
]);

/** Payload of a `flag_deal_risk` outbox row. */
export type DealRiskPayload = {
  dealId: number;
  reason: string;
  source: "staleness" | "meeting_cancelled";
};

export const outboxStatus = pgEnum("outbox_status", [
  "pending",
  "in_flight",
  "completed",
  "deferred", // rate-limited or blocked; retried by the drain cron
  "failed",
]);

export type Participant = {
  email: string;
  name?: string;
  isHost?: boolean;
};

export const rawEvents = pgTable(
  "raw_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    source: interactionSource("source").notNull(),
    externalId: text("external_id").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Webhook redelivery lands on this constraint and becomes a no-op.
    // Tenant-scoped: two tenants may legitimately receive the same event id
    // from a shared provider.
    uniqueIndex("raw_events_tenant_source_external_uq").on(
      t.tenantId,
      t.source,
      t.externalId,
    ),
  ],
);

export const interactions = pgTable(
  "interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    source: interactionSource("source").notNull(),
    externalId: text("external_id").notNull(),
    kind: interactionKind("kind").notNull(),
    title: text("title"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    participants: jsonb("participants").$type<Participant[]>().notNull(),
    /** Full transcript / email body / meeting description. */
    content: text("content").notNull(),
    /**
     * Provider-side conversation grouping — the Gmail thread id today.
     * Thread-level extraction loads every ledger row sharing a key so a
     * five-reply exchange is analyzed once with full context.
     */
    threadKey: text("thread_key"),
    rawEventId: uuid("raw_event_id").references(() => rawEvents.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("interactions_tenant_source_external_uq").on(
      t.tenantId,
      t.source,
      t.externalId,
    ),
    index("interactions_tenant_occurred_idx").on(t.tenantId, t.occurredAt),
    index("interactions_tenant_thread_idx").on(t.tenantId, t.threadKey),
  ],
);

export const extractions = pgTable(
  "extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id),
    /** Monotonic per interaction; re-running extraction appends a version. */
    version: integer("version").notNull(),
    model: text("model").notNull(),
    payload: jsonb("payload").$type<CallExtraction>(),
    overallConfidence: real("overall_confidence"),
    status: extractionStatus("status").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("extractions_interaction_version_uq").on(
      t.interactionId,
      t.version,
    ),
    index("extractions_tenant_idx").on(t.tenantId),
  ],
);

export const syncOutbox = pgTable(
  "sync_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /**
     * Nullable: extraction-driven ops (notes, field updates) reference the
     * ledger; risk flags (staleness sweep, cancelled meetings) carry their
     * target in `payload` instead.
     */
    interactionId: uuid("interaction_id").references(() => interactions.id),
    extractionId: uuid("extraction_id").references(() => extractions.id),
    op: outboxOp("op").notNull(),
    payload: jsonb("payload").notNull(),
    /**
     * Derived from ledger identity (e.g. `note:{interactionId}:v{version}`),
     * so retries and duplicate events can never enqueue the same write
     * twice. Interaction ids are tenant-scoped uuids, so the key is too.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    status: outboxStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** Set when deferred (e.g. Pipedrive 429 retry-after). */
    notBefore: timestamp("not_before", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("sync_outbox_idempotency_key_uq").on(t.idempotencyKey),
    index("sync_outbox_tenant_status_idx").on(t.tenantId, t.status, t.notBefore),
  ],
);

export const syncLog = pgTable(
  "sync_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    outboxId: uuid("outbox_id")
      .notNull()
      .references(() => syncOutbox.id),
    op: outboxOp("op").notNull(),
    pipedriveEntity: text("pipedrive_entity").notNull(), // "note" | "deal" | "activity"
    pipedriveId: integer("pipedrive_id"),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("sync_log_tenant_idx").on(t.tenantId)],
);

/**
 * Denormalized competitor mentions for the intel dashboard — one row per
 * competitor per interaction's CURRENT extraction version. Kept in lockstep
 * by syncCompetitiveIntel(): a replay or reviewer edit replaces the
 * interaction's rows so aggregates always reflect the latest version.
 */
export const intelSentiment = pgEnum("intel_sentiment", [
  "favored",
  "neutral",
  "losing",
]);

export const competitiveIntel = pgTable(
  "competitive_intel",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id),
    extractionId: uuid("extraction_id")
      .notNull()
      .references(() => extractions.id),
    /** Normalized (lowercased, trimmed) for grouping; display uses rawName. */
    competitor: text("competitor").notNull(),
    rawName: text("raw_name").notNull(),
    context: text("context").notNull(),
    sentiment: intelSentiment("sentiment").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("competitive_intel_tenant_competitor_idx").on(
      t.tenantId,
      t.competitor,
    ),
    index("competitive_intel_interaction_idx").on(t.interactionId),
  ],
);

/** Single-use, expiring join links so owners can invite reps. */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** Unguessable 48-hex token — the join URL's path segment. */
    token: text("token").notNull(),
    role: membershipRole("role").notNull().default("member"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByUserId: text("used_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("invites_token_uq").on(t.token)],
);

export const identityMap = pgTable(
  "identity_map",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    email: text("email").notNull(),
    personId: integer("person_id"),
    orgId: integer("org_id"),
    dealId: integer("deal_id"),
    /** "search" (found in Pipedrive) | "created" (we created the person). */
    resolution: text("resolution").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Tenant-scoped: the same prospect email maps to DIFFERENT person ids
    // in different tenants' Pipedrive accounts.
    uniqueIndex("identity_map_tenant_email_uq").on(t.tenantId, t.email),
  ],
);
