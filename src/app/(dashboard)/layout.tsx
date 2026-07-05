import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { auth, signOut } from "@/auth";

/**
 * Shell for every authenticated page. The auth gate lives here: anything
 * under (dashboard) can assume a session with a tenantId exists.
 */
export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  if (!session?.tenantId) {
    redirect("/api/auth/signin");
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <nav className="flex items-center gap-6">
            <Link href="/" className="text-sm font-semibold tracking-tight">
              CRM Intelligence
            </Link>
            <Link
              href="/review"
              className="text-sm text-slate-600 hover:text-slate-900"
            >
              Review
            </Link>
            <Link
              href="/intel"
              className="text-sm text-slate-600 hover:text-slate-900"
            >
              Intel
            </Link>
            <Link
              href="/settings/sync"
              className="text-sm text-slate-600 hover:text-slate-900"
            >
              Sync
            </Link>
            <Link
              href="/settings/team"
              className="text-sm text-slate-600 hover:text-slate-900"
            >
              Team
            </Link>
          </nav>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-500">
              {session.user.email}
            </span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
