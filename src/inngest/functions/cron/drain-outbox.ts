import { and, inArray, isNotNull, lte } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { syncOutbox } from "@/lib/db/schema";
import { inngest } from "@/inngest/client";

/**
 * Safety net for deferred writes: every 5 minutes, re-emit
 * `sync/extraction.ready` for outbox rows whose retry-after has elapsed
 * (rate-limited earlier) or that were left pending by a crashed run. The
 * reconciler's idempotency makes re-emission harmless.
 */
export const drainOutbox = inngest.createFunction(
  { id: "drain-outbox", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const due = await step.run("find-due-rows", async () => {
      const rows = await db
        .select({
          tenantId: syncOutbox.tenantId,
          interactionId: syncOutbox.interactionId,
          extractionId: syncOutbox.extractionId,
        })
        .from(syncOutbox)
        .where(
          and(
            inArray(syncOutbox.status, ["deferred", "pending"]),
            isNotNull(syncOutbox.notBefore),
            lte(syncOutbox.notBefore, new Date()),
          ),
        );
      // One event per extraction, not per row.
      const unique = new Map(rows.map((r) => [r.extractionId, r]));
      return [...unique.values()];
    });

    if (due.length > 0) {
      await step.sendEvent(
        "re-emit",
        due.map((r) => ({
          name: "sync/extraction.ready" as const,
          data: {
            tenantId: r.tenantId,
            interactionId: r.interactionId,
            extractionId: r.extractionId,
          },
        })),
      );
    }

    return { reEmitted: due.length };
  },
);
