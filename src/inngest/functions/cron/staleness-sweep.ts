import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  syncOutbox,
  tenants,
  type DealRiskPayload,
} from "@/lib/db/schema";
import { inngest } from "@/inngest/client";

/**
 * Two-stage fan-out: freshness isn't only capturing activity — it's
 * surfacing its ABSENCE.
 *
 * Stage 1 (dispatcher) does one cheap query and emits one event per active
 * tenant. Stage 2 (worker) scans a single tenant per invocation. The split
 * is what keeps this horizontally scalable on serverless: a fleet of 5,000
 * tenants is 5,000 small isolated invocations — no single function ever
 * scans the whole database, no tenant's scan can time out another's, and a
 * poison tenant fails (and retries) alone.
 */

// ---------------------------------------------------------------------------
// Stage 1 — the dispatcher
// ---------------------------------------------------------------------------

const DISPATCH_BATCH_SIZE = 256;

export const stalenessDispatch = inngest.createFunction(
  { id: "staleness-dispatch", retries: 2 },
  { cron: "0 3 * * *" }, // nightly, off-peak
  async ({ step }) => {
    const tenantIds = await step.run("list-active-tenants", async () => {
      const rows = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.status, "active"));
      return rows.map((r) => r.id);
    });

    // Fan out in batches; sendEvent is itself checkpointed, so a crashed
    // dispatcher resumes without double-dispatching completed batches
    // (and the worker's idempotency keys absorb any overlap regardless).
    for (let i = 0; i < tenantIds.length; i += DISPATCH_BATCH_SIZE) {
      const batch = tenantIds.slice(i, i + DISPATCH_BATCH_SIZE);
      await step.sendEvent(
        `dispatch-${i}`,
        batch.map((tenantId) => ({
          name: "sync/tenant.staleness.check" as const,
          data: { tenantId },
        })),
      );
    }

    return { dispatched: tenantIds.length };
  },
);

// ---------------------------------------------------------------------------
// Stage 2 — the per-tenant worker
// ---------------------------------------------------------------------------

/** Upper bound of flags enqueued per tenant per night. */
const MAX_FLAGS_PER_RUN = 200;

export const stalenessCheck = inngest.createFunction(
  {
    id: "staleness-check",
    retries: 2,
    // One scan per tenant at a time; a global cap so the nightly herd
    // doesn't monopolize DB connections.
    concurrency: [
      { key: "event.data.tenantId", limit: 1 },
      { limit: 20 },
    ],
  },
  { event: "sync/tenant.staleness.check" },
  async ({ event, step }) => {
    const { tenantId } = event.data;

    const tenant = await step.run("load-tenant", async () => {
      const [row] = await db
        .select({ stalenessDays: tenants.stalenessDays, status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return row ?? null;
    });
    if (!tenant || tenant.status !== "active") {
      return { skipped: "tenant inactive" };
    }

    /**
     * Stale = a deal we know (tenant's identity_map) whose LAST interaction
     * — call, email, or meeting, matched by participant email against the
     * tenant's ledger — is older than the tenant's stalenessDays. Both
     * sides of the join are pinned to this tenantId; the identity_map
     * unique key is (tenant_id, email), so another tenant's rows are
     * unreachable by construction.
     */
    const staleDeals = await step.run("scan-stale-deals", async () => {
      const cutoffDays = tenant.stalenessDays;
      const rows = await db.execute<{
        deal_id: number;
        last_touch: string | null;
      }>(sql`
        SELECT im.deal_id,
               MAX(i.occurred_at)::text AS last_touch
        FROM identity_map im
        LEFT JOIN interactions i
          ON i.tenant_id = im.tenant_id
         AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(i.participants) elem
               WHERE lower(elem->>'email') = im.email
             )
        WHERE im.tenant_id = ${tenantId}
          AND im.deal_id IS NOT NULL
        GROUP BY im.deal_id
        HAVING MAX(i.occurred_at) IS NULL
            OR MAX(i.occurred_at) < now() - make_interval(days => ${cutoffDays})
        LIMIT ${MAX_FLAGS_PER_RUN}
      `);
      return [...rows];
    });

    if (staleDeals.length === 0) {
      return { flagged: 0 };
    }

    // Enqueue outbox mutations — NO direct Pipedrive calls here. All CRM
    // writes flow through the per-tenant single-writer reconciler, so the
    // sweep can never compete with live syncs for the tenant's API budget.
    const flagged = await step.run("enqueue-risk-flags", async () => {
      const isoWeek = isoWeekStamp(new Date());
      let count = 0;
      for (const deal of staleDeals) {
        const payload: DealRiskPayload = {
          dealId: deal.deal_id,
          reason: deal.last_touch
            ? `No activity in ${tenant.stalenessDays}+ days (last touch ${deal.last_touch.slice(0, 10)})`
            : `No activity ever recorded (${tenant.stalenessDays}-day threshold)`,
          source: "staleness",
        };
        const inserted = await db
          .insert(syncOutbox)
          .values({
            tenantId,
            op: "flag_deal_risk",
            payload,
            // At most one staleness flag per deal per ISO week: nightly
            // re-scans of a still-stale deal land on the conflict, but a
            // deal that recovers and goes stale again IS re-flagged.
            idempotencyKey: `risk:stale:${tenantId}:${deal.deal_id}:${isoWeek}`,
          })
          .onConflictDoNothing()
          .returning({ id: syncOutbox.id });
        if (inserted.length > 0) count++;
      }
      return count;
    });

    if (flagged > 0) {
      await step.sendEvent("enqueue-sync", {
        name: "sync/outbox.ready",
        data: { tenantId },
      });
    }

    return { flagged, scanned: staleDeals.length };
  },
);

/** "2026-W27" — stable within a week, rolls over Monday. */
function isoWeekStamp(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
