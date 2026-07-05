import { and, eq } from "drizzle-orm";

import { extractMeeting } from "@/lib/ai/extractor";
import { db } from "@/lib/db/client";
import { interactions } from "@/lib/db/schema";
import { inngest } from "@/inngest/client";
import { persistAndEnqueue } from "./persist";

/**
 * Descriptions shorter than this carry nothing an LLM can extract beyond
 * what the title/attendees already say — skip the spend. The meeting is
 * still in the ledger and still counts as deal activity for the staleness
 * sweep; skipping extraction loses nothing.
 */
const MIN_DESCRIPTION_CHARS = 40;

/**
 * Meeting enrichment: BANT/competitor signals from the calendar record —
 * title, agenda/description, and the attendee list (which is real
 * AUTHORITY evidence: a CFO invited to a pricing review is a data point no
 * transcript gives you). The meeting prompt is calibrated for a thin
 * source, so mostly-null extractions are the expected output and only
 * explicit statements clear the 0.8 auto-write bar.
 */
export const extractMeetingFn = inngest.createFunction(
  {
    id: "extract-meeting",
    retries: 3,
    concurrency: { key: "event.data.tenantId", limit: 5 },
  },
  { event: "gcal/meeting.ingested" },
  async ({ event, step }) => {
    const { tenantId, interactionId } = event.data;

    const meeting = await step.run("load-meeting", async () => {
      const [row] = await db
        .select({
          id: interactions.id,
          title: interactions.title,
          content: interactions.content,
          occurredAt: interactions.occurredAt,
          participants: interactions.participants,
        })
        .from(interactions)
        .where(
          and(
            eq(interactions.tenantId, tenantId),
            eq(interactions.id, interactionId),
            eq(interactions.kind, "meeting"),
          ),
        )
        .limit(1);
      return row ?? null;
    });

    if (!meeting) {
      return { skipped: "meeting not found for tenant" };
    }
    if (meeting.content.trim().length < MIN_DESCRIPTION_CHARS) {
      return { skipped: "description too thin to extract from" };
    }

    const extracted = await step.run("extract-meeting", () =>
      extractMeeting({
        title: meeting.title,
        description: meeting.content.slice(0, 20_000),
        startAt: new Date(meeting.occurredAt).toISOString(),
        attendees: meeting.participants,
      }),
    );

    const extraction = await step.run("persist-and-enqueue", () =>
      persistAndEnqueue({
        tenantId,
        interactionId: meeting.id,
        payload: extracted,
        occurredAt: new Date(meeting.occurredAt),
      }),
    );

    await step.sendEvent("enqueue-sync", {
      name: "sync/extraction.ready",
      data: { tenantId, interactionId: meeting.id, extractionId: extraction.id },
    });

    return { extractionId: extraction.id, status: extraction.status };
  },
);
