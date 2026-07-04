/**
 * Event-sourced core.
 *
 * The pipeline is append-only up to the sync boundary:
 *
 *   raw_events    — verbatim webhook payloads (replay source of last resort)
 *   interactions  — the immutable ledger; one row per call/email/meeting
 *   extractions   — versioned LLM output derived from an interaction
 *   sync_outbox   — desired Pipedrive mutations (the only mutable queue)
 *   sync_log      — append-only audit of every Pipedrive write
 *   identity_map  — email -> Pipedrive person/org/deal cache
 *
 * `raw_events`, `interactions`, `extractions`, and `sync_log` must never be
 * UPDATEd or DELETEd by application code. Reprocessing means inserting a new
 * extraction version, never rewriting history.
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
  "failed", // extraction pipeline exhausted retries
]);

export const outboxOp = pgEnum("outbox_op", [
  "create_note",
  "create_activity",
  "update_deal_fields",
]);

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
    source: interactionSource("source").notNull(),
    externalId: text("external_id").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Webhook redelivery lands on this constraint and becomes a no-op.
    uniqueIndex("raw_events_source_external_id_uq").on(t.source, t.externalId),
  ],
);

export const interactions = pgTable(
  "interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: interactionSource("source").notNull(),
    externalId: text("external_id").notNull(),
    kind: interactionKind("kind").notNull(),
    title: text("title"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    participants: jsonb("participants").$type<Participant[]>().notNull(),
    /** Full transcript / email body / meeting description. */
    content: text("content").notNull(),
    rawEventId: uuid("raw_event_id").references(() => rawEvents.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("interactions_source_external_id_uq").on(
      t.source,
      t.externalId,
    ),
    index("interactions_occurred_at_idx").on(t.occurredAt),
  ],
);

export const extractions = pgTable(
  "extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  ],
);

export const syncOutbox = pgTable(
  "sync_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id),
    extractionId: uuid("extraction_id")
      .notNull()
      .references(() => extractions.id),
    op: outboxOp("op").notNull(),
    payload: jsonb("payload").notNull(),
    /**
     * Derived from ledger identity (e.g. `note:{interactionId}:v{version}`),
     * so retries and duplicate events can never enqueue the same write twice.
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
    index("sync_outbox_status_idx").on(t.status, t.notBefore),
  ],
);

export const syncLog = pgTable("sync_log", {
  id: uuid("id").primaryKey().defaultRandom(),
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
});

export const identityMap = pgTable(
  "identity_map",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  (t) => [uniqueIndex("identity_map_email_uq").on(t.email)],
);
