import { and, eq, lte } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { connections, watchChannels } from "@/lib/db/schema";
import { startWatch } from "@/lib/google/gmail";
import { inngest } from "@/inngest/client";

/**
 * The heartbeat of the ingestion plane.
 *
 * Gmail watches hard-expire after 7 days, and expiry is SILENT — no error,
 * no callback, notifications just stop. This cron runs every 6 hours and
 * re-arms every gmail channel expiring within the next 24, so a single
 * failed run still leaves three more attempts before any watch lapses.
 *
 * Renewal preserves the stored delta cursor: users.watch() returns the
 * mailbox's CURRENT historyId, and overwriting our cursor with it would
 * silently skip every message between the last sync and now. The watch
 * response's historyId is used only to seed channels that have no cursor
 * yet (first arm after OAuth connect).
 */
export const renewWatches = inngest.createFunction(
  { id: "renew-watches", retries: 2 },
  { cron: "0 */6 * * *" },
  async ({ step, logger }) => {
    const expiring = await step.run("find-expiring", () =>
      db
        .select({
          channelId: watchChannels.id,
          cursor: watchChannels.cursor,
          expiresAt: watchChannels.expiresAt,
          connection: {
            id: connections.id,
            accountRef: connections.accountRef,
            credentialCiphertext: connections.credentialCiphertext,
          },
        })
        .from(watchChannels)
        .innerJoin(connections, eq(watchChannels.connectionId, connections.id))
        .where(
          and(
            eq(watchChannels.kind, "gmail"),
            eq(connections.status, "active"),
            lte(
              watchChannels.expiresAt,
              new Date(Date.now() + 24 * 60 * 60 * 1000),
            ),
          ),
        ),
    );

    let renewed = 0;
    const failures: string[] = [];

    // One step per mailbox: a single revoked grant must not block the
    // renewals behind it.
    for (const channel of expiring) {
      const ok = await step.run(
        `renew-${channel.connection.accountRef}`,
        async () => {
          try {
            const watch = await startWatch(channel.connection);
            await db
              .update(watchChannels)
              .set({
                expiresAt: watch.expiresAt,
                // Seed the cursor ONLY if we never had one; see docblock.
                ...(channel.cursor ? {} : { cursor: watch.historyId }),
                lastError: null,
                updatedAt: new Date(),
              })
              .where(eq(watchChannels.id, channel.channelId));
            return true;
          } catch (err) {
            // Record the failure and flag the connection — this is the one
            // place a dying integration becomes visible before data stops.
            const message = err instanceof Error ? err.message : String(err);
            await db
              .update(watchChannels)
              .set({ lastError: message, updatedAt: new Date() })
              .where(eq(watchChannels.id, channel.channelId));
            await db
              .update(connections)
              .set({
                status: "error",
                lastError: `watch renewal failed: ${message}`,
                updatedAt: new Date(),
              })
              .where(eq(connections.id, channel.connection.id));
            return false;
          }
        },
      );
      if (ok) renewed++;
      else failures.push(channel.connection.accountRef);
    }

    if (failures.length > 0) {
      // Surfaces in Inngest's run log/alerting; wire to Slack/pager later.
      logger.error("watch renewal failures — ingestion will stop for these mailboxes", {
        failures,
      });
    }

    return { checked: expiring.length, renewed, failed: failures };
  },
);
