"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { encryptSecret } from "@/lib/crypto";
import { withTenant } from "@/lib/db/client";
import {
  connections,
  fieldMappings,
  mappableSignal,
  type ClaapCredential,
  type ZoomCredential,
} from "@/lib/db/schema";

// Not exported: "use server" modules may only export async functions.
const SIGNALS = mappableSignal.enumValues;

/**
 * Settings mutations. Tenant comes from the caller's SESSION and every
 * query runs inside withTenant(), so Postgres RLS enforces the boundary
 * even if a WHERE clause were dropped.
 */
export async function saveFieldMappings(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const tenantId = session.tenantId;

  const entries: {
    signal: (typeof SIGNALS)[number];
    fieldKey: string;
    minConfidence: number | null;
  }[] = [];
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
    entries.push({ signal, fieldKey, minConfidence });
  }

  await withTenant(tenantId, async (tx) => {
    for (const { signal, fieldKey, minConfidence } of entries) {
      if (fieldKey === "") {
        await tx
          .delete(fieldMappings)
          .where(
            and(
              eq(fieldMappings.tenantId, tenantId),
              eq(fieldMappings.signal, signal),
            ),
          );
        continue;
      }
      await tx
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
  });

  revalidatePath("/settings/sync");
  redirect("/settings/sync?saved=1");
}

/**
 * Claap connect: the tenant pastes their API key + a webhook secret they
 * also register in Claap alongside our per-tenant webhook URL. accountRef
 * is the tenantId itself — key-based providers have no OAuth account
 * identity, and this keeps (provider, account_ref) trivially unique.
 */
export async function connectClaap(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const tenantId = session.tenantId;

  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const webhookSecret = String(formData.get("webhookSecret") ?? "").trim();
  if (apiKey.length < 8 || webhookSecret.length < 8) {
    redirect("/settings/sync?error=claap_fields_required");
  }

  const credential: ClaapCredential = { apiKey, webhookSecret };
  await upsertKeyConnection(tenantId, "claap", credential);

  revalidatePath("/settings/sync");
  redirect("/settings/sync?connected=claap");
}

/** Zoom connect: only the app's webhook secret token is needed (the
 *  transcript fetch rides each webhook's own download_token). */
export async function connectZoom(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const tenantId = session.tenantId;

  const webhookSecretToken = String(
    formData.get("webhookSecretToken") ?? "",
  ).trim();
  if (webhookSecretToken.length < 8) {
    redirect("/settings/sync?error=zoom_fields_required");
  }

  const credential: ZoomCredential = { webhookSecretToken };
  await upsertKeyConnection(tenantId, "zoom", credential);

  revalidatePath("/settings/sync");
  redirect("/settings/sync?connected=zoom");
}

async function upsertKeyConnection(
  tenantId: string,
  provider: "claap" | "zoom",
  credential: object,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.tenantId, tenantId),
          eq(connections.provider, provider),
        ),
      )
      .limit(1);

    const values = {
      credentialCiphertext: encryptSecret(JSON.stringify(credential)),
      status: "active" as const,
      lastError: null,
      updatedAt: new Date(),
    };
    if (existing) {
      await tx.update(connections).set(values).where(eq(connections.id, existing.id));
    } else {
      await tx.insert(connections).values({
        tenantId,
        provider,
        accountRef: tenantId,
        ...values,
      });
    }
  });
}
