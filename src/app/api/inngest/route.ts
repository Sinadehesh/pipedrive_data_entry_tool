import { serve } from "inngest/next";

import { inngest } from "@/inngest/client";
import { drainOutbox } from "@/inngest/functions/cron/drain-outbox";
import { renewWatches } from "@/inngest/functions/cron/renew-watches";
import {
  stalenessCheck,
  stalenessDispatch,
} from "@/inngest/functions/cron/staleness-sweep";
import { extractCall } from "@/inngest/functions/extract/extract-call";
import { extractEmailThreadFn } from "@/inngest/functions/extract/extract-email-thread";
import { extractMeetingFn } from "@/inngest/functions/extract/extract-meeting";
import { extractZoomCall } from "@/inngest/functions/extract/extract-zoom-call";
import { replayExtraction } from "@/inngest/functions/extract/replay-extraction";
import { backfillConnection } from "@/inngest/functions/ingest/backfill";
import { calendarDelta } from "@/inngest/functions/ingest/calendar-delta";
import { gmailHistory } from "@/inngest/functions/ingest/gmail-history";
import { reconcilePipedrive } from "@/inngest/functions/sync/reconcile-pipedrive";

// Generous headroom on Vercel Fluid compute — but no single step is designed
// to need more than ~60s. Durability comes from Inngest's checkpointing, not
// from this number.
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    extractCall,
    extractZoomCall,
    extractEmailThreadFn,
    extractMeetingFn,
    replayExtraction,
    gmailHistory,
    calendarDelta,
    backfillConnection,
    reconcilePipedrive,
    drainOutbox,
    renewWatches,
    stalenessDispatch,
    stalenessCheck,
  ],
});
