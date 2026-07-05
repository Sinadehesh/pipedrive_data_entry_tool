import { and, eq, inArray, lte } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { connections, watchChannels } from "@/lib/db/schema";
import {
  startCalendarWatch,
  stopCalendarWatch,
} from "@/lib/google/calendar";
import { startWatch as startGmailWatch } from "@/lib/google/gmail";
import { inngest } from "@/inngest/client";

/**
 * The heartbeat of the ingestion plane, across ALL tenants.
 *
 * Google push channels expire SILENTLY — Gmail watches after 7 days,
 * Calendar channels at a TTL Google chooses — with no error and no
 * callback; notifications just stop. This cron runs every 6 hours and
 * re-arms every gmail/gcal channel expiring within the next 24, so a
 * single failed run still leaves three more attempts before any channel
 * lapses.
 *
 * SaaS-scale isolation: each channel renews inside its OWN try/catch —
 * one tenant's revoked grant or Google-side error records the failure on
 * that channel/connection and the loop continues to the next tenant.
 * Renewal work is batched into checkpointed steps so a crashed run resumes
 * where it stopped instead of restarting the whole fleet.
 *
 * Cursor rule: renewal NEVER touches an existing delta cursor. Gmail's
 * watch() returns the mailbox's current historyId and overwriting ours
 * would silently skip everything since the last sync — it seeds only
 * channels that have no cursor yet. Calendar renewal rotates the channel
 * id/resourceId (stopping the superseded channel best-effort) and leaves
 * the syncToken alone entirely.
 */
const RENEW_BATCH_SIZE = 10;

export const renewWatches = inngest.createFunction(
  { id: "renew-watches", retries: 2 },
  { cron: "0 */6 * * *" },
  async ({ step, logger }) => {
    const expiring = await step.run("find-expiring", () =>
      db
        .select({
          channelId: watchChannels.id,
          kind: watchChannels.kind,
          cursor: watchChannels.cursor,
          externalChannelId: watchChannels.externalChannelId,
          externalResourceId: watchChannels.externalResourceId,
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
            inArray(watchChannels.kind, ["gmail", "gcal"]),
            eq(connections.status, "active"),
            lte(
              watchChannels.expiresAt,
              new Date(Date.now() + 24 * 60 * 60 * 1000),
            ),
          ),
        )
        .orderBy(watchChannels.expiresAt),
    );

    let renewed = 0;
    const failures: string[] = [];

    // Batched checkpointed steps: bounded invocation time per step at any
    // fleet size, and completed batches never re-run after a crash.
    for (let i = 0; i < expiring.length; i += RENEW_BATCH_SIZE) {
      const batch = expiring.slice(i, i + RENEW_BATCH_SIZE);
      const results = await step.run(`renew-batch-${i}`, async () => {
        const out: { accountRef: string; kind: string; ok: boolean }[] = [];
        for (const channel of batch) {
          // Per-channel isolation: one failing tenant cannot halt the loop.
          try {
            await renewOne(channel);
            out.push({
              accountRef: channel.connection.accountRef,
              kind: channel.kind,
              ok: true,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await db
              .update(watchChannels)
              .set({ lastError: message, updatedAt: new Date() })
              .where(eq(watchChannels.id, channel.channelId));
            await db
              .update(connections)
              .set({
                status: "error",
                lastError: `${channel.kind} watch renewal failed: ${message}`,
                updatedAt: new Date(),
              })
              .where(eq(connections.id, channel.connection.id));
            out.push({
              accountRef: channel.connection.accountRef,
              kind: channel.kind,
              ok: false,
            });
          }
        }
        return out;
      });

      for (const r of results) {
        if (r.ok) renewed++;
        else failures.push(`${r.kind}:${r.accountRef}`);
      }
    }

    if (failures.length > 0) {
      // Surfaces in Inngest's run log/alerting; wire to Slack/pager later.
      logger.error(
        "watch renewal failures — ingestion will stop for these channels",
        { failures },
      );
    }

    return { checked: expiring.length, renewed, failed: failures };
  },
);

type ExpiringChannel = {
  channelId: string;
  kind: "gmail" | "gcal";
  cursor: string | null;
  externalChannelId: string | null;
  externalResourceId: string | null;
  connection: {
    id: string;
    accountRef: string;
    credentialCiphertext: string;
  };
};

async function renewOne(channel: ExpiringChannel): Promise<void> {
  if (channel.kind === "gmail") {
    const watch = await startGmailWatch(channel.connection);
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
    return;
  }

  // gcal: arm the replacement first, persist it, then stop the old channel
  // (best-effort) — never a window with no live channel.
  const watch = await startCalendarWatch(channel.connection);
  await db
    .update(watchChannels)
    .set({
      externalChannelId: watch.channelId,
      externalResourceId: watch.resourceId,
      expiresAt: watch.expiresAt,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(watchChannels.id, channel.channelId));
  if (channel.externalChannelId && channel.externalResourceId) {
    await stopCalendarWatch(
      channel.connection,
      channel.externalChannelId,
      channel.externalResourceId,
    );
  }
}
