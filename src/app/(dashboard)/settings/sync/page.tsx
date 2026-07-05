import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { connections, fieldMappings } from "@/lib/db/schema";
import { pipedriveAccountFor } from "@/lib/pipedrive/account";
import { listDealFields } from "@/lib/pipedrive/records";
import { saveFieldMappings } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Sync settings: connection health + the signal -> Pipedrive-field mapping
 * editor. Server components throughout; the only mutation is the
 * saveFieldMappings server action. Everything is scoped to the session's
 * tenantId — no client-supplied tenant anywhere on this page.
 */
export default async function SyncSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; connected?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const tenantId = session.tenantId;
  const params = await searchParams;

  const rows = await db
    .select({
      provider: connections.provider,
      accountRef: connections.accountRef,
      status: connections.status,
      lastError: connections.lastError,
    })
    .from(connections)
    .where(eq(connections.tenantId, tenantId));

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sync settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Connections and field mapping for your workspace.
        </p>
      </div>

      {params.saved && <Banner tone="success">Field mappings saved.</Banner>}
      {params.connected === "pipedrive" && (
        <Banner tone="success">Pipedrive connected.</Banner>
      )}
      {params.error && (
        <Banner tone="error">{errorMessage(params.error)}</Banner>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Connections
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <ConnectionCard
            title="Pipedrive"
            row={rows.find((r) => r.provider === "pipedrive") ?? null}
            connectHref="/api/oauth/pipedrive/start"
          />
          <ConnectionCard
            title="Google Workspace"
            row={rows.find((r) => r.provider === "google") ?? null}
            connectHref="/api/oauth/google/start"
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Field mapping
        </h2>
        <Suspense fallback={<FieldMappingSkeleton />}>
          <FieldMappingSection tenantId={tenantId} />
        </Suspense>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

type ConnectionRow = {
  provider: "google" | "pipedrive" | "claap";
  accountRef: string;
  status: "active" | "error" | "revoked";
  lastError: string | null;
};

function ConnectionCard({
  title,
  row,
  connectHref,
}: {
  title: string;
  row: ConnectionRow | null;
  connectHref: string | null;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">{title}</div>
          <div className="mt-0.5 text-sm text-slate-500">
            {row ? row.accountRef : "Not connected"}
          </div>
        </div>
        {row ? (
          <StatusPill status={row.status} />
        ) : connectHref ? (
          <Link
            href={connectHref}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Connect
          </Link>
        ) : (
          <span className="text-xs text-slate-400">Coming soon</span>
        )}
      </div>
      {row?.status === "error" && row.lastError && (
        <p className="mt-3 rounded-md bg-red-50 p-2 text-xs text-red-700">
          {row.lastError}
        </p>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: ConnectionRow["status"] }) {
  const styles: Record<ConnectionRow["status"], string> = {
    active: "bg-emerald-50 text-emerald-700",
    error: "bg-red-50 text-red-700",
    revoked: "bg-slate-100 text-slate-500",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------

const SIGNAL_LABELS = {
  bant_budget: { label: "Budget", hint: "Amounts, ranges, approval status" },
  bant_authority: { label: "Authority", hint: "Decision maker and presence" },
  bant_need: { label: "Need", hint: "The prospect's stated problem" },
  bant_timeline: { label: "Timeline", hint: "Target dates and slips" },
  deal_risk: {
    label: "Deal risk",
    hint: "Stale deals & cancelled meetings (note fallback if unmapped)",
  },
} as const;

type SignalKey = keyof typeof SIGNAL_LABELS;

async function FieldMappingSection({ tenantId }: { tenantId: string }) {
  // No Pipedrive connection -> nothing to map against yet.
  const [pipedrive] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.tenantId, tenantId),
        eq(connections.provider, "pipedrive"),
        eq(connections.status, "active"),
      ),
    )
    .limit(1);

  if (!pipedrive) {
    return (
      <EmptyCard>
        Connect Pipedrive first — the mapping editor reads the custom fields
        from your account.
      </EmptyCard>
    );
  }

  // Fetch the tenant's deal fields from THEIR Pipedrive. This is the one
  // external call on the page; failures render an error card rather than
  // crashing the route.
  let dealFields: { key: string; name: string; field_type: string }[];
  try {
    const account = await pipedriveAccountFor(tenantId);
    dealFields = await listDealFields(account);
  } catch (err) {
    return (
      <EmptyCard tone="error">
        Couldn&apos;t load your Pipedrive fields (
        {err instanceof Error ? err.message.slice(0, 120) : "unknown error"}).
        Check the connection above and reload.
      </EmptyCard>
    );
  }

  const mappings = await db
    .select({
      signal: fieldMappings.signal,
      pipedriveFieldKey: fieldMappings.pipedriveFieldKey,
      minConfidence: fieldMappings.minConfidence,
    })
    .from(fieldMappings)
    .where(eq(fieldMappings.tenantId, tenantId));
  const bySignal = new Map(mappings.map((m) => [m.signal, m]));

  // Only text-ish fields make sense as targets for our string signals.
  const candidateFields = dealFields.filter((f) =>
    ["varchar", "varchar_auto", "text"].includes(f.field_type),
  );

  return (
    <form
      action={saveFieldMappings}
      className="overflow-hidden rounded-lg border border-slate-200 bg-white"
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-3 font-medium">AI signal</th>
            <th className="px-4 py-3 font-medium">Pipedrive deal field</th>
            <th className="px-4 py-3 font-medium">Min. confidence</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(SIGNAL_LABELS) as SignalKey[]).map((signal) => {
            const current = bySignal.get(signal);
            return (
              <tr key={signal} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3">
                  <div className="font-medium">{SIGNAL_LABELS[signal].label}</div>
                  <div className="text-xs text-slate-500">
                    {SIGNAL_LABELS[signal].hint}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <select
                    name={`field:${signal}`}
                    defaultValue={current?.pipedriveFieldKey ?? ""}
                    className="w-full max-w-xs rounded-md border border-slate-300 px-2 py-1.5"
                  >
                    <option value="">Don&apos;t sync</option>
                    {candidateFields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3">
                  <input
                    type="number"
                    name={`confidence:${signal}`}
                    defaultValue={current?.minConfidence ?? ""}
                    placeholder="0.8"
                    min={0}
                    max={1}
                    step={0.05}
                    className="w-24 rounded-md border border-slate-300 px-2 py-1.5"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-xs text-slate-500">
          Unmapped signals still appear in call notes — they just never write
          to a deal field. Empty confidence uses the 0.8 default.
        </p>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Save mappings
        </button>
      </div>
    </form>
  );
}

function FieldMappingSkeleton() {
  return (
    <div className="animate-pulse rounded-lg border border-slate-200 bg-white p-4">
      <div className="h-4 w-48 rounded bg-slate-200" />
      <div className="mt-4 space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-9 rounded bg-slate-100" />
        ))}
      </div>
      <p className="mt-4 text-xs text-slate-400">
        Loading your Pipedrive fields…
      </p>
    </div>
  );
}

function EmptyCard({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <div
      className={`rounded-lg border p-6 text-sm ${
        tone === "error"
          ? "border-red-200 bg-red-50 text-red-700"
          : "border-slate-200 bg-white text-slate-500"
      }`}
    >
      {children}
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

function errorMessage(code: string): string {
  const messages: Record<string, string> = {
    signin_required: "Please sign in and try again.",
    pipedrive_state_mismatch:
      "The Pipedrive connection attempt expired or was tampered with. Please try again.",
    pipedrive_exchange_failed:
      "Pipedrive rejected the authorization. Please try connecting again.",
    pipedrive_already_claimed:
      "That Pipedrive account is already connected to a different workspace.",
    confidence_out_of_range: "Confidence values must be between 0 and 1.",
  };
  return messages[code] ?? "Something went wrong. Please try again.";
}
