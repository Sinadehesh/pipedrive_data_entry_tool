import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { CallExtraction } from "@/lib/ai/schemas";
import { db } from "@/lib/db/client";
import {
  extractions,
  fieldMappings,
  interactions,
  syncLog,
  syncOutbox,
  tenants,
  type DealRiskPayload,
  type Participant,
} from "@/lib/db/schema";
import { resolveIdentity, type ResolvedIdentity } from "@/lib/identity/resolve";
import { pipedriveAccountFor } from "@/lib/pipedrive/account";
import {
  PipedriveRateLimitError,
  type PipedriveAccount,
} from "@/lib/pipedrive/client";
import {
  createNote,
  getDeal,
  updateDealCustomFields,
} from "@/lib/pipedrive/records";
import {
  buildDealFieldUpdate,
  renderNoteHtml,
  type FieldMapping,
} from "@/lib/pipedrive/write-policy";
import { inngest } from "@/inngest/client";

/**
 * THE single writer to a tenant's Pipedrive. Every producer — call
 * extraction, calendar risk flags, the staleness sweep, the drain cron —
 * funnels through the sync_outbox into this one function, so the
 * per-tenant concurrency key below is a real guarantee, not a convention.
 *
 * Triggered by either event, it drains ALL due rows for the tenant (safe:
 * concurrency=1 per tenant means two triggers can never race), keeping
 * per-tenant serialization + throttling as the two layers protecting each
 * tenant's own Pipedrive token budget.
 *
 * Credential rule: the tenant's API token is decrypted INSIDE step
 * executors via pipedriveAccountFor() and never returned from a step (step
 * returns persist in Inngest run state).
 */
const CLAIM_LIMIT = 50;

export const reconcilePipedrive = inngest.createFunction(
  {
    id: "reconcile-pipedrive",
    retries: 4,
    concurrency: { key: "event.data.tenantId", limit: 1 },
    throttle: { key: "event.data.tenantId", limit: 30, period: "60s" },
  },
  [{ event: "sync/extraction.ready" }, { event: "sync/outbox.ready" }],
  async ({ event, step }) => {
    const { tenantId } = event.data;

    // Claim ALL due rows for the tenant (status transition = the lock).
    const claimed = await step.run("claim-outbox", async () => {
      const rows = await db
        .select({
          id: syncOutbox.id,
          op: syncOutbox.op,
          payload: syncOutbox.payload,
          interactionId: syncOutbox.interactionId,
          extractionId: syncOutbox.extractionId,
        })
        .from(syncOutbox)
        .where(
          and(
            eq(syncOutbox.tenantId, tenantId),
            inArray(syncOutbox.status, ["pending", "deferred"]),
            or(
              isNull(syncOutbox.notBefore),
              lte(syncOutbox.notBefore, new Date()),
            ),
          ),
        )
        .orderBy(syncOutbox.createdAt)
        .limit(CLAIM_LIMIT);
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

    // Non-secret tenant context shared by every op.
    const tenantCtx = await step.run("load-tenant-context", async () => {
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
      return { internalDomains: tenant?.internalDomains ?? [], mappings };
    });

    // Rows may span several interactions; resolve identity once per
    // interaction, each in its own checkpointed step (Pipedrive-bound).
    const interactionIds = [
      ...new Set(claimed.map((r) => r.interactionId).filter((v): v is string => !!v)),
    ];
    const identities: Record<string, ResolvedIdentity | null> = {};
    for (const interactionId of interactionIds) {
      identities[interactionId] = await step.run(
        `resolve-identity-${interactionId}`,
        async () => {
          const [interaction] = await db
            .select({ participants: interactions.participants })
            .from(interactions)
            .where(
              and(
                eq(interactions.tenantId, tenantId),
                eq(interactions.id, interactionId),
              ),
            )
            .limit(1);
          if (!interaction) return null;
          const account = await pipedriveAccountFor(tenantId);
          return resolveIdentity(
            tenantId,
            account,
            interaction.participants,
            new Set(tenantCtx.internalDomains.map((d) => d.toLowerCase())),
          );
        },
      );
    }

    let synced = 0;
    for (const row of claimed) {
      await step.run(`op-${row.op}-${row.id}`, async () => {
        const account = await pipedriveAccountFor(tenantId);
        await executeOp(
          row,
          tenantId,
          account,
          tenantCtx.mappings,
          row.interactionId ? (identities[row.interactionId] ?? null) : null,
        );
      });
      synced++;
    }

    // More rows than one claim window? Nudge ourselves again.
    if (claimed.length === CLAIM_LIMIT) {
      await step.sendEvent("continue-drain", {
        name: "sync/outbox.ready",
        data: { tenantId },
      });
    }

    return { synced };
  },
);

type ClaimedRow = {
  id: string;
  op: typeof syncOutbox.$inferSelect.op;
  payload: unknown;
  interactionId: string | null;
  extractionId: string | null;
};

async function executeOp(
  row: ClaimedRow,
  tenantId: string,
  account: PipedriveAccount,
  mappings: FieldMapping[],
  identity: ResolvedIdentity | null,
): Promise<void> {
  try {
    switch (row.op) {
      case "create_note": {
        const ctx = await extractionContext(row, tenantId);
        if (!ctx) return fail(row.id, "missing extraction payload");
        const note = await createNote(account, {
          content: renderNoteHtml(ctx.payload, {
            title: ctx.title,
            occurredAt: ctx.occurredAt,
          }),
          dealId: identity?.dealId,
          personId: identity?.personId,
        });
        return complete(row.id, tenantId, row.op, "note", note.id);
      }

      case "update_deal_fields": {
        if (!identity?.dealId) {
          return fail(row.id, "no open deal for participants");
        }
        const ctx = await extractionContext(row, tenantId);
        if (!ctx) return fail(row.id, "missing extraction payload");
        // The tenant's own mapping decides which signals reach which fields.
        const fields = buildDealFieldUpdate(ctx.payload, mappings);
        if (Object.keys(fields).length === 0) {
          return complete(row.id, tenantId, row.op, "deal", identity.dealId, {
            note: "no signal cleared its confidence floor or tenant has no field mappings",
          });
        }
        await updateDealCustomFields(account, identity.dealId, fields);
        return complete(row.id, tenantId, row.op, "deal", identity.dealId, {
          fields,
        });
      }

      case "flag_deal_risk": {
        const risk = row.payload as DealRiskPayload;
        // Skip deals that are no longer open — a won/lost deal isn't "at
        // risk", and flagging it is pure noise.
        const deal = await getDeal(account, risk.dealId);
        if (!deal || deal.status !== "open") {
          return complete(row.id, tenantId, row.op, "deal", risk.dealId, {
            note: `skipped: deal ${deal ? deal.status : "not found"}`,
          });
        }
        const riskMapping = mappings.find((m) => m.signal === "deal_risk");
        if (riskMapping) {
          await updateDealCustomFields(account, risk.dealId, {
            [riskMapping.pipedriveFieldKey]: `⚠ ${risk.reason} (${new Date().toISOString().slice(0, 10)})`,
          });
        } else {
          // No mapped field: fall back to an append-only note.
          await createNote(account, {
            content: `<b>⚠ Deal risk</b><p>${escapeHtml(risk.reason)}</p><p><i>Flagged automatically by CRM Intelligence.</i></p>`,
            dealId: risk.dealId,
          });
        }
        return complete(row.id, tenantId, row.op, "deal", risk.dealId, {
          reason: risk.reason,
          source: risk.source,
          via: riskMapping ? "custom_field" : "note",
        });
      }

      default:
        return fail(row.id, `unhandled op ${row.op}`);
    }
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
        .where(eq(syncOutbox.id, row.id));
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
      .where(eq(syncOutbox.id, row.id));
    throw err;
  }
}

/** Ledger context for extraction-driven ops (notes, field updates). */
async function extractionContext(
  row: ClaimedRow,
  tenantId: string,
): Promise<{
  payload: CallExtraction;
  title: string | null;
  occurredAt: string;
  participants: Participant[];
} | null> {
  if (!row.extractionId || !row.interactionId) return null;
  const [extraction] = await db
    .select({ payload: extractions.payload })
    .from(extractions)
    .where(
      and(
        eq(extractions.tenantId, tenantId),
        eq(extractions.id, row.extractionId),
      ),
    )
    .limit(1);
  if (!extraction?.payload) return null;
  const [interaction] = await db
    .select({
      title: interactions.title,
      occurredAt: interactions.occurredAt,
      participants: interactions.participants,
    })
    .from(interactions)
    .where(
      and(
        eq(interactions.tenantId, tenantId),
        eq(interactions.id, row.interactionId),
      ),
    )
    .limit(1);
  if (!interaction) return null;
  return {
    payload: extraction.payload,
    title: interaction.title,
    occurredAt: interaction.occurredAt.toISOString(),
    participants: interaction.participants,
  };
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
  // extraction/signal that caused it.
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
