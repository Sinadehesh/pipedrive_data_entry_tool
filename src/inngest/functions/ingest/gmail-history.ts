import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  connections,
  interactions,
  tenants,
  watchChannels,
} from "@/lib/db/schema";
import {
  boundedResync,
  getMessage,
  GmailHistoryExpiredError,
  listHistory,
} from "@/lib/google/gmail";
import { shouldIngest } from "@/lib/ingest/relevance";
import { inngest } from "@/inngest/client";

/** Window for the full resync after a stale (404'd) cursor. */
const RESYNC_DAYS = 7;
/** Message fetches per checkpointed step — bounds step count on big deltas. */
const FETCH_BATCH_SIZE = 20;

/**
 * The pull-on-notify loop. The Pub/Sub ping only says "this mailbox
 * changed"; this job pulls the actual delta from OUR stored cursor:
 *
 *   notification -> history.list(startHistoryId=stored cursor)
 *                -> messages.get each new id -> filter -> ledger
 *                -> advance cursor (only after the ledger writes committed)
 *
 * Because the pull always starts from the stored cursor, dropped or
 * collapsed notifications cannot skip messages — any later ping (or the
 * reconciliation sweep) picks up everything since the last successful sync.
 *
 * Multi-tenant: the mailbox address routes to exactly one tenant via the
 * globally-unique (provider, account_ref) index on connections; the
 * tenant's own internalDomains drive the relevance filter, and every ledger
 * row carries tenantId.
 *
 * debounce collapses Gmail's notification bursts (one email can fire
 * several pings); concurrency serializes per mailbox so cursor advances
 * never race.
 */
export const gmailHistory = inngest.createFunction(
  {
    id: "gmail-history-sync",
    retries: 3,
    debounce: { key: "event.data.emailAddress", period: "15s" },
    concurrency: { key: "event.data.emailAddress", limit: 1 },
  },
  { event: "google/gmail.notified" },
  async ({ event, step, logger }) => {
    const ctx = await step.run("load-connection", async () => {
      const [row] = await db
        .select({
          tenantId: connections.tenantId,
          internalDomains: tenants.internalDomains,
          connection: {
            id: connections.id,
            accountRef: connections.accountRef,
            credentialCiphertext: connections.credentialCiphertext,
          },
          channelId: watchChannels.id,
          cursor: watchChannels.cursor,
        })
        .from(connections)
        .innerJoin(tenants, eq(tenants.id, connections.tenantId))
        .innerJoin(
          watchChannels,
          and(
            eq(watchChannels.connectionId, connections.id),
            eq(watchChannels.kind, "gmail"),
          ),
        )
        .where(
          and(
            eq(connections.provider, "google"),
            eq(connections.accountRef, event.data.emailAddress),
            eq(connections.status, "active"),
            eq(tenants.status, "active"),
          ),
        )
        .limit(1);

      if (row) {
        // Heartbeat for the reconcile-sweep: a mailbox that stops
        // notifying gets a proactive delta pull.
        await db
          .update(watchChannels)
          .set({ lastNotifiedAt: new Date(), updatedAt: new Date() })
          .where(eq(watchChannels.id, row.channelId));
      }
      return row ?? null;
    });

    if (!ctx) {
      logger.warn("notification for unknown/inactive mailbox", {
        emailAddress: event.data.emailAddress,
      });
      return { skipped: "no active connection" };
    }

    const internalDomainSet = new Set(
      ctx.internalDomains.map((d) => d.toLowerCase()),
    );

    // Delta pull — or bounded resync when the cursor is stale or missing.
    const delta = await step.run("list-history", async () => {
      if (!ctx.cursor) {
        // Fresh watch with no cursor yet: seed from a bounded resync.
        const r = await boundedResync(ctx.connection, RESYNC_DAYS);
        return { ...r, resynced: true };
      }
      try {
        const r = await listHistory(ctx.connection, ctx.cursor);
        return { ...r, resynced: false };
      } catch (err) {
        if (err instanceof GmailHistoryExpiredError) {
          // Cursor older than Gmail's ~1-week history retention (404).
          // Drop it and rebuild from a bounded window; ledger dedupe makes
          // the overlap with already-ingested messages harmless.
          const r = await boundedResync(ctx.connection, RESYNC_DAYS);
          return { ...r, resynced: true };
        }
        throw err;
      }
    });

    // Fetch + filter + ledger-write in batched checkpointed steps: a batch
    // that fails retries alone, and completed batches are never re-fetched.
    let ingested = 0;
    const changedThreads = new Set<string>();
    for (let i = 0; i < delta.messageIds.length; i += FETCH_BATCH_SIZE) {
      const batch = delta.messageIds.slice(i, i + FETCH_BATCH_SIZE);
      const result = await step.run(`ingest-batch-${i}`, async () => {
        let count = 0;
        const threadIds: string[] = [];
        for (const messageId of batch) {
          const message = await getMessage(ctx.connection, messageId);
          if (!message || !shouldIngest(message, internalDomainSet)) continue;

          const inserted = await db
            .insert(interactions)
            .values({
              tenantId: ctx.tenantId,
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
      ingested += result.count;
      for (const t of result.threadIds) changedThreads.add(t);
    }

    // Advance the cursor LAST — strictly after every ledger write above has
    // committed. A crash anywhere before this step re-runs the delta from
    // the old cursor, and dedupe absorbs the repeats. At-least-once by
    // construction; never at-most-once.
    await step.run("advance-cursor", () =>
      db
        .update(watchChannels)
        .set({
          cursor: delta.newHistoryId,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(watchChannels.id, ctx.channelId)),
    );

    // One event per changed thread. The extractor's debounce collapses
    // reply bursts, so this stays cheap even on chatty threads.
    if (changedThreads.size > 0) {
      await step.sendEvent(
        "notify-threads",
        [...changedThreads].map((threadId) => ({
          name: "gmail/thread.changed" as const,
          data: { tenantId: ctx.tenantId, threadId },
        })),
      );
    }

    return {
      ingested,
      scanned: delta.messageIds.length,
      resynced: delta.resynced,
      cursor: delta.newHistoryId,
    };
  },
);
