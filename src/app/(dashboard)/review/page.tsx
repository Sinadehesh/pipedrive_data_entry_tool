import { and, desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import type { CallExtraction, Signal } from "@/lib/ai/schemas";
import { withTenant } from "@/lib/db/client";
import { extractions, interactions } from "@/lib/db/schema";
import {
  approveExtraction,
  rejectExtraction,
  replayInteraction,
} from "./actions";

export const dynamic = "force-dynamic";

/**
 * The human-in-the-loop half of confidence gating: extractions below the
 * auto-write floor wait here. Reviewers see each signal WITH its verbatim
 * evidence quote — the whole reason the prompt demands verbatim quotes is
 * that this review takes seconds instead of a transcript re-read.
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    approved?: string;
    rejected?: string;
    replayed?: string;
    error?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const params = await searchParams;

  // withTenant: RLS pins this transaction to the session's tenant.
  const queue = await withTenant(session.tenantId, (tx) =>
    tx
      .select({
        id: extractions.id,
        interactionId: extractions.interactionId,
        version: extractions.version,
        payload: extractions.payload,
        overallConfidence: extractions.overallConfidence,
        createdAt: extractions.createdAt,
        title: interactions.title,
        kind: interactions.kind,
        occurredAt: interactions.occurredAt,
      })
      .from(extractions)
      .innerJoin(interactions, eq(interactions.id, extractions.interactionId))
      .where(
        and(
          eq(extractions.tenantId, session.tenantId),
          eq(extractions.status, "needs_review"),
        ),
      )
      .orderBy(desc(extractions.createdAt))
      .limit(50),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Review queue</h1>
        <p className="mt-1 text-sm text-slate-500">
          Low-confidence extractions wait here instead of writing to
          Pipedrive. Approve as-is, correct a value (your edit becomes a new
          version at full confidence), or reject.
        </p>
      </div>

      {params.approved && <Banner tone="success">Approved — syncing to Pipedrive.</Banner>}
      {params.rejected && <Banner tone="success">Rejected. Nothing was written to Pipedrive.</Banner>}
      {params.replayed && <Banner tone="success">Replay queued — a new extraction version will appear shortly.</Banner>}
      {params.error && <Banner tone="error">That item is no longer reviewable (already handled?).</Banner>}

      {queue.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          Queue is clear — every recent extraction met the confidence bar.
        </div>
      ) : (
        <div className="space-y-4">
          {queue.map((item) =>
            item.payload ? (
              <ReviewCard
                key={item.id}
                id={item.id}
                interactionId={item.interactionId}
                title={item.title}
                kind={item.kind}
                occurredAt={item.occurredAt}
                confidence={item.overallConfidence ?? 0}
                payload={item.payload}
              />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReviewCard(props: {
  id: string;
  interactionId: string;
  title: string | null;
  kind: "call" | "email" | "meeting";
  occurredAt: Date;
  confidence: number;
  payload: CallExtraction;
}) {
  const { payload } = props;
  const kindIcon = { call: "📞", email: "✉️", meeting: "📅" }[props.kind];

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <div>
          <span className="font-medium">
            {kindIcon} {props.title ?? "(untitled)"}
          </span>
          <span className="ml-3 text-xs text-slate-400">
            {props.occurredAt.toISOString().slice(0, 10)}
          </span>
        </div>
        <ConfidenceBadge value={props.confidence} />
      </div>

      <p className="border-b border-slate-100 px-5 py-3 text-sm text-slate-600">
        {payload.summary}
      </p>

      <form action={approveExtraction}>
        <input type="hidden" name="extractionId" value={props.id} />
        <div className="divide-y divide-slate-100">
          <SignalRow label="Budget" name="budget" signal={payload.bant.budget} />
          <SignalRow label="Authority" name="authority" signal={payload.bant.authority} />
          <SignalRow label="Need" name="need" signal={payload.bant.need} />
          <SignalRow label="Timeline" name="timeline" signal={payload.bant.timeline} />
        </div>

        {payload.objections.length > 0 && (
          <div className="border-t border-slate-100 px-5 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Objections
            </div>
            <ul className="mt-2 space-y-1 text-sm">
              {payload.objections.map((o, i) => (
                <li key={i} className="text-slate-600">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
                    {o.category}
                    {o.resolved ? " · resolved" : " · open"}
                  </span>{" "}
                  <Quote text={o.quote} />
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="submit"
            formAction={replayInteraction}
            name="interactionId"
            value={props.interactionId}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
            title="Re-run the LLM over the stored transcript (appends a new version)"
          >
            ↻ Replay
          </button>
          <button
            type="submit"
            formAction={rejectExtraction}
            className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
          >
            Reject
          </button>
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Approve &amp; sync
          </button>
        </div>
      </form>
    </div>
  );
}

function SignalRow({
  label,
  name,
  signal,
}: {
  label: string;
  name: string;
  signal: Signal;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 px-5 py-3 sm:grid-cols-[7rem_1fr_1fr]">
      <div className="pt-1.5">
        <span className="text-sm font-medium">{label}</span>
        <div className="mt-0.5">
          <ConfidenceBadge value={signal.confidence} />
        </div>
      </div>
      <div>
        <input
          type="text"
          name={`edit:${name}`}
          defaultValue={signal.value ?? ""}
          placeholder="not discussed"
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <p className="mt-1 text-xs text-slate-400">
          Edit before approving — your value overrides the model&apos;s.
        </p>
      </div>
      <div className="text-sm">
        {signal.evidence ? (
          <Quote text={signal.evidence} />
        ) : (
          <span className="text-xs italic text-slate-400">
            no supporting quote
          </span>
        )}
      </div>
    </div>
  );
}

function Quote({ text }: { text: string }) {
  return (
    <blockquote className="border-l-2 border-amber-300 bg-amber-50/50 px-2 py-1 text-sm italic text-slate-700">
      &ldquo;{text}&rdquo;
    </blockquote>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone =
    value >= 0.8
      ? "bg-emerald-50 text-emerald-700"
      : value >= 0.5
        ? "bg-amber-50 text-amber-700"
        : "bg-red-50 text-red-700";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {pct}%
    </span>
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
