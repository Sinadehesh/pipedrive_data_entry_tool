import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  extractions,
  interactions,
  syncLog,
  syncOutbox,
} from "@/lib/db/schema";
import { resolveIdentity, type ResolvedIdentity } from "@/lib/identity/resolve";
import { PipedriveRateLimitError } from "@/lib/pipedrive/client";
import { createNote, updateDealCustomFields } from "@/lib/pipedrive/records";
import {
  buildDealFieldUpdate,
  renderNoteHtml,
} from "@/lib/pipedrive/write-policy";
import { inngest } from "@/inngest/client";

/**
 * Drains the sync_outbox into Pipedrive.
 *
 * Token-budget protection (Pipedrive rate limiting is a daily token pool per
 * company plus burst limits — naive parallel jobs exhaust it in bursts):
 *
 *   - `concurrency` with a single constant key serializes ALL Pipedrive
 *     writes across every concurrent extraction — one writer, ever.
 *   - `throttle` paces executions so a burst of ten calls ending at 10:30
 *     queues gracefully instead of tripping the burst limit.
 *   - A 429 inside a step defers the outbox row with Pipedrive's
 *     retry-after; the drain cron re-emits it later. Deferred, not dropped.
 *
 * Every outbox row executes at most once per status transition, and its
 * idempotency key is derived from ledger identity — so retries, duplicate
 * events, and concurrent triggers cannot double-write a note or field.
 */
export const reconcilePipedrive = inngest.createFunction(
  {
    id: "reconcile-pipedrive",
    retries: 4,
    concurrency: { key: `"pipedrive"`, limit: 1 },
    throttle: { limit: 30, period: "60s" },
  },
  { event: "sync/extraction.ready" },
  async ({ event, step }) => {
    // Claim pending rows for this extraction (status transition = the lock).
    const claimed = await step.run("claim-outbox", async () => {
      const rows = await db
        .select({ id: syncOutbox.id, op: syncOutbox.op })
        .from(syncOutbox)
        .where(
          and(
            eq(syncOutbox.extractionId, event.data.extractionId),
            inArray(syncOutbox.status, ["pending", "deferred"]),
            or(
              isNull(syncOutbox.notBefore),
              lte(syncOutbox.notBefore, new Date()),
            ),
          ),
        );
      if (rows.length === 0) return [];
      await db
        .update(syncOutbox)
        .set({ status: "in_flight", updatedAt: new Date() })
        .where(
          inArray(
            syncOutbox.id,
            rows.map((r) => r.id),
          ),
        );
      return rows;
    });

    if (claimed.length === 0) return { synced: 0 };

    const context = await step.run("load-context", async () => {
      const [interaction] = await db
        .select()
        .from(interactions)
        .where(eq(interactions.id, event.data.interactionId))
        .limit(1);
      const [extraction] = await db
        .select()
        .from(extractions)
        .where(eq(extractions.id, event.data.extractionId))
        .limit(1);
      return { interaction, extraction };
    });

    if (!context.extraction?.payload) {
      return { synced: 0, skipped: "no extraction payload" };
    }

    // Identity resolution is itself Pipedrive-API-bound, so it runs inside
    // the same serialized/throttled function. Cache-first via identity_map.
    const identity = await step.run("resolve-identity", () =>
      resolveIdentity(context.interaction.participants),
    );

    let synced = 0;
    for (const row of claimed) {
      await step.run(`op-${row.op}-${row.id}`, () =>
        executeOp(row.id, row.op, context, identity),
      );
      synced++;
    }

    return { synced, dealId: identity?.dealId ?? null };
  },
);

// step.run() returns are JSON-serialized, so Date columns arrive as strings.
type Context = {
  interaction: Pick<typeof interactions.$inferSelect, "title" | "participants"> & {
    occurredAt: string | Date;
  };
  extraction: Pick<typeof extractions.$inferSelect, "payload">;
};

async function executeOp(
  outboxId: string,
  op: typeof syncOutbox.$inferSelect.op,
  context: Context,
  identity: ResolvedIdentity | null,
): Promise<void> {
  const payload = context.extraction.payload!;

  try {
    if (op === "create_note") {
      const note = await createNote({
        content: renderNoteHtml(payload, {
          title: context.interaction.title,
          occurredAt: context.interaction.occurredAt.toString(),
        }),
        dealId: identity?.dealId,
        personId: identity?.personId,
      });
      await complete(outboxId, op, "note", note.id);
      return;
    }

    if (op === "update_deal_fields") {
      if (!identity?.dealId) {
        await fail(outboxId, "no open deal for participants");
        return;
      }
      const fields = buildDealFieldUpdate(payload);
      if (Object.keys(fields).length === 0) {
        await complete(outboxId, op, "deal", identity.dealId, {
          note: "no fields cleared the confidence bar or no field keys configured",
        });
        return;
      }
      await updateDealCustomFields(identity.dealId, fields);
      await complete(outboxId, op, "deal", identity.dealId, { fields });
      return;
    }

    await fail(outboxId, `unhandled op ${op}`);
  } catch (err) {
    if (err instanceof PipedriveRateLimitError) {
      // Defer with Pipedrive's own retry-after; the drain cron re-emits.
      await db
        .update(syncOutbox)
        .set({
          status: "deferred",
          notBefore: new Date(Date.now() + err.retryAfterSeconds * 1000),
          attempts: sql`${syncOutbox.attempts} + 1`,
          lastError: err.message,
          updatedAt: new Date(),
        })
        .where(eq(syncOutbox.id, outboxId));
      return;
    }
    // Anything else: surface to Inngest for step-level retry with backoff.
    await db
      .update(syncOutbox)
      .set({
        status: "pending",
        attempts: sql`${syncOutbox.attempts} + 1`,
        lastError: err instanceof Error ? err.message : String(err),
        updatedAt: new Date(),
      })
      .where(eq(syncOutbox.id, outboxId));
    throw err;
  }
}

async function complete(
  outboxId: string,
  op: typeof syncOutbox.$inferSelect.op,
  entity: string,
  pipedriveId: number,
  detail?: unknown,
): Promise<void> {
  await db
    .update(syncOutbox)
    .set({ status: "completed", updatedAt: new Date() })
    .where(eq(syncOutbox.id, outboxId));
  // Append-only audit: every Pipedrive write is traceable back to the
  // extraction (and through it, to the evidence quotes) that caused it.
  await db.insert(syncLog).values({
    outboxId,
    op,
    pipedriveEntity: entity,
    pipedriveId,
    detail: detail ?? null,
  });
}

async function fail(outboxId: string, reason: string): Promise<void> {
  await db
    .update(syncOutbox)
    .set({ status: "failed", lastError: reason, updatedAt: new Date() })
    .where(eq(syncOutbox.id, outboxId));
}
