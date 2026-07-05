import { and, asc, eq } from "drizzle-orm";

import { extractEmailThread } from "@/lib/ai/extractor";
import { db } from "@/lib/db/client";
import { interactions } from "@/lib/db/schema";
import { inngest } from "@/inngest/client";
import { persistAndEnqueue } from "./persist";

/** Thread messages included per extraction (newest kept, oldest dropped). */
const MAX_THREAD_MESSAGES = 25;
/** Per-message body cap inside the prompt. */
const MAX_BODY_CHARS = 12_000;

/**
 * Thread-level email extraction — the piece that makes email signal
 * USEFUL rather than noisy.
 *
 * gmail-history emits `gmail/thread.changed` per thread that gained
 * messages; the DEBOUNCE below collapses a back-and-forth burst so a
 * five-reply exchange is analyzed exactly once, with full context, after
 * the dust settles — not five times with partial context. The extraction
 * attaches to the thread's LATEST ledgered message: replies re-extract the
 * thread and append a new version there, superseding the old analysis in
 * notes/fields while every prior version stays in Postgres.
 *
 * Concurrency is keyed per thread so a slow LLM call can't interleave with
 * the next debounce window for the same thread.
 */
export const extractEmailThreadFn = inngest.createFunction(
  {
    id: "extract-email-thread",
    retries: 3,
    debounce: {
      key: `event.data.tenantId + "-" + event.data.threadId`,
      period: "3m",
    },
    concurrency: {
      key: `event.data.tenantId + "-" + event.data.threadId`,
      limit: 1,
    },
  },
  { event: "gmail/thread.changed" },
  async ({ event, step }) => {
    const { tenantId, threadId } = event.data;

    // The full thread as WE ledgered it (already filtered for relevance by
    // shouldIngest at ingestion time), oldest first.
    const thread = await step.run("load-thread", () =>
      db
        .select({
          id: interactions.id,
          title: interactions.title,
          occurredAt: interactions.occurredAt,
          participants: interactions.participants,
          content: interactions.content,
        })
        .from(interactions)
        .where(
          and(
            eq(interactions.tenantId, tenantId),
            eq(interactions.source, "gmail"),
            eq(interactions.threadKey, threadId),
          ),
        )
        .orderBy(asc(interactions.occurredAt))
        .limit(MAX_THREAD_MESSAGES * 2),
    );

    if (thread.length === 0) {
      return { skipped: "no ledgered messages for thread" };
    }

    // Keep the newest window when a thread outgrows the cap — current
    // deal state lives at the end of long threads.
    const window = thread.slice(-MAX_THREAD_MESSAGES);
    const latest = window[window.length - 1];

    const merged = await step.run("extract-thread", () =>
      extractEmailThread(
        window.map((m) => ({
          // First participant of a gmail interaction is the From address
          // (gmail.ts builds participants as from + to + cc).
          from: m.participants[0]
            ? (m.participants[0].name
                ? `${m.participants[0].name} <${m.participants[0].email}>`
                : m.participants[0].email)
            : "(unknown)",
          date: new Date(m.occurredAt).toISOString().slice(0, 16),
          subject: m.title,
          body: m.content.slice(0, MAX_BODY_CHARS),
        })),
      ),
    );

    const extraction = await step.run("persist-and-enqueue", () =>
      persistAndEnqueue({
        tenantId,
        interactionId: latest.id,
        payload: merged,
        occurredAt: new Date(latest.occurredAt),
      }),
    );

    await step.sendEvent("enqueue-sync", {
      name: "sync/extraction.ready",
      data: { tenantId, interactionId: latest.id, extractionId: extraction.id },
    });

    return {
      extractionId: extraction.id,
      status: extraction.status,
      messagesAnalyzed: window.length,
    };
  },
);
