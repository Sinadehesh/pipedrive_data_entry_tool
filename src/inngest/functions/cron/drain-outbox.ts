import { and, inArray, isNotNull, lte } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { syncOutbox } from "@/lib/db/schema";
import { inngest } from "@/inngest/client";

/**
 * Safety net for deferred writes: every 5 minutes, nudge the reconciler for
 * any tenant with outbox rows whose retry-after has elapsed (rate-limited
 * earlier) or that were left pending by a crashed run. One event per
 * tenant — the reconciler drains everything due for that tenant, and its
 * idempotency makes repeated nudges harmless.
 */
export const drainOutbox = inngest.createFunction(
  { id: "drain-outbox", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const tenantIds = await step.run("find-due-tenants", async () => {
      const rows = await db
        .selectDistinct({ tenantId: syncOutbox.tenantId })
        .from(syncOutbox)
        .where(
          and(
            inArray(syncOutbox.status, ["deferred", "pending"]),
            isNotNull(syncOutbox.notBefore),
            lte(syncOutbox.notBefore, new Date()),
          ),
        );
      return rows.map((r) => r.tenantId);
    });

    if (tenantIds.length > 0) {
      await step.sendEvent(
        "re-emit",
        tenantIds.map((tenantId) => ({
          name: "sync/outbox.ready" as const,
          data: { tenantId },
        })),
      );
    }

    return { tenantsNudged: tenantIds.length };
  },
);
