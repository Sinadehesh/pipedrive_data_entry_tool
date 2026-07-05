import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { invites, memberships, users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { createInvite, revokeInvite } from "./actions";

export const dynamic = "force-dynamic";

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; revoked?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const tenantId = session.tenantId;
  const params = await searchParams;

  const [members, pending, me] = await Promise.all([
    db
      .select({
        email: users.email,
        name: users.name,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, tenantId))
      .orderBy(memberships.createdAt),
    db
      .select({
        id: invites.id,
        token: invites.token,
        expiresAt: invites.expiresAt,
      })
      .from(invites)
      .where(
        and(
          eq(invites.tenantId, tenantId),
          isNull(invites.usedAt),
          gt(invites.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(invites.createdAt)),
    db
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, session.user.id),
          eq(memberships.tenantId, tenantId),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  const appUrl = (env().APP_URL || "http://localhost:3000").replace(/\/$/, "");
  const isOwner = me?.role === "owner";

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Team</h1>
        <p className="mt-1 text-sm text-slate-500">
          Everyone in this workspace, and join links for inviting reps.
        </p>
      </div>

      {params.created && (
        <Banner tone="success">Invite created — copy the link below.</Banner>
      )}
      {params.revoked && <Banner tone="success">Invite revoked.</Banner>}
      {params.error === "owner_only" && (
        <Banner tone="error">Only workspace owners can create invites.</Banner>
      )}

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3 font-medium">Member</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3">
                  <span className="font-medium">{m.name ?? m.email}</span>
                  {m.name && (
                    <span className="ml-2 text-slate-400">{m.email}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
                    {m.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {m.joinedAt.toISOString().slice(0, 10)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
            Pending invites
          </h2>
          {isOwner && (
            <form action={createInvite}>
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
              >
                New invite link
              </button>
            </form>
          )}
        </div>

        {pending.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
            No open invites. Each link admits one person, then expires.
          </div>
        ) : (
          <div className="space-y-2">
            {pending.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3"
              >
                <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-slate-50 px-2 py-1 text-xs text-slate-700">
                  {appUrl}/join/{invite.token}
                </code>
                <span className="shrink-0 text-xs text-slate-400">
                  expires {invite.expiresAt.toISOString().slice(0, 10)}
                </span>
                {isOwner && (
                  <form action={revokeInvite}>
                    <input type="hidden" name="inviteId" value={invite.id} />
                    <button
                      type="submit"
                      className="shrink-0 rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      Revoke
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Banner({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "success" | "error";
}) {
  return (
    <div
      className={`rounded-md px-4 py-3 text-sm ${
        tone === "success"
          ? "bg-emerald-50 text-emerald-800"
          : "bg-red-50 text-red-800"
      }`}
    >
      {children}
    </div>
  );
}
