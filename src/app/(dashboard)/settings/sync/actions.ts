"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { fieldMappings, mappableSignal } from "@/lib/db/schema";

// Not exported: "use server" modules may only export async functions.
const SIGNALS = mappableSignal.enumValues;

/**
 * Persist the tenant's signal -> Pipedrive-field mapping. The tenant comes
 * from the caller's SESSION — never from the form — so a tampered request
 * can only ever edit its own workspace.
 *
 * Semantics per signal: a selected field key upserts the mapping; the empty
 * option ("Don't sync") deletes it, which switches that signal off for
 * automatic writes.
 */
export async function saveFieldMappings(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const tenantId = session.tenantId;

  for (const signal of SIGNALS) {
    const fieldKey = String(formData.get(`field:${signal}`) ?? "").trim();
    const rawConfidence = String(formData.get(`confidence:${signal}`) ?? "").trim();
    const minConfidence = rawConfidence === "" ? null : Number(rawConfidence);
    if (
      minConfidence !== null &&
      (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)
    ) {
      redirect("/settings/sync?error=confidence_out_of_range");
    }

    if (fieldKey === "") {
      await db
        .delete(fieldMappings)
        .where(
          and(
            eq(fieldMappings.tenantId, tenantId),
            eq(fieldMappings.signal, signal),
          ),
        );
      continue;
    }

    await db
      .insert(fieldMappings)
      .values({ tenantId, signal, pipedriveFieldKey: fieldKey, minConfidence })
      .onConflictDoUpdate({
        target: [fieldMappings.tenantId, fieldMappings.signal],
        set: {
          pipedriveFieldKey: fieldKey,
          minConfidence,
          updatedAt: new Date(),
        },
      });
  }

  revalidatePath("/settings/sync");
  redirect("/settings/sync?saved=1");
}
