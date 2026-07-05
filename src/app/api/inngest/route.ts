import { serve } from "inngest/next";

import { inngest } from "@/inngest/client";
import { drainOutbox } from "@/inngest/functions/cron/drain-outbox";
import { renewWatches } from "@/inngest/functions/cron/renew-watches";
import {
  stalenessCheck,
  stalenessDispatch,
} from "@/inngest/functions/cron/staleness-sweep";
import { extractCall } from "@/inngest/functions/extract/extract-call";
import { replayExtraction } from "@/inngest/functions/extract/replay-extraction";
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
    replayExtraction,
    gmailHistory,
    calendarDelta,
    reconcilePipedrive,
    drainOutbox,
    renewWatches,
    stalenessDispatch,
    stalenessCheck,
  ],
});
