import { desc, eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { competitiveIntel, interactions } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * Competitive intelligence: what the analytics side of the split is for.
 * These rows never touch the tenant's CRM — they aggregate what prospects
 * said about competitors across every call/email/meeting.
 */
export default async function IntelPage() {
  const session = await auth();
  if (!session?.tenantId) redirect("/api/auth/signin");
  const tenantId = session.tenantId;

  const [byCompetitor, recent] = await Promise.all([
    db
      .select({
        competitor: competitiveIntel.competitor,
        rawName: sql<string>`min(${competitiveIntel.rawName})`,
        mentions: sql<number>`count(*)::int`,
        favored: sql<number>`count(*) filter (where ${competitiveIntel.sentiment} = 'favored')::int`,
        neutral: sql<number>`count(*) filter (where ${competitiveIntel.sentiment} = 'neutral')::int`,
        losing: sql<number>`count(*) filter (where ${competitiveIntel.sentiment} = 'losing')::int`,
        lastMention: sql<string>`max(${competitiveIntel.occurredAt})::text`,
      })
      .from(competitiveIntel)
      .where(eq(competitiveIntel.tenantId, tenantId))
      .groupBy(competitiveIntel.competitor)
      .orderBy(sql`count(*) desc`)
      .limit(25),
    db
      .select({
        rawName: competitiveIntel.rawName,
        context: competitiveIntel.context,
        sentiment: competitiveIntel.sentiment,
        occurredAt: competitiveIntel.occurredAt,
        title: interactions.title,
        kind: interactions.kind,
      })
      .from(competitiveIntel)
      .innerJoin(
        interactions,
        eq(interactions.id, competitiveIntel.interactionId),
      )
      .where(eq(competitiveIntel.tenantId, tenantId))
      .orderBy(desc(competitiveIntel.occurredAt))
      .limit(15),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Competitive intel
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Every competitor your prospects mentioned, with whose side they
          seemed to be on. &ldquo;Losing&rdquo; means losing to you.
        </p>
      </div>

      {byCompetitor.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          No competitor mentions yet — they&apos;ll appear here as calls and
          emails are analyzed.
        </div>
      ) : (
        <>
          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Competitor</th>
                  <th className="px-4 py-3 font-medium">Mentions</th>
                  <th className="px-4 py-3 font-medium">Sentiment</th>
                  <th className="px-4 py-3 font-medium">Last mention</th>
                </tr>
              </thead>
              <tbody>
                {byCompetitor.map((c) => (
                  <tr
                    key={c.competitor}
                    className="border-b border-slate-100 last:border-0"
                  >
                    <td className="px-4 py-3 font-medium">{c.rawName}</td>
                    <td className="px-4 py-3">{c.mentions}</td>
                    <td className="px-4 py-3">
                      <SentimentBar
                        favored={c.favored}
                        neutral={c.neutral}
                        losing={c.losing}
                      />
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {c.lastMention?.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
              Recent mentions
            </h2>
            <div className="space-y-2">
              {recent.map((m, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{m.rawName}</span>
                    <span className="flex items-center gap-3">
                      <SentimentPill sentiment={m.sentiment} />
                      <span className="text-xs text-slate-400">
                        {m.occurredAt.toISOString().slice(0, 10)}
                      </span>
                    </span>
                  </div>
                  <p className="mt-1 text-slate-600">{m.context}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    from {m.kind}: {m.title ?? "(untitled)"}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function SentimentBar({
  favored,
  neutral,
  losing,
}: {
  favored: number;
  neutral: number;
  losing: number;
}) {
  const total = favored + neutral + losing || 1;
  const pct = (n: number) => `${Math.max((n / total) * 100, n > 0 ? 4 : 0)}%`;
  return (
    <div className="flex items-center gap-2">
      <div
        className="flex h-2.5 w-36 overflow-hidden rounded-full bg-slate-100"
        title={`They're favored: ${favored} · neutral: ${neutral} · losing to us: ${losing}`}
      >
        <div className="bg-red-400" style={{ width: pct(favored) }} />
        <div className="bg-slate-300" style={{ width: pct(neutral) }} />
        <div className="bg-emerald-400" style={{ width: pct(losing) }} />
      </div>
      <span className="text-xs text-slate-400">
        {losing}W&nbsp;/&nbsp;{favored}L
      </span>
    </div>
  );
}

function SentimentPill({
  sentiment,
}: {
  sentiment: "favored" | "neutral" | "losing";
}) {
  const styles = {
    favored: "bg-red-50 text-red-700", // they're favored = bad for us
    neutral: "bg-slate-100 text-slate-600",
    losing: "bg-emerald-50 text-emerald-700", // they're losing = good for us
  } as const;
  const labels = {
    favored: "they're favored",
    neutral: "neutral",
    losing: "we're winning",
  } as const;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[sentiment]}`}
    >
      {labels[sentiment]}
    </span>
  );
}
