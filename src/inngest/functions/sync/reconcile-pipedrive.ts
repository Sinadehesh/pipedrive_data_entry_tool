import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { requireConnection } from "@/lib/connections";
import { db } from "@/lib/db/client";
import {
  extractions,
  fieldMappings,
  interactions,
  syncLog,
  syncOutbox,
  tenants,
} from "@/lib/db/schema";
import { resolveIdentity, type ResolvedIdentity } from "@/lib/identity/resolve";
import {
  PipedriveRateLimitError,
  type PipedriveAccount,
} from "@/lib/pipedrive/client";
import { createNote, updateDealCustomFields } from "@/lib/pipedrive/records";
import {
  buildDealFieldUpdate,
  renderNoteHtml,
  type FieldMapping,
} from "@/lib/pipedrive/write-policy";
import { inngest } from "@/inngest/client";

/**
 * Drains the sync_outbox into the TENANT's Pipedrive account.
 *
 * Multi-tenant isolation, layer by layer:
 *   - tenantId comes from the event, which was produced from ledger rows —
 *     never from client input — and every query below re-filters on it.
 *   - `concurrency`/`throttle` are KEYED BY TENANT: one writer per tenant,
 *     paced per tenant. Pipedrive's token budget is per company, so tenant
 *     A bursting can never starve tenant B, and ten tenants sync in
 *     parallel while each stays single-writer against its own CRM.
 *   - The API token is decrypted from `connections` INSIDE step executors
 *     and never returned from a step (step returns persist in Inngest run
 *     state).
 *   - Field writes are driven by the tenant's own field_mappings rows —
 *     nothing is hardcoded; an unmapped signal is simply never written.
 *
 * A 429 defers the outbox row with Pipedrive's retry-after; the drain cron
 * re-emits it. Deferred, not dropped.
 */
export const reconcilePipedrive = inngest.createFunction(
  {
    id: "reconcile-pipedrive",
    retries: 4,
    concurrency: { key: "event.data.tenantId", limit: 1 },
    throttle: { key: "event.data.tenantId", limit: 30, period: "60s" },
  },
  { event: "sync/extraction.ready" },
  async ({ event, step }) => {
    const { tenantId } = event.data;

    // Claim pending rows for this extraction (status transition = the lock).
    const claimed = await step.run("claim-outbox", async () => {
      const rows = await db
        .select({ id: syncOutbox.id, op: syncOutbox.op })
        .from(syncOutbox)
        .where(
          and(
            eq(syncOutbox.tenantId, tenantId),
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

    // Everything non-secret the ops need: ledger rows, the tenant's
    // internal domains, and their field mappings. All tenant-filtered.
    const context = await step.run("load-context", async () => {
      const [interaction] = await db
        .select()
        .from(interactions)
        .where(
          and(
            eq(interactions.tenantId, tenantId),
            eq(interactions.id, event.data.interactionId),
          ),
        )
        .limit(1);
      const [extraction] = await db
        .select()
        .from(extractions)
        .where(
          and(
            eq(extractions.tenantId, tenantId),
            eq(extractions.id, event.data.extractionId),
          ),
        )
        .limit(1);
      const [tenant] = await db
        .select({ internalDomains: tenants.internalDomains })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const mappings = await db
        .select({
          signal: fieldMappings.signal,
          pipedriveFieldKey: fieldMappings.pipedriveFieldKey,
          minConfidence: fieldMappings.minConfidence,
        })
        .from(fieldMappings)
        .where(eq(fieldMappings.tenantId, tenantId));
      return {
        interaction,
        extraction,
        internalDomains: tenant?.internalDomains ?? [],
        mappings,
      };
    });

    if (!context.extraction?.payload) {
      return { synced: 0, skipped: "no extraction payload" };
    }

    // Identity resolution is Pipedrive-API-bound, so it runs inside the
    // same per-tenant serialized/throttled function. The tenant's account
    // is decrypted here, used, and dropped — only ids leave the step.
    const identity = await step.run("resolve-identity", async () => {
      const account = await tenantPipedriveAccount(tenantId);
      return resolveIdentity(
        tenantId,
        account,
        context.interaction.participants,
        new Set(context.internalDomains.map((d) => d.toLowerCase())),
      );
    });

    let synced = 0;
    for (const row of claimed) {
      await step.run(`op-${row.op}-${row.id}`, async () => {
        const account = await tenantPipedriveAccount(tenantId);
        await executeOp(row.id, row.op, tenantId, account, context, identity);
      });
      synced++;
    }

    return { synced, dealId: identity?.dealId ?? null };
  },
);

/**
 * Decrypt the tenant's Pipedrive credential at the moment of use. Called
 * inside step executors so the plaintext token lives only for the duration
 * of that step's process — it is never serialized into Inngest state.
 */
async function tenantPipedriveAccount(
  tenantId: string,
): Promise<PipedriveAccount> {
  const conn = await requireConnection(tenantId, "pipedrive");
  return {
    domain: conn.credential.domain,
    apiToken: conn.credential.apiToken,
  };
}

// step.run() returns are JSON-serialized, so Date columns arrive as strings.
type Context = {
  interaction: Pick<typeof interactions.$inferSelect, "title" | "participants"> & {
    occurredAt: string | Date;
  };
  extraction: Pick<typeof extractions.$inferSelect, "payload">;
  mappings: FieldMapping[];
};

async function executeOp(
  outboxId: string,
  op: typeof syncOutbox.$inferSelect.op,
  tenantId: string,
  account: PipedriveAccount,
  context: Context,
  identity: ResolvedIdentity | null,
): Promise<void> {
  const payload = context.extraction.payload!;

  try {
    if (op === "create_note") {
      const note = await createNote(account, {
        content: renderNoteHtml(payload, {
          title: context.interaction.title,
          occurredAt: context.interaction.occurredAt.toString(),
        }),
        dealId: identity?.dealId,
        personId: identity?.personId,
      });
      await complete(outboxId, tenantId, op, "note", note.id);
      return;
    }

    if (op === "update_deal_fields") {
      if (!identity?.dealId) {
        await fail(outboxId, "no open deal for participants");
        return;
      }
      // The tenant's own mapping decides which signals reach which fields.
      const fields = buildDealFieldUpdate(payload, context.mappings);
      if (Object.keys(fields).length === 0) {
        await complete(outboxId, tenantId, op, "deal", identity.dealId, {
          note: "no signal cleared its confidence floor or tenant has no field mappings",
        });
        return;
      }
      await updateDealCustomFields(account, identity.dealId, fields);
      await complete(outboxId, tenantId, op, "deal", identity.dealId, {
        fields,
      });
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
  tenantId: string,
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
    tenantId,
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
