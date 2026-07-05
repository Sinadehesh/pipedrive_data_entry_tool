import { and, eq, gt, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";

import { auth, signIn } from "@/auth";
import { db } from "@/lib/db/client";
import { invites, tenants } from "@/lib/db/schema";
import { acceptInvite } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The landing page for a join link. Signed-out visitors bounce through
 * sign-in and come straight back here (callbackUrl), so an invited rep's
 * very first session ends inside the right workspace.
 */
export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const session = await auth();
  if (!session?.user) {
    // Server action wrapper so the redirect carries the callback.
    async function signInFirst() {
      "use server";
      await signIn(undefined, { redirectTo: `/join/${token}` });
    }
    return (
      <Shell>
        <h1 className="text-xl font-semibold tracking-tight">
          You&apos;ve been invited
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          Sign in to accept the invitation to this workspace.
        </p>
        <form action={signInFirst} className="mt-6">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Sign in to continue
          </button>
        </form>
      </Shell>
    );
  }

  const [invite] = await db
    .select({
      id: invites.id,
      tenantId: invites.tenantId,
      tenantName: tenants.name,
    })
    .from(invites)
    .innerJoin(tenants, eq(tenants.id, invites.tenantId))
    .where(
      and(
        eq(invites.token, token),
        isNull(invites.usedAt),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!invite) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold tracking-tight">
          Invite not valid
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          This link has expired or was already used. Ask a workspace owner
          for a fresh one.
        </p>
      </Shell>
    );
  }

  if (invite.tenantId === session.tenantId) {
    redirect("/settings/team");
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-tight">
        Join {invite.tenantName}
      </h1>
      <p className="mt-2 text-sm text-slate-500">
        You&apos;re signed in as {session.user.email}. Accepting switches
        your active workspace to {invite.tenantName}.
      </p>
      <form action={acceptInvite} className="mt-6">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Accept invitation
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="rounded-lg border border-slate-200 bg-white p-8">
        {children}
      </div>
    </main>
  );
}
