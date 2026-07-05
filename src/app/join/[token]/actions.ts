"use server";

import { and, eq, gt, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";

import { auth, unstable_update } from "@/auth";
import { db } from "@/lib/db/client";
import { invites, memberships } from "@/lib/db/schema";

/**
 * Accept an invite: atomically consume the single-use token, create the
 * membership, and switch the session's active tenant. The tenant comes
 * from the INVITE ROW (validated server-side); the session update goes
 * through the jwt callback, which re-verifies the membership exists before
 * honoring the switch.
 */
export async function acceptInvite(formData: FormData): Promise<void> {
  const session = await auth();
  const token = String(formData.get("token") ?? "");
  if (!session?.user?.id) redirect(`/join/${token}`);

  // Consume the token atomically: the UPDATE only matches an unused,
  // unexpired invite, so two racing accepts can't both succeed.
  const [claimed] = await db
    .update(invites)
    .set({ usedAt: new Date(), usedByUserId: session.user.id })
    .where(
      and(
        eq(invites.token, token),
        isNull(invites.usedAt),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .returning({ tenantId: invites.tenantId, role: invites.role });

  if (!claimed) {
    redirect(`/join/${token}`); // page renders the "not valid" state
  }

  await db
    .insert(memberships)
    .values({
      userId: session.user.id,
      tenantId: claimed.tenantId,
      role: claimed.role,
    })
    .onConflictDoNothing();

  // Re-pin the JWT to the new tenant (membership re-verified in the jwt
  // callback — see src/auth.ts).
  await unstable_update({ tenantId: claimed.tenantId } as never);

  redirect("/settings/sync?joined=1");
}
