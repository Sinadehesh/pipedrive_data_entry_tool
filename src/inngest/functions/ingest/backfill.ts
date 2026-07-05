import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { connections, interactions, tenants } from "@/lib/db/schema";
import { listEventsDelta } from "@/lib/google/calendar";
import { boundedResync, getMessage } from "@/lib/google/gmail";
import { inngest } from "@/inngest/client";
import { shouldIngest } from "./gmail-history";

/** Hard ceiling on messages pulled per backfill, regardless of window. */
const MAX_BACKFILL_MESSAGES = 2_000;
const FETCH_BATCH_SIZE = 20;

/**
 * Day-one completeness: when a tenant connects Google, import a bounded
 * window (default 90 days) of history through the IDENTICAL ledger ->
 * extract -> sync path the live planes use. One pipeline, three tempos:
 * real-time (push), hourly (reconciliation), once (this).
 *
 * Two invariants keep backfill safe to run at any time:
 *   - It NEVER touches watch cursors — those belong to the notify path and
 *     the renewal cron. Overlap between backfilled and live-ingested
 *     messages is absorbed by the ledger's (tenant, source, external_id)
 *     dedupe.
 *   - Historical CANCELLED meetings are ignored: a demo cancelled two
 *     months ago is not a fresh risk signal, and flagging it on connect
 *     day would spray noise into the tenant's CRM.
 *
 * Downstream extraction happens through the same debounced/queued
 * functions as live traffic, so a big backfill queues gracefully behind
 * the tenant's concurrency caps instead of stampeding the LLM or
 * Pipedrive budgets.
 */
export const backfillConnection = inngest.createFunction(
  {
    id: "backfill-connection",
    retries: 2,
    // One backfill per connection at a time; re-requests are harmless
    // (dedupe) but shouldn't run concurrently.
    concurrency: { key: "event.data.connectionId", limit: 1 },
  },
  { event: "connection/backfill.requested" },
  async ({ event, step, logger }) => {
    const { tenantId, connectionId, days } = event.data;

    const ctx = await step.run("load-connection", async () => {
      const [row] = await db
        .select({
          internalDomains: tenants.internalDomains,
          connection: {
            id: connections.id,
            accountRef: connections.accountRef,
            credentialCiphertext: connections.credentialCiphertext,
          },
        })
        .from(connections)
        .innerJoin(tenants, eq(tenants.id, connections.tenantId))
        .where(
          and(
            eq(connections.id, connectionId),
            eq(connections.tenantId, tenantId),
            eq(connections.provider, "google"),
            eq(connections.status, "active"),
          ),
        )
        .limit(1);
      return row ?? null;
    });

    if (!ctx) {
      logger.warn("backfill requested for unknown/inactive connection", {
        connectionId,
      });
      return { skipped: "no active connection" };
    }

    const internalDomainSet = new Set(
      ctx.internalDomains.map((d) => d.toLowerCase()),
    );

    // ---- Gmail: list the window, then fetch/filter/ledger in batches ----
    const mail = await step.run("list-gmail-window", () =>
      boundedResync(ctx.connection, days, MAX_BACKFILL_MESSAGES),
    );

    let emailsIngested = 0;
    const changedThreads = new Set<string>();
    for (let i = 0; i < mail.messageIds.length; i += FETCH_BATCH_SIZE) {
      const batch = mail.messageIds.slice(i, i + FETCH_BATCH_SIZE);
      const result = await step.run(`ingest-mail-${i}`, async () => {
        let count = 0;
        const threadIds: string[] = [];
        for (const messageId of batch) {
          const message = await getMessage(ctx.connection, messageId);
          if (!message || !shouldIngest(message, internalDomainSet)) continue;
          const inserted = await db
            .insert(interactions)
            .values({
              tenantId,
              source: "gmail",
              externalId: message.id,
              kind: "email",
              title: message.subject,
              occurredAt: new Date(message.internalDate),
              participants: message.participants,
              content: message.bodyText,
              threadKey: message.threadId,
            })
            .onConflictDoNothing()
            .returning({ id: interactions.id });
          if (inserted.length > 0) {
            count++;
            threadIds.push(message.threadId);
          }
        }
        return { count, threadIds };
      });
      emailsIngested += result.count;
      for (const t of result.threadIds) changedThreads.add(t);
    }

    // ---- Calendar: bounded initial window, upserts only ----
    const meetings = await step.run("ingest-calendar-window", async () => {
      // null cursor -> updatedMin window listing; the returned syncToken is
      // deliberately DISCARDED (cursor ownership stays with the notify path).
      const delta = await listEventsDelta(ctx.connection, null, days);
      const ids: string[] = [];
      for (const ev of delta.events) {
        if (ev.status === "cancelled" || !ev.startAt) continue;
        const external = ev.attendees.some((a) => {
          const domain = a.email.split("@")[1]?.toLowerCase();
          return domain && !internalDomainSet.has(domain);
        });
        if (!external) continue;
        const inserted = await db
          .insert(interactions)
          .values({
            tenantId,
            source: "gcal",
            externalId: ev.id,
            kind: "meeting",
            title: ev.summary,
            occurredAt: new Date(ev.startAt),
            participants: ev.attendees,
            content: ev.description ?? ev.summary ?? "(no description)",
          })
          .onConflictDoNothing()
          .returning({ id: interactions.id });
        if (inserted.length > 0) ids.push(inserted[0].id);
      }
      return ids;
    });

    // ---- Hand everything to the normal extraction pipeline ----
    if (changedThreads.size > 0) {
      await step.sendEvent(
        "notify-threads",
        [...changedThreads].map((threadId) => ({
          name: "gmail/thread.changed" as const,
          data: { tenantId, threadId },
        })),
      );
    }
    if (meetings.length > 0) {
      await step.sendEvent(
        "notify-meetings",
        meetings.map((interactionId) => ({
          name: "gcal/meeting.ingested" as const,
          data: { tenantId, interactionId },
        })),
      );
    }

    return {
      emailsScanned: mail.messageIds.length,
      emailsIngested,
      threads: changedThreads.size,
      meetingsIngested: meetings.length,
    };
  },
);
