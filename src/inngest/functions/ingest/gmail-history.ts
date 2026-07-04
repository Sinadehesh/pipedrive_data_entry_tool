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
  type GmailMessage,
} from "@/lib/google/gmail";
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
    for (let i = 0; i < delta.messageIds.length; i += FETCH_BATCH_SIZE) {
      const batch = delta.messageIds.slice(i, i + FETCH_BATCH_SIZE);
      ingested += await step.run(`ingest-batch-${i}`, async () => {
        let count = 0;
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
            })
            .onConflictDoNothing()
            .returning({ id: interactions.id });
          if (inserted.length > 0) count++;
        }
        return count;
      });
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

    // TODO(Phase 2b): emit a thread-debounced "gmail/thread.changed" event
    // here so extract-email-thread analyzes the whole thread once per burst
    // of replies, then flows into the same sync/extraction.ready path as
    // calls.

    return {
      ingested,
      scanned: delta.messageIds.length,
      resynced: delta.resynced,
      cursor: delta.newHistoryId,
    };
  },
);

/**
 * CRM-relevance filter. Two hard rules from the architecture:
 *
 *   1. Internal-only threads are noise — at least one correspondent must be
 *      outside the TENANT's internalDomains.
 *   2. Automated/bulk mail is noise — List-Unsubscribe or Precedence:
 *      bulk/list headers, or a no-reply sender, mean a machine wrote it.
 *
 * Also skips drafts/chats/spam/trash by label. Deliberately permissive
 * beyond that: a false positive costs one harmless ledger row, a false
 * negative silently loses relationship history.
 */
export function shouldIngest(
  message: GmailMessage,
  internalDomainSet: Set<string>,
): boolean {
  const skipLabels = ["DRAFT", "CHAT", "SPAM", "TRASH"];
  if (message.labelIds.some((l) => skipLabels.includes(l))) return false;

  // Newsletters, receipts, CI noise, calendar robots.
  if (message.hasListUnsubscribe) return false;
  const precedence = message.precedence?.toLowerCase();
  if (precedence === "bulk" || precedence === "list") return false;
  if (message.fromEmail && /^(no[-._]?reply|do[-._]?not[-._]?reply)@/.test(message.fromEmail)) {
    return false;
  }

  // Internal-only thread: every correspondent is on a tenant domain.
  const hasExternal = message.participants.some((p) => {
    const domain = p.email.split("@")[1]?.toLowerCase();
    return domain && !internalDomainSet.has(domain);
  });
  if (!hasExternal) return false;

  // Nothing extractable.
  if (message.bodyText.trim().length === 0) return false;

  return true;
}
