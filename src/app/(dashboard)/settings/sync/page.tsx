import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { auth } from "@/auth";
import { withTenant } from "@/lib/db/client";
import { connections, fieldMappings } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { pipedriveAccountFor } from "@/lib/pipedrive/account";
import { listDealFields } from "@/lib/pipedrive/records";
import { connectClaap, connectZoom, saveFieldMappings } from "./actions";

export const dynamic = "force-dynamic";

export default async function SyncSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    saved?: string;
    connected?: string;
    warn?: string;
    error?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const tenantId = session.tenantId;
  const params = await searchParams;

  // All reads inside withTenant: RLS pins the transaction to this tenant.
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({
        provider: connections.provider,
        accountRef: connections.accountRef,
        status: connections.status,
        lastError: connections.lastError,
      })
      .from(connections)
      .where(eq(connections.tenantId, tenantId)),
  );
  const byProvider = (p: ConnectionRow["provider"]) =>
    rows.find((r) => r.provider === p) ?? null;

  const appUrl = (env().APP_URL || "http://localhost:3000").replace(/\/$/, "");

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sync settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Connect Pipedrive, your call recording tools, and Google Workspace
          — every call, email, and meeting feeds the same pipeline, and deal
          freshness is judged across all of them.
        </p>
      </div>

      {params.saved && <Banner tone="success">Field mappings saved.</Banner>}
      {params.connected === "pipedrive" && (
        <Banner tone="success">Pipedrive connected.</Banner>
      )}
      {params.connected === "claap" && (
        <Banner tone="success">
          Claap connected — register the webhook URL below in your Claap
          workspace to start syncing calls.
        </Banner>
      )}
      {params.connected === "zoom" && (
        <Banner tone="success">
          Zoom connected — set the webhook URL below as your Zoom app&apos;s
          event notification endpoint.
        </Banner>
      )}
      {params.connected === "google" && (
        <Banner tone="success">
          Google Workspace connected
          {params.warn === "watches"
            ? " — but live notifications couldn't be armed yet; we'll keep retrying automatically (see the connection card)."
            : " — importing the last 14 days of email and meetings now."}
        </Banner>
      )}
      {params.error && <Banner tone="error">{errorMessage(params.error)}</Banner>}

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
          CRM
        </h2>
        <PipedriveCard row={byProvider("pipedrive")} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Call recording
        </h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <KeyProviderCard
            title="Claap"
            row={byProvider("claap")}
            webhookUrl={`${appUrl}/api/webhooks/claap/${tenantId}`}
            action={connectClaap}
            fields={[
              { name: "apiKey", label: "API key", type: "password" },
              {
                name: "webhookSecret",
                label: "Webhook signing secret",
                type: "password",
                hint: "Any strong secret — register the same value on the Claap webhook.",
              },
            ]}
          />
          <KeyProviderCard
            title="Zoom"
            row={byProvider("zoom")}
            webhookUrl={`${appUrl}/api/webhooks/zoom/${tenantId}`}
            action={connectZoom}
            fields={[
              {
                name: "webhookSecretToken",
                label: "Webhook secret token",
                type: "password",
                hint: "From your Zoom app's Features → Event Subscriptions.",
              },
            ]}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Email &amp; calendar
        </h2>
        <GoogleCard row={byProvider("google")} />
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
  provider: (typeof connections.$inferSelect)["provider"];
  accountRef: string;
  status: (typeof connections.$inferSelect)["status"];
  lastError: string | null;
};

function PipedriveCard({ row }: { row: ConnectionRow | null }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">Pipedrive</div>
          <div className="mt-0.5 text-sm text-slate-500">
            {row ? `${row.accountRef}.pipedrive.com` : "Not connected"}
          </div>
        </div>
        {row ? (
          <StatusPill status={row.status} />
        ) : (
          <Link
            href="/api/oauth/pipedrive/start"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Connect
          </Link>
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

function GoogleCard({ row }: { row: ConnectionRow | null }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">Google Workspace</div>
          <div className="mt-0.5 text-sm text-slate-500">
            {row
              ? row.accountRef
              : "Gmail + Calendar (read-only) — keeps deal freshness honest between calls"}
          </div>
        </div>
        {row ? (
          <StatusPill status={row.status} />
        ) : (
          <Link
            href="/api/oauth/google/start"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Connect
          </Link>
        )}
      </div>
      {row && (
        <p className="mt-2 text-xs text-slate-400">
          Connecting imports the last 14 days of prospect email and external
          meetings — which will add notes to matching deals — then stays live
          via push notifications.
        </p>
      )}
      {row?.status === "error" && row.lastError && (
        <p className="mt-3 rounded-md bg-red-50 p-2 text-xs text-red-700">
          {row.lastError}
        </p>
      )}
    </div>
  );
}

function KeyProviderCard({
  title,
  row,
  webhookUrl,
  action,
  fields,
}: {
  title: string;
  row: ConnectionRow | null;
  webhookUrl: string;
  action: (formData: FormData) => Promise<void>;
  fields: { name: string; label: string; type: string; hint?: string }[];
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="font-medium">{title}</div>
        {row ? (
          <StatusPill status={row.status} />
        ) : (
          <span className="text-xs text-slate-400">Not connected</span>
        )}
      </div>

      {row ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-slate-500">
            Webhook URL (register this in {title}):
          </p>
          <code className="block overflow-x-auto whitespace-nowrap rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
            {webhookUrl}
          </code>
          {row.status === "error" && row.lastError && (
            <p className="rounded-md bg-red-50 p-2 text-xs text-red-700">
              {row.lastError}
            </p>
          )}
        </div>
      ) : (
        <form action={action} className="mt-3 space-y-3">
          {fields.map((f) => (
            <div key={f.name}>
              <label className="block text-xs font-medium text-slate-600">
                {f.label}
              </label>
              <input
                name={f.name}
                type={f.type}
                required
                autoComplete="off"
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
              {f.hint && (
                <p className="mt-1 text-xs text-slate-400">{f.hint}</p>
              )}
            </div>
          ))}
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Connect {title}
          </button>
        </form>
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
  const { pdConnected, mappings } = await withTenant(tenantId, async (tx) => {
    const [pipedrive] = await tx
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
    if (!pipedrive) return { pdConnected: false, mappings: [] };
    return {
      pdConnected: true,
      mappings: await tx
        .select({
          signal: fieldMappings.signal,
          pipedriveFieldKey: fieldMappings.pipedriveFieldKey,
          minConfidence: fieldMappings.minConfidence,
        })
        .from(fieldMappings)
        .where(eq(fieldMappings.tenantId, tenantId)),
    };
  });

  if (!pdConnected) {
    return (
      <EmptyCard>
        Connect Pipedrive first — the mapping editor reads the custom fields
        from your account.
      </EmptyCard>
    );
  }

  // The one external call on the page; failures render an error card
  // rather than crashing the route.
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

  const bySignal = new Map(mappings.map((m) => [m.signal, m]));
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
    claap_fields_required:
      "Both the Claap API key and a webhook secret are required.",
    zoom_fields_required: "The Zoom webhook secret token is required.",
    google_state_mismatch:
      "The Google connection attempt expired or was tampered with. Please try again.",
    google_exchange_failed:
      "Google rejected the authorization. Please try connecting again.",
    google_no_refresh_token:
      "Google didn't issue offline access. Remove the app's access in your Google Account permissions, then connect again.",
    google_no_email: "Google didn't return a verified email for the account.",
    google_already_claimed:
      "That Google account is already connected to a different workspace.",
  };
  return messages[code] ?? "Something went wrong. Please try again.";
}
