"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import type { CallExtraction } from "@/lib/ai/schemas";
import { db } from "@/lib/db/client";
import { extractions, interactions, syncOutbox } from "@/lib/db/schema";
import { syncCompetitiveIntel } from "@/lib/intel";
import { inngest } from "@/inngest/client";

/**
 * Review-queue actions. Tenant always comes from the session; the form
 * contributes only ids that are then re-checked against that tenant.
 *
 * Immutability rule: a reviewer EDIT never mutates the stored payload — it
 * appends a new extraction version authored by the human (model
 * "human-review", edited signals at confidence 1.0), marks the machine
 * version rejected, and syncs the new version. The full history of what
 * the model said vs. what the human corrected stays queryable forever.
 */

const EDITABLE = ["budget", "authority", "need", "timeline"] as const;
type EditableSignal = (typeof EDITABLE)[number];

export async function approveExtraction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const tenantId = session.tenantId;
  const extractionId = String(formData.get("extractionId") ?? "");

  const row = await loadReviewable(tenantId, extractionId);
  if (!row) redirect("/review?error=not_found");

  // Diff the reviewer's inputs against the stored signals.
  const edits = new Map<EditableSignal, string | null>();
  for (const signal of EDITABLE) {
    const raw = formData.get(`edit:${signal}`);
    if (raw === null) continue;
    const value = String(raw).trim();
    const current = row.payload.bant[signal].value ?? "";
    if (value !== current) edits.set(signal, value === "" ? null : value);
  }

  if (edits.size === 0) {
    // Plain approval: flip the status and let the tenant's mappings decide
    // what reaches Pipedrive.
    await db
      .update(extractions)
      .set({ status: "auto_approved" })
      .where(eq(extractions.id, row.id));
    await enqueueFieldSync(tenantId, row.interactionId, row.id, row.version);
  } else {
    // Edited approval: append a human-authored version.
    const payload: CallExtraction = structuredClone(row.payload);
    for (const [signal, value] of edits) {
      // Mutate shared Signal fields in place — `timeline` carries extra
      // fields (shifted/previousTimeline) that must survive untouched.
      const target = payload.bant[signal];
      target.value = value;
      target.confidence = value === null ? 0 : 1;
      target.evidence = value === null ? null : "(corrected by reviewer)";
    }

    const [created] = await db
      .insert(extractions)
      .values({
        tenantId,
        interactionId: row.interactionId,
        version: row.latestVersion + 1,
        model: `human-review:${session.user.email ?? session.user.id}`,
        payload,
        overallConfidence: 1,
        status: "auto_approved",
      })
      .returning({ id: extractions.id, version: extractions.version });

    await db
      .update(extractions)
      .set({ status: "rejected", error: "superseded by reviewer edit" })
      .where(eq(extractions.id, row.id));

    await syncCompetitiveIntel({
      tenantId,
      interactionId: row.interactionId,
      extractionId: created.id,
      payload,
      occurredAt: row.occurredAt,
    });
    await enqueueFieldSync(
      tenantId,
      row.interactionId,
      created.id,
      created.version,
    );
  }

  revalidatePath("/review");
  redirect("/review?approved=1");
}

export async function rejectExtraction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const extractionId = String(formData.get("extractionId") ?? "");

  const row = await loadReviewable(session.tenantId, extractionId);
  if (!row) redirect("/review?error=not_found");

  await db
    .update(extractions)
    .set({ status: "rejected" })
    .where(eq(extractions.id, row.id));

  revalidatePath("/review");
  redirect("/review?rejected=1");
}

/** Re-run LLM extraction from the immutable ledger (appends a version). */
export async function replayInteraction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const tenantId = session.tenantId;
  const interactionId = String(formData.get("interactionId") ?? "");

  // Ownership check before emitting anything.
  const [owned] = await db
    .select({ id: interactions.id })
    .from(interactions)
    .where(
      and(
        eq(interactions.tenantId, tenantId),
        eq(interactions.id, interactionId),
      ),
    )
    .limit(1);
  if (!owned) redirect("/review?error=not_found");

  await inngest.send({
    name: "ledger/interaction.replay",
    data: { tenantId, interactionId },
  });

  revalidatePath("/review");
  redirect("/review?replayed=1");
}

// ---------------------------------------------------------------------------

async function loadReviewable(tenantId: string, extractionId: string) {
  const [row] = await db
    .select({
      id: extractions.id,
      interactionId: extractions.interactionId,
      version: extractions.version,
      payload: extractions.payload,
      occurredAt: interactions.occurredAt,
    })
    .from(extractions)
    .innerJoin(interactions, eq(interactions.id, extractions.interactionId))
    .where(
      and(
        eq(extractions.tenantId, tenantId),
        eq(extractions.id, extractionId),
        eq(extractions.status, "needs_review"),
      ),
    )
    .limit(1);
  if (!row?.payload) return null;

  const [latest] = await db
    .select({ version: extractions.version })
    .from(extractions)
    .where(eq(extractions.interactionId, row.interactionId))
    .orderBy(desc(extractions.version))
    .limit(1);

  return {
    ...row,
    payload: row.payload,
    latestVersion: latest?.version ?? row.version,
  };
}

async function enqueueFieldSync(
  tenantId: string,
  interactionId: string,
  extractionId: string,
  version: number,
): Promise<void> {
  await db
    .insert(syncOutbox)
    .values({
      tenantId,
      interactionId,
      extractionId,
      op: "update_deal_fields",
      payload: {},
      idempotencyKey: `deal-fields:${interactionId}:v${version}`,
    })
    .onConflictDoNothing();
  await inngest.send({
    name: "sync/outbox.ready",
    data: { tenantId },
  });
}
