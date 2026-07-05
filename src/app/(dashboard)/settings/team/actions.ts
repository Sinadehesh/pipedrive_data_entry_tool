"use server";

import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { withTenant } from "@/lib/db/client";
import { invites, memberships } from "@/lib/db/schema";

const INVITE_TTL_DAYS = 7;

/**
 * Generate a single-use join link for the caller's tenant. Owner-only —
 * the role check runs against the memberships table, not the client.
 */
export async function createInvite(): Promise<void> {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");

  const allowed = await withTenant(session.tenantId, async (tx) => {
    const [membership] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, session.user.id),
          eq(memberships.tenantId, session.tenantId),
        ),
      )
      .limit(1);
    if (membership?.role !== "owner") return false;

    await tx.insert(invites).values({
      tenantId: session.tenantId,
      token: randomBytes(24).toString("hex"), // 48 hex chars, unguessable
      role: "member",
      createdByUserId: session.user.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
    });
    return true;
  });
  if (!allowed) {
    redirect("/settings/team?error=owner_only");
  }

  revalidatePath("/settings/team");
  redirect("/settings/team?created=1");
}

export async function revokeInvite(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const inviteId = String(formData.get("inviteId") ?? "");

  // Tenant-scoped delete: an id from another workspace matches nothing —
  // by WHERE clause and, inside withTenant, by RLS policy too.
  await withTenant(session.tenantId, (tx) =>
    tx
      .delete(invites)
      .where(
        and(eq(invites.id, inviteId), eq(invites.tenantId, session.tenantId)),
      ),
  );

  revalidatePath("/settings/team");
  redirect("/settings/team?revoked=1");
}
